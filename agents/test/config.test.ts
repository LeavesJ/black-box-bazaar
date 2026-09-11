// agents/test/config.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_ADDRESSES, CLAIM_SPEC, HI, LO, MODEL_ID, ROLES, ROLE_WALLETS, SUPPORTED_SPEC, claimIsSupported, keyFor } from "../src/config.ts";

test("claimIsSupported is exact equality on modelId and spec", () => {
  assert.equal(claimIsSupported({ modelId: SUPPORTED_SPEC.modelId, spec: SUPPORTED_SPEC.spec }), true);
  assert.equal(claimIsSupported({ modelId: MODEL_ID, spec: CLAIM_SPEC }), true);
  assert.equal(claimIsSupported({ modelId: MODEL_ID + "x", spec: CLAIM_SPEC }), false, "model id differs");
  assert.equal(claimIsSupported({ modelId: MODEL_ID, spec: CLAIM_SPEC + " " }), false, "trailing space in spec");
  assert.equal(claimIsSupported({ modelId: MODEL_ID.toUpperCase(), spec: CLAIM_SPEC }), false, "case differs");
  assert.equal(claimIsSupported({ modelId: "", spec: "" }), false);
});

test("the spec states the parser rule, the malformed rule and the digit range", () => {
  assert.match(CLAIM_SPEC, /\^-\?\[0-9\]\+\$/);
  assert.match(CLAIM_SPEC, /malformed replies never count/i);
  assert.match(CLAIM_SPEC, /max_tokens/);
  assert.ok(CLAIM_SPEC.includes(`${LO}..${HI}`));
  assert.ok(CLAIM_SPEC.includes(MODEL_ID));
});

test("seven roles: the deployer plus six wallets, quiet among them", () => {
  assert.deepEqual([...ROLES], ["deployer", "buyer", "seller", "rogue", "newcomer", "quiet", "arbiter"]);
  assert.deepEqual([...ROLE_WALLETS], ROLES.filter((r) => r !== "deployer"));
});

test("on anvil every role's key is the account anvil prints for it; quiet is account 6", () => {
  // Pinned to `cast rpc eth_accounts` on 2026-09-10: index 6 is 0x976e...0aa9.
  assert.equal(process.env.CHAIN ?? "anvil", "anvil", "this test reads the anvil table");
  for (const role of ROLES) assert.equal(privateKeyToAccount(keyFor(role)).address, ANVIL_ADDRESSES[role], role);
  assert.equal(ANVIL_ADDRESSES.quiet.toLowerCase(), "0x976ea74026e726554db657fa54763abd0c3a0aa9");
  assert.equal(new Set(Object.values(ANVIL_ADDRESSES)).size, ROLES.length, "no two roles share a wallet");
});

test("on anvil a *_KEY in the environment is ignored: .env holds testnet keys, which hold no anvil ETH", () => {
  const k = ("0x" + "11".repeat(32)) as `0x${string}`;
  process.env.DEPLOYER_KEY = k;
  try {
    assert.notEqual(keyFor("deployer"), k);
    assert.equal(privateKeyToAccount(keyFor("deployer")).address, ANVIL_ADDRESSES.deployer, "still anvil account 0");
  } finally { delete process.env.DEPLOYER_KEY; }
});

// The chain is fixed at import, so the testnet branch is read in a child process.
const keyForOn = (chain: string, env: Record<string, string>) => spawnSync(process.execPath, [
  "--input-type=module", "-e", 'import { keyFor } from "./src/config.ts"; try { console.log(keyFor("quiet")); } catch (e) { console.log("threw: " + e.message); }',
], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, CHAIN: chain, ...env }, encoding: "utf8" }).stdout.trim();

test("off anvil the env key is the only source: present it wins, absent keyFor throws", () => {
  const k = "0x" + "22".repeat(32);
  assert.equal(keyForOn("base-sepolia", { QUIET_KEY: k }), k);
  assert.match(keyForOn("base-sepolia", { QUIET_KEY: "" }), /threw: QUIET_KEY is not set and chain is not anvil/);
});
