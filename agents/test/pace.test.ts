// agents/test/pace.test.ts
// The gate protocol between the agents and the step presenter (demo/console.mjs). With DEMO_GATE_DIR unset an
// agent paces exactly as the recording always has; with it set, every state-changing send waits for a .go file.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_POLL_MS, gateKey, pace, released } from "../src/pace.ts";

const AGENTS = fileURLToPath(new URL("..", import.meta.url));
const PACE_URL = new URL("../src/pace.ts", import.meta.url).href;
const dirs: string[] = [];
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), "bazaar-gate-")); dirs.push(d); return d; };

/// true when `p` settles within `ms`, false while it is still pending then; a rejection fails the test.
const within = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

/// Writes a .go for every request in `dir`, so no pace() a failing test started is left polling.
const releaseAll = (dir: string) => {
  for (const f of readdirSync(dir)) if (f.endsWith(".req.json")) writeFileSync(join(dir, f.slice(0, -".req.json".length) + ".go"), "");
};
// A pace() left polling is released before its directory goes, or it would poll a deleted file and keep this
// process alive forever: the same thing an agent does if the server clears the gates without stopping it.
after(async () => {
  for (const d of dirs) releaseAll(d);
  await new Promise((r) => setTimeout(r, 3 * GATE_POLL_MS));
  for (const d of dirs) rmSync(d, { recursive: true });
});

/// Runs `body` in a child with pace imported and the environment controlled (undefined removes a variable), and
/// returns the JSON the child prints last. DEMO_STEP_MS is read at import, so only a child can vary it.
function child(env: Record<string, string | undefined>, body: string, cwd = AGENTS) {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) e[k] = v;
  const code = `import { pace } from ${JSON.stringify(PACE_URL)};\n` +
    `const ms = async (f) => { const t0 = performance.now(); await f(); return Math.round(performance.now() - t0); };\n` + body;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, env: e, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

// A reveal (paced like every send) and a commit (sleep: false, as the seller's commit call site passes).
const TIMED = `console.log(JSON.stringify({
  paced: await ms(() => pace("seller", "reveal", { saleId: 1n })),
  unslept: await ms(() => pace("seller", "commit", { claimId: 1n, hash: "0x12345678" }, { sleep: false })),
}));`;

test("no gate dir and no DEMO_STEP_MS: pace returns at once and writes nothing", () => {
  for (const gate of [undefined, ""]) {
    const cwd = freshDir();
    const r = child({ DEMO_GATE_DIR: gate, DEMO_STEP_MS: undefined }, TIMED, cwd);
    assert.ok(r.paced < 100, `a reveal took ${r.paced} ms with DEMO_GATE_DIR=${JSON.stringify(gate)}`);
    assert.ok(r.unslept < 100, `a commit took ${r.unslept} ms`);
    assert.deepEqual(readdirSync(cwd), [], "nothing is written");
  }
});

test("no gate dir: pace sleeps DEMO_STEP_MS before a send, and not at all when opts.sleep is false", () => {
  const r = child({ DEMO_GATE_DIR: undefined, DEMO_STEP_MS: "300" }, TIMED);
  assert.ok(r.paced >= 290 && r.paced < 3000, `a reveal took ${r.paced} ms, want about 300`);
  assert.ok(r.unslept < 100, `a commit never sleeps, took ${r.unslept} ms`);
});

test("with a gate dir: pace writes <key>.req.json and returns only after <key>.go appears", async () => {
  const dir = freshDir();
  process.env.DEMO_GATE_DIR = dir; // read at call time: pace.ts was imported before this was set
  try {
    const p = pace("buyer", "dispute", { saleId: 7n, claimId: 2n, reason: "NotReproduced" });
    assert.equal(await within(p, 700), false, "no .go yet, so pace must still be waiting");
    const key = "buyer.dispute.7";
    assert.deepEqual(readdirSync(dir), [`${key}.req.json`], "only the request: the .tmp was renamed into place");
    const req = JSON.parse(readFileSync(join(dir, `${key}.req.json`), "utf8"));
    assert.deepEqual(Object.keys(req), ["key", "role", "action", "saleId", "claimId", "reason", "t"]);
    assert.equal(req.key, key);
    assert.equal(req.role, "buyer");
    assert.equal(req.action, "dispute");
    assert.equal(req.saleId, "7", "a bigint is written as a string");
    assert.equal(req.claimId, "2");
    assert.equal(req.reason, "NotReproduced");
    assert.equal(new Date(req.t).toISOString(), req.t, "t is an ISO time");
    writeFileSync(join(dir, `${key}.go`), "");
    assert.equal(await within(p, 1500), true, "the .go releases it within a poll or two");
  } finally { releaseAll(dir); delete process.env.DEMO_GATE_DIR; }
});

test("a second pace for a key already released returns at once (a retried send)", async () => {
  const dir = freshDir();
  process.env.DEMO_GATE_DIR = dir;
  try {
    const first = pace("arbiter", "rule", { saleId: 3, sellerWasRight: false, verdict: "ruled: model is right, seller refuted" });
    assert.equal(await within(first, 300), false);
    writeFileSync(join(dir, "arbiter.rule.3.go"), "");
    assert.equal(await within(first, 1500), true);
    const again = pace("arbiter", "rule", { saleId: 3, sellerWasRight: false, verdict: "ruled: model is right, seller refuted" });
    assert.equal(await within(again, 150), true, "released once, a retry never waits on a second press");
  } finally { releaseAll(dir); delete process.env.DEMO_GATE_DIR; }
});

