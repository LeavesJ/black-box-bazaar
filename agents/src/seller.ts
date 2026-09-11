// agents/src/seller.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import abi from "./abi.json" with { type: "json" };
import { REASON_NAMES, S, STATE_NAMES, clients, committedSaleIdFromReceipt, isDisclosed, isTerminal, saleIdFromCommittedLogs, send, sleep, txLink } from "./chain.ts";
import { BUYER_RUNS, BUYER_THRESHOLD, CHAIN, HI, LO, MARKET_ADDRESS, POLL_MS, ROLES, claimIsSupported, type Role } from "./config.ts";
import { canonicalPair, commitHash, envelope, randomBytesHex, randomSalt, seal, stringToBytes } from "./crypto.ts";
import { logger } from "./log.ts";
import { apiRefused, modelIsWrong } from "./model.ts";
import { pace } from "./pace.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const usage = () => {
  console.error("usage: seller.ts hunt --claim N [--max K] [--role seller|rogue|newcomer|quiet] [--attack plant|garbage] [--rogue] [--budget B] [--seconds S]");
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
const { account, publicClient, market } = clients(role);
const rnd = () => LO + Math.floor(Math.random() * (HI - LO + 1));
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

// ---- private per-sale material, keyed by commit hash and persisted BEFORE the commit is sent, so a
// crash between the send and the receipt never leaves a bond on chain with nothing to reveal. The
// receipt attaches the sale id; a lost receipt is recovered from the Committed log by the hash.
// One file per role under agents/.state (gitignored), namespaced by deployment.
type Material = {
  claimId: string; commitHash: Hex; plaintext: Hex; salt: Hex; ephemeralSecret: Hex; ciphertext: Hex; attack: Attack;
  sinceBlock?: string; // the block just before the commit was sent; bounds the log search
  sinceAt?: string;    // that block's timestamp; a commit unseen past sinceAt + revealWindow is worthless
  saleId?: string;     // attached from the receipt, or recovered from the log
};
const here = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(here, "..", ".state");
const STATE_FILE = join(STATE_DIR, `${role}.json`);
const NS = `${CHAIN.id}:${MARKET_ADDRESS.toLowerCase()}`;

