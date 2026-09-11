// agents/src/seller.ts
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { BUYER_RUNS, BUYER_THRESHOLD, HI, LO, POLL_MS, type Role } from "./config.ts";
import { canonicalPair, commitHash, envelope, randomSalt, seal, stringToBytes } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

const role = opt("role", flag("rogue") ? "rogue" : "seller") as Role;
const log = logger(role);
const { publicClient, market } = clients(role);
const rogue = flag("rogue");
const rnd = () => LO + Math.floor(Math.random() * (HI - LO + 1));

// plaintext and salt per sale, so a dispute can be answered
const memory = new Map<string, { plaintext: Hex; salt: Hex }>();

async function findPair() {
  for (let tries = 1; ; tries++) {
    const a = rnd(), b = rnd();
    const r = await modelIsWrong(a, b, BUYER_RUNS, BUYER_THRESHOLD);
    log("probe", { a, b, wrong: r.wrong, runs: r.runs, truth: r.truth, answers: r.answers, tries });
    if (rogue && r.wrong === 0) { log("rogue: planting a pair the model gets right", { a, b }); return { a, b }; }
    if (!rogue && r.verdict) { log("counterexample found", { a, b, tries }); return { a, b }; }
  }
}

async function sellOne(claimId: bigint) {
  const claim = await market.read.getClaim([claimId]) as any;
  const { a, b } = await findPair();
  const plaintext = bytesToHex(stringToBytes(canonicalPair(a, b)));
  const salt = randomSalt();
  const hash = commitHash(claimId, plaintext, salt);
  const bond = await market.read.bondFor([claimId]) as bigint;
  const rc = await send(publicClient, market.write.commit([claimId, hash], { value: bond }));
  const saleId = BigInt(Number(await market.read.saleCount()) - 1);
  memory.set(saleId.toString(), { plaintext, salt });
  log("committed", { saleId, claimId, hash, bond, tx: txLink(rc.transactionHash) });
  const ct = seal(envelope(hexToBytes(plaintext), salt), hexToBytes(claim.buyerPubKey));
  const rr = await send(publicClient, market.write.reveal([saleId, ct]));
  log("revealed", { saleId, bytes: hexToBytes(ct).length, tx: txLink(rr.transactionHash) });
  return saleId;
}

async function answerDisputes() {
  const n = Number(await market.read.saleCount());
  for (let i = 0; i < n; i++) {
    const m = memory.get(String(i));
    if (!m) continue;
    const s = await market.read.getSale([BigInt(i)]) as any;
    if (s.state === S.Disputed && (s.plaintext as string) === "0x") {
      const rc = await send(publicClient, market.write.disclose([BigInt(i), m.plaintext, m.salt]));
      log("disputed by buyer, disclosed plaintext on-chain", { saleId: i, tx: txLink(rc.transactionHash) });
    }
  }
}

async function hunt() {
  const claimId = BigInt(opt("claim", "0"));
  const max = Number(opt("max", "1"));
  const seconds = Number(opt("seconds", "600"));
  log("hunting", { claimId, max, rogue });
  let sold = 0;
  while (sold < max) {
    const c = await market.read.getClaim([claimId]) as any;
    if (c.closed || c.hits + c.pending >= c.maxHits) { log("claim has no open slot", { claimId }); break; }
    await sellOne(claimId);
    sold++;
  }
  const until = Date.now() + seconds * 1000;
  log("watching for disputes", { seconds });
  while (Date.now() < until) { await answerDisputes(); await sleep(POLL_MS); }
  log("done");
}

if (args[0] === "hunt") await hunt();
else { console.error("usage: seller.ts hunt --claim N [--max K] [--rogue] [--role r] [--seconds S]"); process.exit(2); }
