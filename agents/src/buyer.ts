// agents/src/buyer.ts
import { bytesToHex, parseEther, type Hex } from "viem";
import { REASON, REASON_NAMES, S, clients, eventFromReceipt, send, sleep, txLink } from "./chain.ts";
import { BOUNTY_ETH, BUYER_RUNS, BUYER_THRESHOLD, CLAIM_DURATION, HI, LO, MAX_HITS, POLL_MS, SUPPORTED_SPEC, claimIsSupported, keyFor } from "./config.ts";
import { boxKeypairFromEthKey, commitHash, open, parsePair, splitEnvelope } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const MAX_ATTEMPTS = 3;

const log = logger("buyer");
const { account, publicClient, market } = clients("buyer");
const box = boxKeypairFromEthKey(keyFor("buyer"));
const errText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

async function post() {
  const bounty = parseEther(BOUNTY_ETH);
  const value = bounty * BigInt(MAX_HITS);
  log("posting claim", { model: SUPPORTED_SPEC.modelId, bounty: BOUNTY_ETH, maxHits: MAX_HITS });
  const receipt = await send(publicClient, market.write.postClaim(
    [SUPPORTED_SPEC.modelId, SUPPORTED_SPEC.spec, bytesToHex(box.publicKey), bounty, MAX_HITS, BigInt(CLAIM_DURATION)], { value }));
  const ev = eventFromReceipt<{ claimId: bigint }>(receipt, "ClaimPosted");
  if (!ev) throw new Error(`no ClaimPosted event in receipt ${receipt.transactionHash}`);
  log("claim posted", { claimId: ev.claimId, tx: txLink(receipt.transactionHash) });
  console.log(`CLAIM_ID=${ev.claimId}`);
}

async function adjudicate(saleId: bigint, claimId: bigint, ciphertext: Hex, commit: Hex) {
  const env = open(ciphertext, box.secretKey);
  if (!env) { log("cannot decrypt the reveal, disputing", { saleId }); return dispute(saleId, claimId, REASON.CannotDecrypt); }
  const { plaintext, salt } = splitEnvelope(env);
  if (commitHash(claimId, bytesToHex(plaintext), salt) !== commit) {
    log("envelope fails the commit check, disputing", { saleId });
    return dispute(saleId, claimId, REASON.CommitMismatch);
  }
  const pair = parsePair(plaintext);
  if (!pair) {
    log(`plaintext is not a pair of integers in ${LO}..${HI}, disputing`, { saleId, plaintext: bytesToHex(plaintext) });
    return dispute(saleId, claimId, REASON.NotReproduced);
  }
  log("re-running", { saleId, a: pair.a, b: pair.b, runs: BUYER_RUNS });
  const r = await modelIsWrong(pair.a, pair.b, BUYER_RUNS, BUYER_THRESHOLD);
  log("re-run result", { saleId, wrong: r.wrong, malformed: r.malformed, runs: r.runs, truth: r.truth, answers: r.answers });
  if (r.verdict) {
    const receipt = await send(publicClient, market.write.confirm([saleId]));
    log("confirmed", { saleId, tx: txLink(receipt.transactionHash) });
  } else {
    await dispute(saleId, claimId, REASON.NotReproduced);
  }
}

async function dispute(saleId: bigint, claimId: bigint, reason: number) {
  const bond = await market.read.bondFor([claimId]) as bigint;
  const receipt = await send(publicClient, market.write.dispute([saleId, reason], { value: bond }));
  log("disputed", { saleId, reason, reasonName: REASON_NAMES[reason], bond, tx: txLink(receipt.transactionHash) });
}

async function watch() {
  const silent = flag("silent");
  const only = opt("claim", "");
  const seconds = Number(opt("seconds", "600"));
  const until = Date.now() + seconds * 1000;
  const done = new Set<string>();
  const failures = new Map<string, number>();
  const claims = new Map<string, any>();
  const claimFor = async (id: bigint) => {
    const k = id.toString();
    if (!claims.has(k)) claims.set(k, await market.read.getClaim([id]));
    return claims.get(k);
  };
  log("watching", { silent, only: only || "all", seconds });
  while (Date.now() < until) {
    try {
      const n = Number(await market.read.saleCount());
      for (let i = 0; i < n; i++) {
        const key = String(i);
        if (done.has(key) || (failures.get(key) ?? 0) >= MAX_ATTEMPTS) continue;
        const s = await market.read.getSale([BigInt(i)]) as any;
        if (only && s.claimId.toString() !== only) continue; // --claim N: never act outside that claim
        if (s.state !== S.Revealed) continue;
        const c = await claimFor(s.claimId);
        if (c.buyer.toLowerCase() !== account.address.toLowerCase()) continue;
        if (!claimIsSupported(c)) { log("unsupported claim, skipping", { saleId: i, claimId: s.claimId }); done.add(key); continue; }
        if (silent) { done.add(key); log("reveal seen, staying silent on purpose", { saleId: i }); continue; }
        try {
          await adjudicate(BigInt(i), s.claimId, s.ciphertext, s.commitHash);
          done.add(key);
        } catch (e) {
          const attempt = (failures.get(key) ?? 0) + 1;
          failures.set(key, attempt);
          log(attempt >= MAX_ATTEMPTS ? "adjudication failed, giving up on this sale" : "adjudication failed, will retry", { saleId: i, attempt, error: errText(e) });
        }
      }
    } catch (e) { log("watch poll failed, retrying", { error: errText(e) }); }
    await sleep(POLL_MS);
  }
  log("watch ended");
}

const cmd = args[0];
if (cmd === "post") await post();
else if (cmd === "watch") await watch();
else { console.error("usage: buyer.ts post | watch [--silent] [--claim N] [--seconds S]"); process.exit(2); }
