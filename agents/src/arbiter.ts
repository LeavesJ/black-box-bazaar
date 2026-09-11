// agents/src/arbiter.ts
import { hexToBytes } from "viem";
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { ARBITER_RUNS, ARBITER_THRESHOLD, POLL_MS } from "./config.ts";
import { parsePair } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = logger("arbiter");
const { publicClient, market } = clients("arbiter");

async function watch() {
  const seconds = Number(opt("seconds", "600"));
  const until = Date.now() + seconds * 1000;
  const seen = new Set<number>();
  log("watching for disclosed disputes", { seconds });
  while (Date.now() < until) {
    const n = Number(await market.read.saleCount());
    for (let i = 0; i < n; i++) {
      if (seen.has(i)) continue;
      const s = await market.read.getSale([BigInt(i)]) as any;
      if (s.state !== S.Disputed || (s.plaintext as string) === "0x") continue;
      seen.add(i);
      const pair = parsePair(hexToBytes(s.plaintext));
      if (!pair) {
        const rc = await send(publicClient, market.write.rule([BigInt(i), false]));
        log("ruled: plaintext is not a pair, seller refuted", { saleId: i, tx: txLink(rc.transactionHash) });
        continue;
      }
      log("re-running disputed pair", { saleId: i, a: pair.a, b: pair.b, runs: ARBITER_RUNS });
      const r = await modelIsWrong(pair.a, pair.b, ARBITER_RUNS, ARBITER_THRESHOLD);
      const rc = await send(publicClient, market.write.rule([BigInt(i), r.verdict]));
      log(r.verdict ? "ruled: model is wrong, seller upheld" : "ruled: model is right, seller refuted",
        { saleId: i, wrong: r.wrong, runs: r.runs, truth: r.truth, answers: r.answers, tx: txLink(rc.transactionHash) });
    }
    await sleep(POLL_MS);
  }
  log("watch ended");
}

if (args[0] === "watch") await watch();
else { console.error("usage: arbiter.ts watch [--seconds S]"); process.exit(2); }
