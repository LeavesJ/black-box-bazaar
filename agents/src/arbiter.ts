// agents/src/arbiter.ts
import { hexToBytes } from "viem";
import { REASON_NAMES, S, type Windows, clients, isDisclosed, isTerminal, isTerminalRevert, keepTrying, readWindows, send, sleep, txLink } from "./chain.ts";
import { ARBITER_RUNS, ARBITER_THRESHOLD, HI, LO, POLL_MS, claimIsSupported } from "./config.ts";
import { parsePair, verifyDelivery } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";
import { pace } from "./pace.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = logger("arbiter");
const { publicClient, market } = clients("arbiter");
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

const claims = new Map<string, any>();
const claimFor = async (id: bigint) => {
  const k = id.toString();
  if (!claims.has(k)) claims.set(k, await market.read.getClaim([id]));
  return claims.get(k);
};

// ---- the ruling on a disclosed dispute, separated from the transaction that records it. A ruling
// is computed once per sale and cached; when the send fails, the retry is the send alone, never the
// model. `null` means this arbiter declines to rule (an unsupported claim; the sweep resolves it).
type Ruling = { sellerWasRight: boolean; event: string; fields: Record<string, unknown> };

/// Order matters here. The delivery check runs first because it is spec-independent: whatever the
/// claim says, what was posted must be the disclosed envelope sealed to the buyer's key, so it
/// applies to every dispute this contract can produce and needs nothing this arbiter might not
/// understand. Only a seller that provably delivered gets any further reading; only after a
/// delivery match does the claim's support matter, and an unsupported claim is then skipped, not
/// ruled on, because this arbiter cannot evaluate its test.
async function judge(saleId: number, s: any): Promise<Ruling | null> {
  const claim = await claimFor(s.claimId);
  const reason = REASON_NAMES[s.disputeReason as number] ?? String(s.disputeReason);
  if (!verifyDelivery(s.ciphertext, s.plaintext, s.salt, s.ephemeralSecret, claim.buyerPubKey)) {
    return { sellerWasRight: false, event: "ruled: delivery mismatch, seller refuted", fields: { reason } };
  }
  log("delivery verified: the posted ciphertext is the disclosed envelope sealed to the buyer's key", { saleId, reason });
  if (!claimIsSupported(claim)) { log("unsupported claim, skipping", { saleId, claimId: s.claimId, modelId: claim.modelId }); return null; }
  const pair = parsePair(hexToBytes(s.plaintext));
  if (!pair) return { sellerWasRight: false, event: `ruled: plaintext is not a pair of integers in ${LO}..${HI}, seller refuted`, fields: { plaintext: s.plaintext } };
  log("re-running disputed pair", { saleId, a: pair.a, b: pair.b, runs: ARBITER_RUNS });
  const r = await modelIsWrong(pair.a, pair.b, ARBITER_RUNS, ARBITER_THRESHOLD);
  return {
    sellerWasRight: r.verdict,
    event: r.verdict ? "ruled: model is wrong, seller upheld" : "ruled: model is right, seller refuted",
    fields: { wrong: r.wrong, malformed: r.malformed, runs: r.runs, truth: r.truth, answers: r.answers },
  };
}

async function record(saleId: number, ruling: Ruling) {
  // The verdict and its counts are logged before the transaction, so a reader of the log (the demo's captions)
  // never waits on a receipt to say what the arbiter found.
  log("ruling", { saleId, sellerWasRight: ruling.sellerWasRight, verdict: ruling.event, ...ruling.fields });
  await pace("arbiter", "rule", { saleId, sellerWasRight: ruling.sellerWasRight, verdict: ruling.event }); // demo pacing, see pace.ts
  const rc = await send(publicClient, market.write.rule([BigInt(saleId), ruling.sellerWasRight]));
  log(ruling.event, { saleId, ...ruling.fields, tx: txLink(rc.transactionHash) });
}

async function watch() {
  const seconds = Number(opt("seconds", "600"));
  const until = Date.now() + seconds * 1000;
  // `done` holds every sale this watcher will never read again: terminal, ruled, declined, or
  // abandoned because its arbitration window closed. Only open sales are re-read each poll.
  const done = new Set<number>();
  const rulings = new Map<number, Ruling | null>();
  let windows: Windows | null = null;
  log("watching for disclosed disputes", { seconds });
  while (Date.now() < until) {
    try {
      windows ??= await readWindows(market);
      const now = (await publicClient.getBlock()).timestamp; // the chain clock, which the sweep judges by
      const n = Number(await market.read.saleCount());
      for (let i = 0; i < n; i++) {
        if (done.has(i)) continue;
        const s = await market.read.getSale([BigInt(i)]) as any;
        if (isTerminal(s.state)) { done.add(i); continue; }
        if (s.state !== S.Disputed || !isDisclosed(s)) continue;
        if (!keepTrying(s, now, windows)) {
          log("arbitration window closed on the chain clock, leaving the sale to the sweep", { saleId: i, disclosedAt: s.disclosedAt, now });
          done.add(i); continue;
        }
        try {
          if (!rulings.has(i)) rulings.set(i, await judge(i, s));
          const ruling = rulings.get(i)!;
          if (ruling) await record(i, ruling);
          done.add(i);
        } catch (e) {
          if (isTerminalRevert(e)) { log("chain refused the ruling, nothing left to do for this sale", { saleId: i, error: errText(e) }); done.add(i); }
          else log("ruling failed, will retry until the window closes", { saleId: i, cachedVerdict: rulings.has(i), error: errText(e) });
        }
      }
    } catch (e) { log("watch poll failed, retrying", { error: errText(e) }); }
    await sleep(POLL_MS);
  }
  log("watch ended");
}

if (args[0] === "watch") await watch();
else { console.error("usage: arbiter.ts watch [--seconds S]"); process.exit(2); }