test("gate key: role.action.<saleId, else claimId, else x>, sanitised to [A-Za-z0-9._-]", () => {
  assert.equal(gateKey("seller", "commit", { claimId: 0n, hash: "0x1234abcd" }), "seller.commit.0");
  assert.equal(gateKey("buyer", "confirm", { saleId: 0, claimId: 5n }), "buyer.confirm.0", "a sale id of 0 still wins over the claim id");
  assert.equal(gateKey("rogue", "reveal", { saleId: 12n }), "rogue.reveal.12");
  assert.equal(gateKey("sweep", "settle", {}), "sweep.settle.x");
  assert.equal(gateKey("sweep", "settle"), "sweep.settle.x");
  const odd = gateKey("rogue seller", "act/ion", { saleId: "../9 z" });
  assert.match(odd, /^[A-Za-z0-9._-]+$/);
  assert.equal(odd, "rogue_seller.act_ion..._9_z");
});

test("the request is named by the sanitised key inside the dir, and its key, role and action are the gate's own", async () => {
  const dir = freshDir();
  process.env.DEMO_GATE_DIR = dir;
  try {
    const p = pace("rogue seller", "act/ion", { saleId: "../9 z", key: "spoof", role: "spoof", action: "spoof" });
    assert.equal(await within(p, 300), false);
    const key = "rogue_seller.act_ion..._9_z";
    assert.deepEqual(readdirSync(dir), [`${key}.req.json`]);
    const req = JSON.parse(readFileSync(join(dir, `${key}.req.json`), "utf8"));
    assert.deepEqual([req.key, req.role, req.action], [key, "rogue seller", "act/ion"]);
    writeFileSync(join(dir, `${key}.go`), "");
    assert.equal(await within(p, 1500), true, "the .go named by the sanitised key releases it");
  } finally { releaseAll(dir); delete process.env.DEMO_GATE_DIR; }
});

test("a relative DEMO_GATE_DIR is refused: the agents run in agents/, so it would name a dir the server never reads", async () => {
  process.env.DEMO_GATE_DIR = "demo/out/present/gates";
  try {
    await assert.rejects(pace("seller", "reveal", { saleId: 1 }), /DEMO_GATE_DIR must be an absolute path/);
  } finally { delete process.env.DEMO_GATE_DIR; }
});

test("with a gate dir DEMO_STEP_MS is ignored, before and after a release", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "sweep.settle.4.go"), "");
  const r = child({ DEMO_GATE_DIR: dir, DEMO_STEP_MS: "5000" }, `import { writeFileSync } from "node:fs";
setTimeout(() => writeFileSync(process.env.DEMO_GATE_DIR + "/sweep.settle.5.go", ""), 150);
console.log(JSON.stringify({
  released: await ms(() => pace("sweep", "settle", { saleId: 4 }, { sleep: true })),
  waited: await ms(() => pace("sweep", "settle", { saleId: 5 }, { sleep: true })),
}));`);
  assert.ok(r.released < 1000, `an already released gate took ${r.released} ms`);
  assert.ok(r.waited >= 100 && r.waited < 1500, `a gate released after ~150 ms took ${r.waited} ms`);
});

// The sweep serves every sale in one loop. Held at one gate, it once never reached the sales after it: a scene-1
// dispute nobody disclosed held "The window passes" behind sweep.withdrawSale.0 until the step timed out.
test("released(): with a gate dir it files the request once, answers at once, and true only after that .go", async () => {
  const dir = freshDir();
  process.env.DEMO_GATE_DIR = dir;
  try {
    assert.equal(await released("sweep", "withdrawSale", { saleId: 0 }), false, "held: answered, not waited on");
    const key = "sweep.withdrawSale.0", file = join(dir, `${key}.req.json`);
    assert.deepEqual(readdirSync(dir), [`${key}.req.json`]);
    const first = readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await released("sweep", "withdrawSale", { saleId: 0 }), false);
    assert.equal(readFileSync(file, "utf8"), first, "the next pass leaves the request as it was, its time included");
    assert.equal(await released("sweep", "settle", { saleId: 1 }), false, "the next sale's gate is filed beside it, not behind it");
    writeFileSync(join(dir, "sweep.settle.1.go"), "");
    assert.equal(await released("sweep", "settle", { saleId: 1 }), true, "that sale may go");
    assert.equal(await released("sweep", "withdrawSale", { saleId: 0 }), false, "the held one is still held");
    process.env.DEMO_GATE_DIR = "relative/gates";
    await assert.rejects(released("sweep", "settle", { saleId: 1 }), /DEMO_GATE_DIR must be an absolute path/);
  } finally { process.env.DEMO_GATE_DIR = dir; releaseAll(dir); delete process.env.DEMO_GATE_DIR; }
});

test("released(): without a gate dir it paces exactly as pace() and answers true", () => {
  const cwd = freshDir();
  const r = child({ DEMO_GATE_DIR: undefined, DEMO_STEP_MS: "300" }, `import { released } from ${JSON.stringify(PACE_URL)};
let settle, expire;
const tSettle = await ms(async () => { settle = await released("sweep", "settle", { saleId: 1 }, { sleep: true }); });
const tExpire = await ms(async () => { expire = await released("sweep", "expireCommit", { saleId: 2 }, { sleep: false }); });
console.log(JSON.stringify({ settle, expire, tSettle, tExpire }));`, cwd);
  assert.equal(r.settle, true); assert.equal(r.expire, true);
  assert.ok(r.tSettle >= 290 && r.tSettle < 3000, `a settle took ${r.tSettle} ms, want about 300`);
  assert.ok(r.tExpire < 100, `an unslept action took ${r.tExpire} ms`);
  assert.deepEqual(readdirSync(cwd), [], "nothing is written");
});
