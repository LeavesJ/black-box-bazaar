// agents/src/seller.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { REASON_NAMES, S, STATE_NAMES, clients, committedSaleIdFromReceipt, isTerminal, send, sleep, txLink } from "./chain.ts";
import { BUYER_RUNS, BUYER_THRESHOLD, CHAIN, HI, LO, MARKET_ADDRESS, POLL_MS, ROLES, claimIsSupported, type Role } from "./config.ts";
import { canonicalPair, commitHash, envelope, randomBytesHex, randomSalt, seal, stringToBytes } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const usage = () => {
  console.error("usage: seller.ts hunt --claim N [--max K] [--role seller|rogue|newcomer] [--attack plant|garbage] [--rogue] [--budget B] [--seconds S]");
  process.exit(2);
};

type Attack = "none" | "plant" | "garbage";
const ATTACKS: readonly Attack[] = ["none", "plant", "garbage"];
// --rogue stays accepted as an alias of --attack plant. An attack defaults to the rogue wallet so
// the honest seller's record is never dirtied by accident.
const attack = opt("attack", flag("rogue") ? "plant" : "none") as Attack;
const role = opt("role", attack === "none" ? "seller" : "rogue") as Role;
if (args[0] !== "hunt" || !ATTACKS.includes(attack) || !ROLES.includes(role)) usage();

const log = logger(role);
const { publicClient, market } = clients(role);
const rnd = () => LO + Math.floor(Math.random() * (HI - LO + 1));

// ---- private per-sale material, persisted before reveal so a restarted seller can still reveal
// and disclose. One file per role under agents/.state (gitignored), keyed by deployment.
type Material = { claimId: string; plaintext: Hex; salt: Hex; ephemeralSecret: Hex; ciphertext: Hex; attack: Attack };
const here = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(here, "..", ".state");
const STATE_FILE = join(STATE_DIR, `${role}.json`);
const NS = `${CHAIN.id}:${MARKET_ADDRESS.toLowerCase()}`;

