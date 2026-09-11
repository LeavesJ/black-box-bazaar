// agents/src/sweep.ts
// Anyone may call these. The demo runs it from the arbiter wallet for convenience.
import { clients, send, sleep, sweepAction, txLink, type SweepAction, type Windows } from "./chain.ts";
import { POLL_MS } from "./config.ts";
import { logger } from "./log.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = logger("sweep");
const { publicClient, market } = clients("arbiter");
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

const SAYS: Record<SweepAction, string> = {
  settle: "settled: buyer silent past the window, seller paid, recorded unadjudicated",
  expireCommit: "expired: commit never revealed, bond to buyer",
  withdrawSale: "withdrawn: seller never disclosed, bond to buyer",
  resolveUnarbitrated: "unarbitrated: arbiter never ruled, each party's own bond returned, bounty back to the claim, seller neither credited nor refuted",
};

async function once() {
  // The contract judges windows by block.timestamp, so read the chain clock, not the wall clock.
  const now = (await publicClient.getBlock()).timestamp;
  const [reveal, adjudication, disclosure, arbitration] = await Promise.all([
    market.read.revealWindow(), market.read.adjudicationWindow(), market.read.disclosureWindow(), market.read.arbitrationWindow(),
  ]) as bigint[];
  const windows: Windows = { reveal: reveal!, adjudication: adjudication!, disclosure: disclosure!, arbitration: arbitration! };
  const n = Number(await market.read.saleCount());
  for (let i = 0; i < n; i++) {
    try {
      const s = await market.read.getSale([BigInt(i)]) as any;
      const action = sweepAction(s, now, windows);
      if (!action) continue;
      const rc = await send(publicClient, market.write[action]([BigInt(i)]));
      log(SAYS[action], { saleId: i, tx: txLink(rc.transactionHash) });
    } catch (e) { log("sweep call failed", { saleId: i, error: errText(e) }); }
  }
}

const seconds = Number(opt("seconds", "0"));
const until = Date.now() + seconds * 1000;
do {
  try { await once(); } catch (e) { log("sweep pass failed, retrying", { error: errText(e) }); }
  if (seconds) await sleep(POLL_MS);
} while (Date.now() < until);
