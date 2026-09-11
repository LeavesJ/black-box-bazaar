#!/usr/bin/env node
// demo/console.mjs — the step presenter: a live walkthrough at the presenter's own pace.
// One command boots a fresh local chain, deploys the market, starts the arbiter and the sweep, and serves the page
// with the presenter on top at http://localhost:8082/?present=1. The page walks the deck of demo/deck.mjs: slides, a
// title card per scene, and live steps. Entering a live step does exactly one thing (post a claim, start an agent,
// release one agent's next transaction, or jump the local clock), then waits until the chain or a log shows the
// result. Every agent stops before each transaction until its gate is released (agents/src/pace.ts, DEMO_GATE_DIR),
// so nothing moves on-chain between presses: the agents decide what to do, the presenter decides when. Nothing here
// touches the testnet or a committed file; the page is a scratch copy under demo/out/present/ naming this chain.
// Usage: node demo/console.mjs              then the browser opens http://localhost:8082/?present=1
// API:   GET /api/deck · GET /api/state · POST /api/next {"from": <head>} · POST /api/retry · POST /api/reset
// Env:   PRESENT_PORT (8082) · PRESENT_ANVIL_PORT (8546) · PRESENT_WINDOW (3600: every contract window, seconds) ·
//        BOUNTY_ETH (0.0005) · PRESENT_NO_OPEN=1 (no browser). For tests: PRESENT_NO_AGENTS=1 starts no agent, at
//        boot or from a step, and a step that posts a claim names the next claim id instead of posting it, so a test
//        can play the agents by hand with cast and gate files; PRESENT_TIMEOUT_S caps every step's timeout.
// One console at a time: a second one finds the port taken, or finds the first still running by its pid in
// demo/out/present/pids.json, and exits without touching anything. Each boot makes one model call through the
// agents' own client, so a missing or refused ANTHROPIC_API_KEY shows before the talk, not at the first hunt.
// Needs: Foundry (anvil, forge), Node 26, agents/node_modules, and ANTHROPIC_API_KEY in .env.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { DECK } from "./deck.mjs";
import { lastLine, latestProblem, makeCtx, pendingGates } from "./present-ctx.mjs";
import { killGroup, liveConsole, staleGroups, waitGone } from "./present-procs.mjs";