function loadAll(): Record<string, Record<string, Material>> {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
const mine: Record<string, Material> = loadAll()[NS] ?? {};
function persist() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const all = loadAll();
  all[NS] = mine;
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

// ---- hunting
const budget = Number(opt("budget", "40"));
let probesLeft = budget;

async function findPair(): Promise<{ a: number; b: number } | null> {
  for (let tries = 1; probesLeft > 0; tries++) {
    probesLeft--;
    const a = rnd(), b = rnd();
    const r = await modelIsWrong(a, b, BUYER_RUNS, BUYER_THRESHOLD);
    log("probe", { a, b, wrong: r.wrong, malformed: r.malformed, runs: r.runs, truth: r.truth, answers: r.answers, tries, probesLeft });
    if (attack === "plant") {
      if (r.wrong === 0 && r.malformed === 0) { log("attack plant: planting a pair the model gets right", { a, b }); return { a, b }; }
      continue;
    }
    if (r.verdict) { log("counterexample found", { a, b, tries }); return { a, b }; }
  }
  log("probe budget exhausted, no more sales this hunt", { budget });
  return null;
}

async function commitOne(claimId: bigint, buyerPubKey: Hex, a: number, b: number) {
  const plaintext = bytesToHex(stringToBytes(canonicalPair(a, b)));
  const salt = randomSalt();
  const hash = commitHash(claimId, plaintext, salt);
  const sealed = seal(envelope(hexToBytes(plaintext), salt), hexToBytes(buyerPubKey));
  // The reviewer's attack: a real commitment, then random bytes of a real ciphertext's length.
  const ciphertext = attack === "garbage" ? randomBytesHex(hexToBytes(sealed.ciphertext).length) : sealed.ciphertext;
  const bond = await market.read.bondFor([claimId]) as bigint;
  const rc = await send(publicClient, market.write.commit([claimId, hash], { value: bond }));
  const saleId = committedSaleIdFromReceipt(rc);
  mine[saleId.toString()] = { claimId: claimId.toString(), plaintext, salt, ephemeralSecret: sealed.ephemeralSecret, ciphertext, attack };
  persist();
  log("committed", { saleId, claimId, hash, bond, tx: txLink(rc.transactionHash) });
  return saleId;
}

// ---- one pass over every sale this wallet holds material for: reveal what is committed, disclose
// what is disputed, and report how many are still open.
const settled = new Set<string>();
const states: Record<string, string> = {};
let revealWindow = 0n;
async function tick(startup = false): Promise<number> {
  const now = (await publicClient.getBlock()).timestamp;
  let open = 0;
  for (const [id, m] of Object.entries(mine)) {
    if (settled.has(id)) continue;
    const saleId = BigInt(id);
    const s = await market.read.getSale([saleId]) as any;
    states[id] = STATE_NAMES[s.state as number] ?? String(s.state);
    if (isTerminal(s.state)) {
      settled.add(id);
      if (!startup) log("sale reached a terminal state", { saleId, state: states[id] });
      continue;
    }
    open++;
    if (s.state === S.Committed) {
      if (now > BigInt(s.committedAt) + revealWindow) continue; // the sweep will expire it
      const rr = await send(publicClient, market.write.reveal([saleId, m.ciphertext]));
      log(m.attack === "garbage" ? "attack garbage: revealed random bytes instead of the sealed envelope" : "revealed",
        { saleId, bytes: hexToBytes(m.ciphertext).length, tx: txLink(rr.transactionHash) });
    } else if (s.state === S.Disputed && (s.plaintext as string) === "0x") {
      const rc = await send(publicClient, market.write.disclose([saleId, m.plaintext, m.salt, m.ephemeralSecret]));
      log("disputed by buyer, disclosed plaintext, salt and ephemeral secret on-chain",
        { saleId, reason: REASON_NAMES[s.disputeReason as number] ?? s.disputeReason, tx: txLink(rc.transactionHash) });
    }
  }
  return open;
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

async function hunt() {
  const claimId = BigInt(opt("claim", "0"));
  const max = Number(opt("max", "1"));
  const seconds = Number(opt("seconds", "900"));
  const until = Date.now() + seconds * 1000;
  log("hunting", { claimId, max, attack, budget, seconds, loaded: Object.keys(mine).length });
  revealWindow = await market.read.revealWindow() as bigint;
  // Startup pass: classify what an earlier run left behind, and reveal or disclose anything still owed.
  try { const open = await tick(true); if (Object.keys(mine).length) log("loaded earlier sales", { open, states }); }
  catch (e) { log("startup pass failed, continuing", { error: errText(e) }); }
  const claim = await market.read.getClaim([claimId]) as any;
  let sold = 0;
  if (!claimIsSupported(claim)) {
    log("unsupported claim, skipping", { claimId, modelId: claim.modelId });
  } else {
    while (sold < max && Date.now() < until) {
      try {
        const c = await market.read.getClaim([claimId]) as any;
        if (c.closed || c.hits + c.pending >= c.maxHits) { log("claim has no open slot", { claimId }); break; }
        const pair = await findPair();
        if (!pair) break;
        await commitOne(claimId, claim.buyerPubKey, pair.a, pair.b);
        sold++;
        await tick(); // reveals what was just committed; persisted material makes a retry safe
      } catch (e) {
        log("sell loop failed, retrying", { error: errText(e) });
        await sleep(POLL_MS);
      }
    }
  }
  log("waiting until every sale this wallet made is terminal", { sold, until: new Date(until).toISOString() });
  let open = -1;
  while (Date.now() < until) {
    try {
      open = await tick();
      if (open === 0) break;
    } catch (e) { log("poll failed, retrying", { error: errText(e) }); }
    await sleep(POLL_MS);
  }
  log("done", { sold, open: open < 0 ? "unknown" : open, timedOut: open !== 0, states });
}

await hunt();
