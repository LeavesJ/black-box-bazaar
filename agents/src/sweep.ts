// agents/src/sweep.ts
// Anyone may call these. The demo runs it from the deployer wallet (anvil account 0, DEPLOYER_KEY on
// a testnet) so the arbiter's rulings and the sweep's settlements never contend for one nonce.
import { clients, isTerminal, readWindows, send, sleep, sweepAction, txLink, type SweepAction, type Windows } from "./chain.ts";
import { POLL_MS } from "./config.ts";
import { logger } from "./log.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = logger("sweep");
const { account, publicClient, market } = clients("deployer");
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

const SAYS: Record<SweepAction, string> = {
  settle: "settled: buyer silent past the window, seller paid, recorded unadjudicated",
  expireCommit: "expired: commit never revealed, bond to buyer",
  withdrawSale: "withdrawn: seller never disclosed, bond to buyer",
  resolveUnarbitrated: "unarbitrated: arbiter never ruled, each party's own bond returned, bounty back to the claim, seller neither credited nor refuted",
};

// A sale seen in a terminal state is never read again; only open sales are re-read each pass.
const done = new Set<number>();
let windows: Windows | null = null;

async function once() {
  // The contract judges windows by block.timestamp, so read the chain clock, not the wall clock.
  const now = (await publicClient.getBlock()).timestamp;
  windows ??= await readWindows(market);
  const n = Number(await market.read.saleCount());
  for (let i = 0; i < n; i++) {
    if (done.has(i)) continue;
    try {
      const s = await market.read.getSale([BigInt(i)]) as any;
      if (isTerminal(s.state)) { done.add(i); continue; }
      const action = sweepAction(s, now, windows);
      if (!action) continue;
      const rc = await send(publicClient, market.write[action]([BigInt(i)]));
      log(SAYS[action], { saleId: i, tx: txLink(rc.transactionHash) });
    } catch (e) { log("sweep call failed", { saleId: i, error: errText(e) }); }
  }
}

const seconds = Number(opt("seconds", "0"));
const until = Date.now() + seconds * 1000;
log("sweeping", { from: account.address, seconds });
do {
  try { await once(); } catch (e) { log("sweep pass failed, retrying", { error: errText(e) }); }
  if (seconds) await sleep(POLL_MS);
} while (Date.now() < until);
