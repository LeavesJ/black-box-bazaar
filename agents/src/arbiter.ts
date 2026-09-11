// agents/src/arbiter.ts
import { hexToBytes } from "viem";
import { REASON_NAMES, S, clients, send, sleep, txLink } from "./chain.ts";
import { ARBITER_RUNS, ARBITER_THRESHOLD, HI, LO, POLL_MS, claimIsSupported } from "./config.ts";
import { parsePair, verifyDelivery } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const MAX_ATTEMPTS = 3;
const log = logger("arbiter");
const { publicClient, market } = clients("arbiter");
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

const claims = new Map<string, any>();
const claimFor = async (id: bigint) => {
  const k = id.toString();
  if (!claims.has(k)) claims.set(k, await market.read.getClaim([id]));
  return claims.get(k);
};

async function refute(saleId: number, event: string, fields: Record<string, unknown> = {}) {
  const rc = await send(publicClient, market.write.rule([BigInt(saleId), false]));
  log(event, { saleId, ...fields, tx: txLink(rc.transactionHash) });
}

/// Delivery first: what was posted must be the disclosed envelope sealed to the buyer's key. Only
/// a seller that provably delivered gets the model run on its behalf.
async function judge(saleId: number, s: any) {
  const claim = await claimFor(s.claimId);
  const reason = REASON_NAMES[s.disputeReason as number] ?? String(s.disputeReason);
  if (!verifyDelivery(s.ciphertext, s.plaintext, s.salt, s.ephemeralSecret, claim.buyerPubKey)) {
    return refute(saleId, "ruled: delivery mismatch, seller refuted", { reason });
  }
  log("delivery verified: the posted ciphertext is the disclosed envelope sealed to the buyer's key", { saleId, reason });
  if (!claimIsSupported(claim)) { log("unsupported claim, skipping", { saleId, claimId: s.claimId, modelId: claim.modelId }); return; }
  const pair = parsePair(hexToBytes(s.plaintext));
  if (!pair) return refute(saleId, `ruled: plaintext is not a pair of integers in ${LO}..${HI}, seller refuted`, { plaintext: s.plaintext });
  log("re-running disputed pair", { saleId, a: pair.a, b: pair.b, runs: ARBITER_RUNS });
  const r = await modelIsWrong(pair.a, pair.b, ARBITER_RUNS, ARBITER_THRESHOLD);
  const rc = await send(publicClient, market.write.rule([BigInt(saleId), r.verdict]));
  log(r.verdict ? "ruled: model is wrong, seller upheld" : "ruled: model is right, seller refuted",
    { saleId, wrong: r.wrong, malformed: r.malformed, runs: r.runs, truth: r.truth, answers: r.answers, tx: txLink(rc.transactionHash) });
}

async function watch() {
  const seconds = Number(opt("seconds", "600"));
  const until = Date.now() + seconds * 1000;
  const done = new Set<number>();
  const failures = new Map<number, number>();
  log("watching for disclosed disputes", { seconds });
  while (Date.now() < until) {
    try {
      const n = Number(await market.read.saleCount());
      for (let i = 0; i < n; i++) {
        if (done.has(i) || (failures.get(i) ?? 0) >= MAX_ATTEMPTS) continue;
        const s = await market.read.getSale([BigInt(i)]) as any;
        if (s.state !== S.Disputed || (s.plaintext as string) === "0x") continue;
        try {
          await judge(i, s);
          done.add(i);
        } catch (e) {
          const attempt = (failures.get(i) ?? 0) + 1;
          failures.set(i, attempt);
          log(attempt >= MAX_ATTEMPTS ? "ruling failed, giving up on this sale" : "ruling failed, will retry", { saleId: i, attempt, error: errText(e) });
        }
      }
    } catch (e) { log("watch poll failed, retrying", { error: errText(e) }); }
    await sleep(POLL_MS);
  }
  log("watch ended");
}

if (args[0] === "watch") await watch();
else { console.error("usage: arbiter.ts watch [--seconds S]"); process.exit(2); }