function loadAll(): Record<string, Record<string, Material>> {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
/// Entries written before material was keyed by commit hash were keyed by sale id and carried no
/// hash; both are derivable, so an older file is read in place rather than migrated by hand.
function loadMine(): Record<string, Material> {
  const out: Record<string, Material> = {};
  for (const [k, m] of Object.entries(loadAll()[NS] ?? {})) {
    const hash = m.commitHash ?? commitHash(BigInt(m.claimId), m.plaintext, m.salt);
    const saleId = m.saleId ?? (/^\d+$/.test(k) ? k : undefined);
    out[hash] = { ...m, commitHash: hash, ...(saleId !== undefined ? { saleId } : {}) };
  }
  return out;
}
const mine: Record<string, Material> = loadMine();
function persist() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const all = loadAll();
  all[NS] = mine;
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

/// The sale id for a commitment whose receipt never arrived: this seller's Committed logs on this
/// claim, from the block just before the send, matched on the hash.
async function recoverSaleId(m: Material): Promise<bigint | null> {
  const logs = await publicClient.getContractEvents({
    address: MARKET_ADDRESS, abi, eventName: "Committed",
    args: { claimId: BigInt(m.claimId), seller: account.address },
    fromBlock: m.sinceBlock ? BigInt(m.sinceBlock) : 0n, toBlock: "latest",
  });
  return saleIdFromCommittedLogs(logs as any, m.commitHash);
}

// ---- hunting. The budget counts pairs the model answered: a failed call is not a try and spends none of it, so a
// flaky API never reads as a hunt that found nothing, and one that refuses outright stops the hunt (see hunt()).
const budget = Number(opt("budget", "40"));
if (!Number.isInteger(budget) || budget < 1) usage();
let probesLeft = budget;
let tries = 0; // pairs answered since the last one kept; it survives a failed call, so "after N tries" counts them all

async function findPair(): Promise<{ a: number; b: number } | null> {
  while (probesLeft > 0) {
    const a = rnd(), b = rnd();
    const r = await modelIsWrong(a, b, BUYER_RUNS, BUYER_THRESHOLD); // an API failure throws here, before anything is counted
    probesLeft--; tries++;
    log("probe", { a, b, wrong: r.wrong, malformed: r.malformed, runs: r.runs, truth: r.truth, answers: r.answers, tries, probesLeft });
    if (attack === "plant") {
      if (r.wrong === 0 && r.malformed === 0) { log("attack plant: planting a pair the model gets right", { a, b }); tries = 0; return { a, b }; }
      continue;
    }
    if (r.verdict) { log("counterexample found", { a, b, tries }); tries = 0; return { a, b }; }
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
  // Demo pacing (pace.ts), held before the bond and the block are read and the material is persisted: a presenter
  // who waits minutes still records the block just before the send, and nothing is persisted for an unsent commit.
  await pace(role, "commit", { claimId, hash: hash.slice(0, 10) }, { sleep: false });
  const bond = await market.read.bondFor([claimId]) as bigint;
  const since = await publicClient.getBlock();
  mine[hash] = {
    claimId: claimId.toString(), commitHash: hash, plaintext, salt, ephemeralSecret: sealed.ephemeralSecret, ciphertext, attack,
    sinceBlock: since.number.toString(), sinceAt: since.timestamp.toString(),
  };
  persist();
  log("material persisted, sending commit", { claimId, hash });
  const rc = await send(publicClient, market.write.commit([claimId, hash], { value: bond }));
  const saleId = committedSaleIdFromReceipt(rc);
  mine[hash]!.saleId = saleId.toString();
  persist();
  log("committed", { saleId, claimId, hash, bond, tx: txLink(rc.transactionHash) });
  return saleId;
}

// ---- one pass over every sale this wallet holds material for: attach a missing sale id, reveal
// what is committed, disclose what is disputed, and report how many are still open.
const settled = new Set<string>();
const states: Record<string, string> = {};
let revealWindow: bigint | null = null; // null: unread, so the chain judges each reveal itself
async function tick(startup = false): Promise<number> {
  const now = (await publicClient.getBlock()).timestamp;
  let open = 0;
  for (const [hash, m] of Object.entries(mine)) {
    if (settled.has(hash)) continue;
    if (!m.saleId) {
      const id = await recoverSaleId(m);
      if (id === null) {
        const expired = revealWindow !== null && m.sinceAt !== undefined && now > BigInt(m.sinceAt) + revealWindow;
        if (expired) { log("commit never landed and its reveal window has passed, dropping the material", { hash, claimId: m.claimId }); delete mine[hash]; persist(); continue; }
        if (startup) log("commit sent but no Committed log yet, will keep looking", { hash, claimId: m.claimId });
        open++;
        continue;
      }
      m.saleId = id.toString();
      persist();
      log("recovered the sale id from the Committed log", { saleId: id, hash });
    }
    const saleId = BigInt(m.saleId);
    const s = await market.read.getSale([saleId]) as any;
    states[m.saleId] = STATE_NAMES[s.state as number] ?? String(s.state);
    if (isTerminal(s.state)) {
      settled.add(hash);
      if (!startup) log("sale reached a terminal state", { saleId, state: states[m.saleId] });
      continue;
    }
    open++;
    if (s.state === S.Committed) {
      if (revealWindow !== null && now > BigInt(s.committedAt) + revealWindow) continue; // the sweep will expire it
      await pace(role, "reveal", { saleId }); // demo pacing, see pace.ts
      const rr = await send(publicClient, market.write.reveal([saleId, m.ciphertext]));
      log(m.attack === "garbage" ? "attack garbage: revealed random bytes instead of the sealed envelope" : "revealed",
        { saleId, bytes: hexToBytes(m.ciphertext).length, tx: txLink(rr.transactionHash) });
    } else if (s.state === S.Disputed && !isDisclosed(s)) {
      const reason = REASON_NAMES[s.disputeReason as number] ?? s.disputeReason;
      await pace(role, "disclose", { saleId, reason }); // demo pacing, see pace.ts
      const rc = await send(publicClient, market.write.disclose([saleId, m.plaintext, m.salt, m.ephemeralSecret]));
      log("disputed by buyer, disclosed plaintext, salt and ephemeral secret on-chain", { saleId, reason, tx: txLink(rc.transactionHash) });
    }
  }
  return open;
}

async function hunt() {
  const claimId = BigInt(opt("claim", "0"));
  const max = Number(opt("max", "1"));
  const seconds = Number(opt("seconds", "900"));
  const until = Date.now() + seconds * 1000;
  log("hunting", { claimId, max, attack, budget, seconds, loaded: Object.keys(mine).length });
  // Every startup read is guarded on its own: a bad --claim or a flaky RPC must never stop this
  // wallet from revealing or disclosing what an earlier run already owes.
  try { revealWindow = await market.read.revealWindow() as bigint; }
  catch (e) { log("could not read the reveal window, the chain will judge each reveal", { error: errText(e) }); }
  try { const open = await tick(true); if (Object.keys(mine).length) log("loaded earlier sales", { open, states }); }
  catch (e) { log("startup pass failed, continuing", { error: errText(e) }); }
  let claim: any = null;
  try { claim = await market.read.getClaim([claimId]); }
  catch (e) { log("claim could not be read, skipping the hunt", { claimId, error: errText(e) }); }
  let sold = 0;
  if (claim && !claimIsSupported(claim)) {
    log("unsupported claim, skipping", { claimId, modelId: claim.modelId });
  } else if (claim) {
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
        // A refusal (no usable key, no credit, an unknown model) would fail every call after it the same way, so the
        // hunt stops and says so. Anything else, a timeout, a 429, a 5xx or a flaky RPC, is tried again.
        if (apiRefused(e)) { log("the model API refused the call, stopping the hunt", { error: errText(e) }); break; }
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
