// agents/test/wallets.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ROLE_WALLETS } from "../src/config.ts";
import { envFile, freshKeys, gen, planGen, valueOf, type RoleKeys } from "../src/wallets.ts";

// Fixtures are built, not written out: the gate refuses a literal 64-hex key in any tracked file.
const key = (byte: string) => ("0x" + byte.repeat(32)) as `0x${string}`;
const KEYS: RoleKeys = { buyer: key("11"), seller: key("22"), rogue: key("33"), newcomer: key("44"), quiet: key("55"), arbiter: key("66") };
const NAMES = ["BUYER_KEY", "SELLER_KEY", "ROGUE_KEY", "NEWCOMER_KEY", "QUIET_KEY", "ARBITER_KEY", "ARBITER_ADDRESS"];
const scratch = () => mkdtempSync(join(tmpdir(), "bazaar-wallets-"));

test("valueOf reads the last non-empty assignment and treats an empty line as absent", () => {
  assert.equal(valueOf("A=1\nB=\nC='x'\n", "A"), "1");
  assert.equal(valueOf("A=1\nB=\nC='x'\n", "B"), null);
  assert.equal(valueOf("A=1\nB=\nC='x'\n", "C"), "x");
  assert.equal(valueOf("A=1\nA=2\n", "A"), "2", "later wins, as under --env-file");
  assert.equal(valueOf("# A=1\n", "A"), null);
  assert.equal(valueOf("", "A"), null);
});

test("planGen on an empty file writes all six keys plus ARBITER_ADDRESS and reports every address", () => {
  const plan = planGen("", KEYS);
  assert.deepEqual(plan.written, NAMES);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.lines.map((l) => l.split("=")[0]), NAMES);
  for (const role of ROLE_WALLETS) assert.equal(plan.addresses[role], privateKeyToAccount(KEYS[role]).address);
  assert.equal(plan.lines.at(-1), `ARBITER_ADDRESS=${privateKeyToAccount(KEYS.arbiter).address}`);
});

test("planGen never overwrites a key that has a value, and derives ARBITER_ADDRESS from the key that is already there", () => {
  const existing = key("77");
  const text = `SELLER_KEY=${existing}\nARBITER_KEY=${existing}\nBUYER_KEY=\n`;
  const plan = planGen(text, KEYS);
  assert.deepEqual(plan.skipped, ["SELLER_KEY", "ARBITER_KEY"]);
  assert.deepEqual(plan.written, ["BUYER_KEY", "ROGUE_KEY", "NEWCOMER_KEY", "QUIET_KEY", "ARBITER_ADDRESS"]);
  assert.equal(plan.addresses.seller, privateKeyToAccount(existing as `0x${string}`).address, "the kept key's address is still reported");
  assert.ok(plan.lines.includes(`ARBITER_ADDRESS=${privateKeyToAccount(existing as `0x${string}`).address}`));
  assert.ok(!plan.lines.some((l) => l.startsWith("SELLER_KEY=")));
  assert.ok(plan.lines.some((l) => l.startsWith("BUYER_KEY=0x")), "an empty placeholder is filled by a later line, not rewritten");
});

test("gen appends to a scratch file, leaves existing lines byte for byte, and is idempotent", () => {
  const dir = scratch();
  try {
    const file = join(dir, ".env");
    const before = "ANTHROPIC_API_KEY=sk-test\nCHAIN=anvil\nBUYER_KEY=";
    writeFileSync(file, before); // no trailing newline on purpose
    const first = gen(file, KEYS);
    assert.equal(first.lines.length, 7);
    const after = readFileSync(file, "utf8");
    assert.ok(after.startsWith(before + "\n"), "existing bytes untouched, a newline supplied before the append");
    for (const n of NAMES) assert.equal(valueOf(after, n) !== null, true, n);
    assert.equal(valueOf(after, "BUYER_KEY"), KEYS.buyer, "the later line wins over the placeholder");
    const second = gen(file, freshKeys());
    assert.deepEqual(second.lines, []);
    assert.deepEqual(second.skipped, NAMES);
    assert.equal(readFileSync(file, "utf8"), after, "a second gen writes nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("BAZAAR_ENV_FILE redirects the default target, so a test never touches the real .env", () => {
  const dir = scratch();
  const saved = process.env.BAZAAR_ENV_FILE;
  try {
    const file = join(dir, "override.env");
    process.env.BAZAAR_ENV_FILE = file;
    assert.equal(envFile(), file);
    gen(undefined, KEYS); // the default argument resolves through envFile()
    assert.equal(valueOf(readFileSync(file, "utf8"), "QUIET_KEY"), KEYS.quiet);
  } finally {
    if (saved === undefined) delete process.env.BAZAAR_ENV_FILE; else process.env.BAZAAR_ENV_FILE = saved;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(envFile().endsWith("/.env"), "without the override the target is the repository's .env");
});
