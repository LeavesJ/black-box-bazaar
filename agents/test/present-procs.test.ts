// agents/test/present-procs.test.ts
// The step presenter (demo/console.mjs) stops what a console that died without cleaning up left running, finding each
// child by the process group demo/out/present/pids.json names. The agents start through npm, and npm retitles itself
// ("npm run arbiter watch --seconds 14400": no -s, no --). The first matcher looked for "npm run -s", so an arbiter, a
// sweep and a buyer outlived their console and answered the next talk's gates. These tests start scripts through npm
// exactly as the console does and check the matcher against what ps really shows.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore: a plain .mjs module beside the console, with no type declarations
import { killGroup, liveConsole, oursPattern, processGroups, staleGroups, waitGone } from "../../demo/present-procs.mjs";

const started: ChildProcess[] = [];
const dirs: string[] = [];
after(() => { for (const p of started) killGroup(p.pid); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// A package whose scripts have the agents' shape, "node <flags> src/<agent>.ts": the file is never run, the node
/// child just waits, so nothing here touches a chain or the model.
function fakeAgents() {
  const dir = mkdtempSync(join(tmpdir(), "bazaar-procs-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"));
  const wait = (s: string) => `node -e "setTimeout(() => {}, 60000)" src/${s}.ts`;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-agents", private: true, scripts: { arbiter: wait("arbiter"), seller: wait("seller"), other: `node -e "setTimeout(() => {}, 60000)"` } }));
  return dir;
}
/// Started as demo/console.mjs startAgent starts an agent: npm run -s <script> -- <args>, detached into its own group.
function npmRun(cwd: string, args: string[]) {
  const p = spawn("npm", ["run", "-s", ...args], { cwd, detached: true, stdio: "ignore" });
  started.push(p);
  return p;
}
async function membersOf(pgid: number, n: number) {
  for (let k = 0; k < 100; k++) { const m = processGroups().get(pgid) ?? []; if (m.length >= n) return m; await sleep(100); }
  return processGroups().get(pgid) ?? [];
}

test("the pattern takes what a console starts, and nothing of the recording's or anyone else's", () => {
  const re = oursPattern(8546);
  for (const cmd of ["anvil --silent --port 8546 --block-time 1", "npm run arbiter watch --seconds 14400", "npm run -s seller -- hunt --claim 0",
    "node --env-file=../.env src/sweep.ts --seconds 14400", "forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8546"])
    assert.ok(re.test(cmd), cmd);
  for (const cmd of ["anvil --silent --port 8545 --block-time 1", "anvil --port 85460", "npm run test", "npm run wallets gen", "node demo/record.mjs", "python3 -m http.server 8081"])
    assert.ok(!re.test(cmd), cmd);
});

test("agents started through npm are found by their groups as ps shows them, and stopped whole", async () => {
  const dir = fakeAgents();
  const arbiter = npmRun(dir, ["arbiter", "--", "watch", "--seconds", "14400"]);
  const seller = npmRun(dir, ["seller", "--", "hunt", "--claim", "0", "--role", "seller"]);
  const other = npmRun(dir, ["other"]);
  const a = await membersOf(arbiter.pid!, 2), s = await membersOf(seller.pid!, 2);
  const leader = a.find((m: { pid: number }) => m.pid === arbiter.pid)?.cmd ?? "";
  assert.match(leader, /^npm run /, "the group leader is npm, as ps titles it");
  assert.ok(oursPattern(8546).test(leader), `npm's own title is recognised: ${leader}`);
  assert.ok(s.some((m: { cmd: string }) => /src\/seller\.ts/.test(m.cmd)), "the node child runs in the same group");
  await membersOf(other.pid!, 2);
  const pids = { console: process.pid, arbiter: arbiter.pid, seller: seller.pid, other: other.pid, bogus: 1, gone: 999999 };
  const stale = staleGroups(pids, 8546);
  assert.deepEqual(stale.map((x: { name: string }) => x.name).sort(), ["arbiter", "seller"], "only what a console starts, never pid 1 or a process gone");
  for (const x of stale) killGroup(x.pid);
  assert.equal(await waitGone(stale.map((x: { pid: number }) => x.pid), 5000), true, "npm and its node child both stop");
  assert.ok(processGroups().has(other.pid), "a group that is not an agent is left alone");
});

test("liveConsole: the console pids.json names, while it runs, and never this process or a dead pid", async () => {
  const dir = fakeAgents();
  assert.equal(liveConsole({ console: process.pid }), null, "this process");
  assert.equal(liveConsole({ console: 999999 }), null, "a pid that is gone");
  assert.equal(liveConsole({}), null, "no console named");
  const notConsole = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: dir, stdio: "ignore", detached: true });
  const aConsole = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "demo/console.mjs"], { cwd: dir, stdio: "ignore", detached: true });
  started.push(notConsole, aConsole);
  await sleep(300);
  assert.equal(liveConsole({ console: notConsole.pid }), null, "a live pid that is not a console (a reused pid)");
  assert.equal(liveConsole({ console: aConsole.pid }), aConsole.pid, "a console still running");
});
