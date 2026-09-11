// agents/src/sweep.ts
// Anyone may call these. The demo runs it from the arbiter wallet for convenience.
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { POLL_MS } from "./config.ts";
import { logger } from "./log.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = logger("sweep");
const { publicClient, market } = clients("arbiter");

async function once() {
  // The contract judges windows by block.timestamp, so read the chain clock, not the wall clock.
  const now = (await publicClient.getBlock()).timestamp;
  const [rw, aw, dw] = await Promise.all([market.read.revealWindow(), market.read.adjudicationWindow(), market.read.disclosureWindow()]) as bigint[];
  const n = Number(await market.read.saleCount());
  for (let i = 0; i < n; i++) {
    const s = await market.read.getSale([BigInt(i)]) as any;
    try {
      if (s.state === S.Revealed && now > BigInt(s.revealedAt) + aw) {
        const rc = await send(publicClient, market.write.settle([BigInt(i)]));
        log("settled: buyer silent past the window, seller paid, recorded unadjudicated", { saleId: i, tx: txLink(rc.transactionHash) });
      } else if (s.state === S.Committed && now > BigInt(s.committedAt) + rw) {
        const rc = await send(publicClient, market.write.expireCommit([BigInt(i)]));
        log("expired: commit never revealed, bond to buyer", { saleId: i, tx: txLink(rc.transactionHash) });
      } else if (s.state === S.Disputed && (s.plaintext as string) === "0x" && now > BigInt(s.disputedAt) + dw) {
        const rc = await send(publicClient, market.write.withdrawSale([BigInt(i)]));
        log("withdrawn: seller never disclosed, bond to buyer", { saleId: i, tx: txLink(rc.transactionHash) });
      }
    } catch (e) { log("sweep call failed", { saleId: i, error: String(e).slice(0, 200) }); }
  }
}

const seconds = Number(opt("seconds", "0"));
const until = Date.now() + seconds * 1000;
do { await once(); if (seconds) await sleep(POLL_MS); } while (Date.now() < until);