const here = new URL(".", import.meta.url).pathname;
const ROOT = join(here, "..");
const AGENTS = join(ROOT, "agents");
const OUT = join(here, "out", "present");
const SITE = join(OUT, "site"), LOGS = join(OUT, "logs"), GATES = join(OUT, "gates");
const STATE_DIR = join(AGENTS, ".state");
const PORT = Number(process.env.PRESENT_PORT || 8082);
const ANVIL_PORT = Number(process.env.PRESENT_ANVIL_PORT || 8546);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const CHAIN_ID = 31337;
const DEPLOYER0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";   // anvil account 0, held unlocked by anvil: no key needed
const ARBITER5 = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";    // anvil account 5, the agents' arbiter on anvil (agents/src/config.ts)
const WINDOW = Number(process.env.PRESENT_WINDOW || 3600);        // every contract window, so a long talk never lets one lapse
const NO_AGENTS = process.env.PRESENT_NO_AGENTS === "1";
const TIMEOUT_CAP = Number(process.env.PRESENT_TIMEOUT_S || 0);
const AGENT_SECONDS = "14400";
const POLL_MS = 500;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
// CHAIN=anvil: forge loads the repository's .env on its own, and a CHAIN=base-sepolia there would win otherwise.
const env = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`, CHAIN: "anvil" };
for (const [k, v] of [["PRESENT_PORT", PORT], ["PRESENT_ANVIL_PORT", ANVIL_PORT], ["PRESENT_WINDOW", WINDOW]])
  if (!Number.isInteger(v) || v <= 0) { console.error(`${k} must be a positive integer`); process.exit(2); }
if (!Number.isFinite(TIMEOUT_CAP) || TIMEOUT_CAP < 0) { console.error("PRESENT_TIMEOUT_S must be a number of seconds"); process.exit(2); }
{ // a deck that cannot be walked is refused here, not discovered mid-talk
  const ids = new Set();
  for (const [i, s] of DECK.entries()) {
    const bad = !["slide", "card", "live"].includes(s.kind) || !s.id || !s.label || ids.has(s.id) || (s.kind === "live" ? !s.step || !s.color : !s.slide);
    if (bad) { console.error(`demo/deck.mjs: step ${i} (${s.id}) is malformed`); process.exit(2); }
    ids.add(s.id);
  }
}

// phase: the chain's (booting | ready | failed | stopped). head: the step most recently entered. rt[i]: step i's
// runtime (status, error, working text, progress, the view last shown). gen: bumped by every reset, so work begun
// for an older chain never writes into the new one. procs: every child this console started, by name. cmds: the npm
// arguments each agent was last started with, which Retry may start again (restartable).
const run = { phase: "booting", error: "", market: null, head: 0, gen: 0, rt: [], ctx: null, procs: {}, cmds: {} };
const tlog = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => String(e?.message ?? e).split("\n")[0].slice(0, 300);
function fail(msg) { run.phase = "failed"; run.error = msg; tlog("FAILED:", msg); }
async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const answers = () => rpc("eth_chainId").then(() => true, () => false);

// ---------- processes: each in its own process group, so stopping it stops what it started ----------
// pids.json names this console and every child it started, so a later console can tell whether this one still runs
// (it then leaves everything alone) or died without cleaning up (it then stops what this one left: present-procs.mjs).
// It is written only once this console owns it: one that finds another console running exits without writing it.
let ownsPids = false;
function savePids() {
  if (!ownsPids) return;
  const live = Object.fromEntries(Object.entries(run.procs).filter(([, p]) => p.exit === null).map(([n, p]) => [n, p.pid]));
  try { writeFileSync(join(OUT, "pids.json"), JSON.stringify({ console: process.pid, ...live }) + "\n"); } catch { /* the scratch dir went away */ }
}
const readPids = () => { try { return JSON.parse(readFileSync(join(OUT, "pids.json"), "utf8")) ?? {}; } catch { return {}; } };
function launch(name, cmd, args, opts) {
  const p = spawn(cmd, args, { detached: true, ...opts });
  const rec = { pid: p.pid, exit: null, gen: run.gen };
  run.procs[name] = rec;
  p.on("error", (e) => { if (rec.exit === null) rec.exit = `could not start: ${e.message}`; savePids(); });
  p.on("exit", (code, sig) => {
    rec.exit = code ?? sig ?? "?"; savePids();
    if (name === "anvil" && rec.gen === run.gen && run.phase !== "stopped") fail(`anvil exited (${rec.exit}); see demo/out/present/anvil.log`);
  });
  savePids();
  return p;
}
function stopAll() { for (const p of Object.values(run.procs)) if (p.exit === null) killGroup(p.pid); run.procs = {}; savePids(); }
/** Runs a command to completion in its own group, collecting stdout and stderr; a reset kills it like any other. */
function capture(name, cmd, args, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = launch(name, cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { killGroup(p.pid); reject(new Error(`${name} took longer than ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code, sig) => { clearTimeout(timer); resolve({ code: code ?? sig, out }); });
  });
}
// ---------- the chain, the market, the page ----------
function startAnvil() {
  const fd = openSync(join(OUT, "anvil.log"), "w");
  try { launch("anvil", "anvil", ["--silent", "--port", String(ANVIL_PORT), "--block-time", "1"], { env, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
}
async function waitRpc() {
  for (let i = 0; i < 40; i++) { if (await answers()) return; if (run.procs.anvil && run.procs.anvil.exit !== null) break; await sleep(500); }
  throw new Error(`anvil did not answer on ${RPC}; see demo/out/present/anvil.log`);
}
async function deploy() {
  const w = String(WINDOW);
  const { code, out } = await capture("forge", "forge", ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--unlocked", "--sender", DEPLOYER0, "--broadcast"],
    { cwd: ROOT, env: { ...env, ARBITER_ADDRESS: ARBITER5, REVEAL_WINDOW: w, ADJUDICATION_WINDOW: w, DISCLOSURE_WINDOW: w, ARBITRATION_WINDOW: w } }, 180_000);
  writeFileSync(join(OUT, "deploy.log"), out);
  const m = /MARKET_ADDRESS=(0x[0-9a-fA-F]{40})/.exec(out);
  if (code !== 0 || !m) throw new Error(`forge script failed (exit ${code}); see demo/out/present/deploy.log`);
  return m[1];
}
// The page from a scratch copy of docs/ whose deployment.json names this chain; docs/deployment.json is never written.
function writeSite(address, deployedBlock) {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  for (const d of readdirSync(join(ROOT, "docs"), { withFileTypes: true }))
    if (d.isFile() && d.name !== "deployment.json") copyFileSync(join(ROOT, "docs", d.name), join(SITE, d.name));
  writeFileSync(join(SITE, "deployment.json"), JSON.stringify({ chainId: CHAIN_ID, address, rpc: RPC, explorer: "", deployedBlock }) + "\n");
}
// The sellers keep per-sale material in agents/.state keyed by chain and address; a fresh chain at the same address
// would inherit material for sales that no longer exist, so that one namespace is dropped.
function clearSellerState(address) {
  if (!existsSync(STATE_DIR)) return;
  const ns = `${CHAIN_ID}:${address.toLowerCase()}`;
  for (const f of readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"))) {
    let all; try { all = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8")); } catch { continue; }
    if (all && ns in all) { delete all[ns]; writeFileSync(join(STATE_DIR, f), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 }); }
  }
}

// ---------- what a step may start ----------
const agentEnv = () => ({ ...env, DEMO_GATE_DIR: GATES, LOG_DIR: LOGS, MARKET_ADDRESS: run.market.address, CHAIN: "anvil", RPC_URL: RPC,
  BOUNTY_ETH: process.env.BOUNTY_ETH || "0.0005", CLAIM_DURATION: "86400", DEMO_STEP_MS: "0", POLL_MS: "1000" });
function startAgent(name, npmArgs) {
  const cmd = `npm run -s ${npmArgs.join(" ")}`;
  if (NO_AGENTS) { tlog(`PRESENT_NO_AGENTS: not starting ${name} (${cmd})`); return; }
  run.cmds[name] = npmArgs;
  const old = run.procs[name];
  if (old && old.exit === null) killGroup(old.pid);   // one process per name: a retried enter never runs two watchers
  const fd = openSync(join(LOGS, `${name}.out`), "a");
  try { launch(name, "npm", ["run", "-s", ...npmArgs], { cwd: AGENTS, env: agentEnv(), stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  tlog(`started ${name}: ${cmd}`);
}
async function post() {
  if (NO_AGENTS) { const next = await run.ctx.claimCount(); tlog(`PRESENT_NO_AGENTS: not posting; the step waits for claim #${next}`); return next; }
  const { code, out } = await capture("post", "npm", ["run", "-s", "buyer", "--", "post"], { cwd: AGENTS, env: agentEnv() }, 120_000);
  try { writeFileSync(join(LOGS, "post.out"), out, { flag: "a" }); } catch { /* logs dir cleared by a reset */ }
  const m = /CLAIM_ID=(\d+)/.exec(out);
  if (!m) throw new Error(`the buyer's post printed no CLAIM_ID (exit ${code}): ${out.trim().split("\n").pop() || "no output"}`);
  return Number(m[1]);
}
async function jump(seconds) { await rpc("evm_increaseTime", [Number(seconds)]); await rpc("evm_mine"); tlog(`clock jumped ${seconds} s`); }
const guarded = (g, fn) => (...a) => { if (g !== run.gen) throw new Error("the chain was reset"); return fn(...a); };
// One model call through the agents' own client, in the environment their npm scripts give them (the root .env by
// --env-file, which never overrides a variable already set), so a missing, invalid or unfunded key shows at boot and
// not at the first hunt. Returns why the live demo cannot go on, or null: a refusal (agents/src/model.ts apiRefused)
// stops it; a timeout or an overloaded API is only logged, since every agent tries such a call again.
async function checkModel() {
  const code = [
    `import { apiRefused, modelIsWrong } from "./src/model.ts";`,
    `try { await modelIsWrong(12, 34, 1, 1); console.log("MODEL ok"); }`,
    `catch (e) { console.log("MODEL " + (apiRefused(e) ? "refused " : "unsure ") + String(e?.message ?? e).split("\\n")[0].slice(0, 300)); }`,
  ].join("\n");
  let res;
  try { res = await capture("model-check", process.execPath, ["--env-file=../.env", "--input-type=module", "-e", code], { cwd: AGENTS, env }, 75_000); }
  catch (e) { tlog(`model check did not finish (${firstLine(e)}); the agents retry such calls`); return null; }
  try { writeFileSync(join(OUT, "model-check.log"), res.out); } catch { /* the scratch dir went away */ }
  const m = /^MODEL (ok|refused|unsure) ?(.*)$/m.exec(res.out);
  const why = (m ? m[2] : res.out.trim().split("\n")[0] || `exit ${res.code}`).replace(/^model call failed on run 1 of 1: /, "").slice(0, 240);
  if (m?.[1] === "ok") { tlog("model check: the API answered"); return null; }
  if (m?.[1] === "unsure") { tlog(`model check failed (${why}); the agents retry such calls`); return null; }
  return m ? `the model API refused a test call (${why}); check ANTHROPIC_API_KEY in .env`
    : `a test model call could not run the way the agents run it (${why}); see demo/out/present/model-check.log`;
}

// ---------- boot and reset ----------
let resetting = null;
/** Stop everything, then a fresh chain, market, page and boot agents, with the deck back at its title slide. */
function reset() {
  if (resetting) return resetting;
  resetting = (async () => {
    const g = ++run.gen;
    Object.assign(run, { phase: "booting", error: "", market: null, ctx: null, head: 0, rt: [entry(DECK[0])] });
    stopAll();
    await sleep(400);
    for (const d of [LOGS, GATES]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
    try {
      if (await answers()) throw new Error(`something already answers on ${RPC}; stop it or set PRESENT_ANVIL_PORT`);
      startAnvil();
      await waitRpc();
      const deployedBlock = Number(await rpc("eth_blockNumber"));
      const check = NO_AGENTS ? Promise.resolve(null) : checkModel();   // beside the deploy, so it adds no boot time
      const address = await deploy();
      if (g !== run.gen) return;
      writeSite(address, deployedBlock);
      clearSellerState(address);
      run.market = { address, rpc: RPC, chainId: CHAIN_ID };
      run.ctx = makeCtx({ address, rpc: RPC, logDir: LOGS, gateDir: GATES, startAgent: guarded(g, startAgent), post: guarded(g, post), jump: guarded(g, jump) });
      if (NO_AGENTS) tlog("PRESENT_NO_AGENTS: the arbiter and the sweep are not started");
      else { startAgent("arbiter", ["arbiter", "--", "watch", "--seconds", AGENT_SECONDS]); startAgent("sweep", ["sweep", "--", "--seconds", AGENT_SECONDS]); }
      // A refused key stops the live steps here, with the API's words in the notes; the page and its slides still load.
      const refused = await check;
      if (g !== run.gen) return;
      if (refused) return fail(refused);
      run.phase = "ready";
      tlog(`market ${address} on a fresh local chain at ${RPC}, every window ${WINDOW} s; page http://localhost:${PORT}/?present=1`);
    } catch (e) { if (g === run.gen) fail(firstLine(e)); }
  })().finally(() => { resetting = null; });
  return resetting;
}

// ---------- the engine ----------
const entry = (step) => ({ status: step.kind === "live" ? "working" : "ready", error: "", working: step.working || "", progress: "",
  startedAt: Date.now(), endedAt: step.kind === "live" ? null : Date.now(), entered: step.kind !== "live", view: null, token: null });
const blankView = (step) => ({ caption: "", note: "", focus: "", label: "", color: step.color, step: step.step, scene: step.scene });
/** Evaluates step i's view and stores it; a failed read keeps the view already stored. */
async function computeView(i, g, attempts = 1) {
  const step = DECK[i];
  for (let k = 1; k <= attempts; k++) {
    try {
      const v = (await step.view?.(run.ctx)) || {};
      if (g === run.gen && run.rt[i]) run.rt[i].view = { ...blankView(step), caption: v.caption || "", note: v.note || "", focus: v.focus || "", label: v.label || "" };
      return;
    } catch (e) { if (k === attempts) tlog(`step ${i + 1}: view failed: ${firstLine(e)}`); else await sleep(300); }
  }
}
async function enterStep(i) {
  const g = run.gen, step = DECK[i], r = (run.rt[i] = entry(step));
  if (step.kind !== "live") return;
  r.view = blankView(step);
  await computeView(i, g);
  if (g !== run.gen || run.rt[i] !== r) return;
  try { await step.enter?.(run.ctx); }
  catch (e) { return failStep(i, g, r, `"${step.label}" could not start: ${firstLine(e)}.`); }
  if (g !== run.gen || run.rt[i] !== r) return;
  r.entered = true;
  await computeView(i, g);
  await waitReady(i, g, r);
}
const isReady = async (step) => { try { return step.ready ? !!(await step.ready(run.ctx)) : true; } catch { return false; } };
// Whether Retry may start a step's stopped agent again with the command it last ran: only where that cannot send a
// transaction nobody released. A hunt's seller may (its step says restart: it committed nothing, and its commit gate
// was never opened), and so may the watchers, which only read the chain and stop at their own gates. A seller that
// already holds a sale may not: a fresh one would hunt again and find that commit gate already open.
const WATCHERS = new Set(["buyer", "arbiter", "sweep"]);
const restartable = (step) => !NO_AGENTS && !!step.agent && !!run.cmds[step.agent] && (!!step.restart || WATCHERS.has(step.agent));
/** Polls ready() every POLL_MS until it holds (ready), the step's timeout passes, or the agent it waits on has exited (failed). */
async function waitReady(i, g, r) {
  const step = DECK[i], base = step.timeout || 240;
  const limit = (TIMEOUT_CAP > 0 ? Math.min(TIMEOUT_CAP, base) : base) * 1000;
  const token = (r.token = Symbol("wait"));   // a retry starts a new wait; the older loop sees the new token and stops
  // The timeout counts from here. The elapsed time the page shows (startedAt) counts from the enter, so it never
  // drops back to 0 after a slow enter (a post); a Retry restarts both.
  const since = Date.now();
  Object.assign(r, { status: "working", error: "", endedAt: null, ...(r.status === "failed" ? { startedAt: since } : {}) });
  const current = () => g === run.gen && run.rt[i] === r && r.token === token;
  for (;;) {
    const ok = await isReady(step);
    if (!current()) return;
    if (ok) {
      await computeView(i, g, 3);
      if (current()) Object.assign(r, { status: "ready", progress: "", endedAt: Date.now() });
      return;
    }
    if (step.progress) { try { r.progress = (await step.progress(run.ctx)) || r.progress; } catch { /* keep the last */ } }
    const proc = step.agent ? run.procs[step.agent] : null;
    if (proc && proc.exit !== null && !(await isReady(step)))
      return failStep(i, g, r, `The ${step.agent} agent stopped (exit ${proc.exit}) while the step waited for ${step.waits}. ${restartable(step)
        ? "Retry starts it again." : "Retry cannot start it again safely; Reset chain starts over."}`);
    if (Date.now() - since > limit) return failStep(i, g, r, `Waited ${Math.round(limit / 1000)} s for ${step.waits}.`);
    await sleep(POLL_MS);
  }
}
// A failure quotes the relevant agent's log, with the fields overlay.js keeps off screen left out: the sellers and the
// buyer hold the pair privately until a dispute discloses it.
const PRIVATE_ROLES = new Set(["seller", "rogue", "newcomer", "quiet", "buyer"]);
const PRIVATE_FIELDS = new Set(["a", "b", "answers", "truth", "plaintext"]);
function readable(line) {
  let o; try { o = typeof line === "object" ? line : JSON.parse(line); } catch { return line; }
  if (!o || typeof o !== "object") return line;
  const { t, role, event, ...rest } = o;
  const shown = Object.entries(rest).filter(([k]) => !(PRIVATE_ROLES.has(role) && (PRIVATE_FIELDS.has(k) || /pair/i.test(k))))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`.slice(0, 90));
  return [[role, event].filter(Boolean).join(" "), ...shown].join(" ");
}
function failStep(i, g, r, msg) {
  if (g !== run.gen || run.rt[i] !== r) return;
  const step = DECK[i], who = step.who || step.agent;
  // The latest problem the agent logged while the step ran ("probe budget exhausted", a refused API call) says more
  // than whatever it logged after it ("done"); with none, its last line.
  let quote = "";
  if (who) {
    try { const p = latestProblem(LOGS, who, r.startedAt); quote = p ? ` The ${who} logged: ${readable(p)}` : ` Last ${who} log line: ${readable(lastLine(LOGS, who))}`; }
    catch { quote = ""; }
  }
  Object.assign(r, { status: "failed", error: msg + quote, endedAt: Date.now() });
  tlog(`step ${i + 1} "${step.label}" failed: ${r.error}`);
}
/** Advances only from the head the page saw, once the head step is ready: a double click advances once. */
function next(from) {
  if (!Number.isInteger(from)) return { ok: false, error: "The body needs \"from\": the index of the step the page shows as the head." };
  if (from !== run.head) return { ok: false, error: `The market is at step ${run.head + 1}, not step ${from + 1}.` };
  const r = run.rt[run.head];
  if (!r || r.status !== "ready") return { ok: false, error: `Step ${run.head + 1} is ${r ? r.status : "not entered"}.` };
  if (run.head >= DECK.length - 1) return { ok: false, error: "This is the last step." };
  if (DECK[run.head + 1].kind === "live" && run.phase !== "ready")
    return { ok: false, error: run.phase === "booting" ? "The chain is still starting." : `The chain is not running: ${run.error || run.phase}.` };
  const i = ++run.head, g = run.gen;
  tlog(`step ${i + 1}/${DECK.length}: ${DECK[i].label}`);
  enterStep(i).catch((e) => failStep(i, g, run.rt[i], `"${DECK[i].label}" crashed: ${firstLine(e)}.`));
  return { ok: true, head: i };
}
/**
 * A failed head step waits again with a fresh timeout; its enter runs again only if it never completed. When the agent
 * it waits on has stopped, waiting again could only fail again: that agent is started again first if it may be
 * (restartable), and otherwise Retry is refused with the reason.
 */
function retry() {
  const i = run.head, r = run.rt[i], g = run.gen, step = DECK[i];
  if (!r || r.status !== "failed") return { ok: false, error: `Step ${i + 1} has not failed.` };
  if (run.phase !== "ready") return { ok: false, error: `The chain is not running: ${run.error || run.phase}.` };
  const proc = step.agent ? run.procs[step.agent] : null;
  const stopped = r.entered && !!proc && proc.exit !== null;
  if (stopped && !restartable(step))
    return { ok: false, error: `The ${step.agent} agent has stopped, and starting it again could send a transaction nobody released. Reset chain starts over.` };
  if (stopped) startAgent(step.agent, run.cmds[step.agent]);
  tlog(`step ${i + 1}: retry (${!r.entered ? "entering again" : stopped ? `the ${step.agent} agent started again` : "waiting again"})`);
  (r.entered ? waitReady(i, g, r) : enterStep(i)).catch((e) => failStep(i, g, run.rt[i], `"${DECK[i].label}" crashed: ${firstLine(e)}.`));
  return { ok: true };
}

// ---------- state for the page ----------
/** The last n NDJSON lines across LOG_DIR/*.log, oldest first; ties keep each file's write order. */
function tailLogs(n) {
  if (!existsSync(LOGS)) return [];
  const all = [];
  for (const f of readdirSync(LOGS).filter((f) => f.endsWith(".log"))) {
    let text; try { text = readFileSync(join(LOGS, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let t; try { t = Date.parse(JSON.parse(line).t) || 0; } catch { continue; }
      all.push({ line, t, k: all.length });
    }
  }
  return all.sort((a, b) => a.t - b.t || a.k - b.k).slice(-n).map((x) => x.line);
}
function state() {
  const i = run.head, step = DECK[i], r = run.rt[i] || entry(step);
  const current = { i, status: r.status, waitedMs: (r.endedAt ?? Date.now()) - r.startedAt };
  if (r.error) current.error = r.error;
  if (r.status === "working" && step.kind === "live") { current.working = r.working; if (r.progress) current.progress = r.progress; }
  const views = {};
  run.rt.forEach((e, k) => { if (e && e.view) views[k] = e.view; });
  return { phase: run.phase, error: run.error, market: run.market, head: i, current, views, pending: pendingGates(GATES).map((x) => x.key), logs: tailLogs(60) };
}

// ---------- http ----------
const DECK_JSON = JSON.stringify({ steps: DECK.map((s, i) => ({ i, id: s.id, kind: s.kind, scene: s.scene, label: s.label, ...(s.kind === "live" ? {} : { slide: s.slide }), say: s.say || [] })) });
const send = (res, code, body, type = TYPES[".json"]) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 4096) { resolve(null); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const api = /^\/api\/([a-z]+)$/.exec(url.pathname);
    if (api) {
      const name = api[1];
      if (req.method === "GET" && name === "deck") return send(res, 200, DECK_JSON);
      if (req.method === "GET" && name === "state") return send(res, 200, state());
      if (req.method !== "POST" || !["next", "retry", "reset"].includes(name)) return send(res, 404, { ok: false, error: `no ${req.method} /api/${name}` });
      const body = await readBody(req);
      if (name === "next") return send(res, 200, body && typeof body === "object" ? next(body.from) : { ok: false, error: "The body must be JSON: {\"from\": <head>}." });
      if (name === "retry") return send(res, 200, retry());
      reset();
      return send(res, 200, { ok: true });
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(SITE, rel));
    if (!file.startsWith(SITE + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, "not found", "text/plain; charset=utf-8");
    send(res, 200, readFileSync(file), TYPES[extname(file)] || "application/octet-stream");
  } catch (e) { if (!res.headersSent) send(res, 500, { ok: false, error: firstLine(e) }); }
});

// ---------- boot ----------
// The port first: a second console started by mistake finds it taken and exits before it touches anything. Then the
// console pids.json names: still running (on another port), this one exits too; gone without cleaning up, what it
// left running is stopped (present-procs.mjs staleGroups), and only then does this console take the file over.
mkdirSync(OUT, { recursive: true });
let stopping = false;
function shutdown(code) {
  if (!stopping) { stopping = true; run.phase = "stopped"; run.gen++; stopAll(); tlog("stopped; every child process was sent SIGTERM"); }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(0));
process.on("exit", () => { for (const p of Object.values(run.procs)) if (p.exit === null) killGroup(p.pid); });
process.on("unhandledRejection", (e) => tlog("unhandled rejection:", firstLine(e)));
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `port ${PORT} is taken: is a presenter console already running? Its page is http://localhost:${PORT}/?present=1. This one exits and touches nothing.`
    : `cannot serve on port ${PORT}: ${e.message}`);
  shutdown(1);
});
server.listen(PORT, async () => {
  const pids = readPids(), other = liveConsole(pids);
  if (other) { console.error(`another presenter console (pid ${other}) is running from this checkout; stop it first (ctrl-c in its terminal). This one exits and touches nothing.`); return shutdown(1); }
  const stale = staleGroups(pids, ANVIL_PORT);
  for (const s of stale) { tlog(`stopping what an earlier console left running: ${s.pid} ${s.cmd.slice(0, 80)}`); killGroup(s.pid); }
  if (stale.length && !(await waitGone(stale.map((s) => s.pid)))) tlog("some of what it left is still stopping");
  ownsPids = true; savePids();
  tlog(`presenter on http://localhost:${PORT}/?present=1 (anvil on ${ANVIL_PORT}); ${DECK.length} steps; ctrl-c stops everything`);
  reset().then(() => {
    if (process.platform === "darwin" && !process.env.PRESENT_NO_OPEN) spawn("open", [`http://localhost:${PORT}/?present=1`], { stdio: "ignore", detached: true }).unref();
  });
});
