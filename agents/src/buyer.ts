// agents/src/buyer.ts
import { bytesToHex, decodeEventLog, parseEther, type Hex } from "viem";
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { BOUNTY_ETH, BUYER_RUNS, BUYER_THRESHOLD, CLAIM_DURATION, CLAIM_SPEC, MAX_HITS, MODEL_ID, POLL_MS, keyFor } from "./config.ts";
import { boxKeypairFromEthKey, commitHash, open, parsePair, splitEnvelope } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";
import abi from "./abi.json" with { type: "json" };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

const log = logger("buyer");
const { account, publicClient, market } = clients("buyer");
const box = boxKeypairFromEthKey(keyFor("buyer"));

async function post() {
  const bounty = parseEther(BOUNTY_ETH);
  const value = bounty * BigInt(MAX_HITS);
  log("posting claim", { model: MODEL_ID, bounty: BOUNTY_ETH, maxHits: MAX_HITS });
  const receipt = await send(publicClient, market.write.postClaim(
    [MODEL_ID, CLAIM_SPEC, bytesToHex(box.publicKey), bounty, MAX_HITS, BigInt(CLAIM_DURATION)], { value }));
  let claimId = -1n;
  for (const l of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
      if (ev.eventName === "ClaimPosted") claimId = (ev.args as any).claimId;
    } catch {}
  }
  log("claim posted", { claimId, tx: txLink(receipt.transactionHash) });
  console.log(`CLAIM_ID=${claimId}`);
}

async function adjudicate(saleId: bigint, claimId: bigint, ciphertext: Hex, commit: Hex) {
  const env = open(ciphertext, box.secretKey);
  if (!env) { log("cannot decrypt, disputing", { saleId }); return dispute(saleId, claimId); }
  const { plaintext, salt } = splitEnvelope(env);
  const pair = parsePair(plaintext);
  const ok = commitHash(claimId, bytesToHex(plaintext), salt) === commit;
  if (!pair || !ok) { log("envelope fails commit check, disputing", { saleId, pair, ok }); return dispute(saleId, claimId); }
  log("re-running", { saleId, a: pair.a, b: pair.b, runs: BUYER_RUNS });
  const r = await modelIsWrong(pair.a, pair.b, BUYER_RUNS, BUYER_THRESHOLD);
  log("re-run result", { saleId, wrong: r.wrong, runs: r.runs, truth: r.truth, answers: r.answers });
  if (r.verdict) {
    const receipt = await send(publicClient, market.write.confirm([saleId]));
    log("confirmed", { saleId, tx: txLink(receipt.transactionHash) });
  } else {
    await dispute(saleId, claimId);
  }
}

async function dispute(saleId: bigint, claimId: bigint) {
  const bond = await market.read.bondFor([claimId]) as bigint;
  const receipt = await send(publicClient, market.write.dispute([saleId], { value: bond }));
  log("disputed", { saleId, bond, tx: txLink(receipt.transactionHash) });
}

async function watch() {
  const silent = flag("silent");
  const only = opt("claim", "");
  const seconds = Number(opt("seconds", "600"));
  const seen = new Set<string>();
  const until = Date.now() + seconds * 1000;
  log("watching", { silent, only: only || "all", seconds });
  while (Date.now() < until) {
    const n = Number(await market.read.saleCount());
    for (let i = 0; i < n; i++) {
      const s = await market.read.getSale([BigInt(i)]) as any;
      const c = await market.read.getClaim([s.claimId]) as any;
      if (c.buyer.toLowerCase() !== account.address.toLowerCase()) continue;
      if (only && s.claimId.toString() !== only) continue;
      if (s.state !== S.Revealed || seen.has(String(i))) continue;
      seen.add(String(i));
      if (silent) { log("reveal seen, staying silent on purpose", { saleId: i }); continue; }
      await adjudicate(BigInt(i), s.claimId, s.ciphertext, s.commitHash);
    }
    await sleep(POLL_MS);
  }
  log("watch ended");
}

const cmd = args[0];
if (cmd === "post") await post();
else if (cmd === "watch") await watch();
else { console.error("usage: buyer.ts post | watch [--silent] [--claim N] [--seconds S]"); process.exit(2); }
