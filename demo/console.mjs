#!/usr/bin/env node
// demo/console.mjs — the click-through presenter, for a live walkthrough in front of people.
// One command gives a fresh local chain, the market deployed on it, the page served with a presenter panel, and
// demo/scenes.sh started but held at a gate before each scene. The panel's Run buttons open the gates, so the
// four scenes run one at a time with the same captions, callouts and step tracker the recorded video has, and
// the panel says what to tell the room while each one runs. Nothing here touches the testnet or any committed
// file: the page is served from a scratch copy under demo/out/present/ whose deployment.json names the local chain.
// Usage: node demo/console.mjs                 then the browser opens http://localhost:8082/?present=1
// Env:   PRESENT_PORT (8082) · PRESENT_ANVIL_PORT (8546) · BOUNTY_ETH (0.0005) · DEMO_STEP_MS (scenes.sh's default)
// Needs: Foundry (anvil, forge, cast), Node 26, agents/node_modules, and ANTHROPIC_API_KEY in .env.
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, copyFileSync, openSync } from "node:fs";
import { join, extname } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const ROOT = join(here, "..");
const OUT = join(here, "out", "present");
const SITE = join(OUT, "site");
const LOGS = join(OUT, "logs");
const STATE_DIR = join(ROOT, "agents", ".state");
const PORT = Number(process.env.PRESENT_PORT ?? 8082);
const ANVIL_PORT = Number(process.env.PRESENT_ANVIL_PORT ?? 8546);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const CHAIN_ID = 31337;
const DEPLOYER0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";                         // anvil account 0, the deployer on a local chain; anvil holds it unlocked, so no key is needed here
const ARBITER5 = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";                          // anvil account 5: the agents' arbiter on a local chain (agents/src/config.ts)
const WINDOW = 60;                                                                       // every contract window, seconds; scene 4 jumps the clock past it
const SITE_FILES = ["index.html", "app.js", "abi.json", "overlay.js", "present.js"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
const env = { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` };

// Everything the page's panel needs, in one object; /api/state adds the current scene line and the agents' logs.
const run = { phase: "booting", market: null, error: "", pids: { anvil: 0, scenes: 0 }, startedAt: 0, scenesExit: null };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// ---------- processes ----------
// Each child gets its own process group, so stopping it stops the agents scenes.sh started too.
function killGroup(pid) {
  if (!pid) return;
  for (const target of [-pid, pid]) { try { process.kill(target, "SIGTERM"); } catch { /* already gone */ } }
}
const alive = (pid) => { try { return pid > 0 && (process.kill(pid, 0), true); } catch { return false; } };
function stopAll() {
  killGroup(run.pids.scenes); killGroup(run.pids.anvil);
  run.pids = { anvil: 0, scenes: 0 };
  writeFileSync(join(OUT, "pids.json"), JSON.stringify(run.pids) + "\n");
}
function startAnvil() {
  const out = openSync(join(OUT, "anvil.log"), "w");
  const p = spawn("anvil", ["--silent", "--port", String(ANVIL_PORT), "--block-time", "1"], { env, detached: true, stdio: ["ignore", out, out] });
  p.on("exit", (code) => { if (run.pids.anvil === p.pid) { run.pids.anvil = 0; if (run.phase !== "stopped") fail(`anvil exited (${code})`); } });
  p.unref();
  run.pids.anvil = p.pid;
}
async function waitRpc() {
  for (let i = 0; i < 40; i++) { try { await rpc("eth_blockNumber"); return; } catch { await sleep(500); } }
  throw new Error(`anvil did not answer on ${RPC} within 20 s (is the port free?)`);
}
// The market, with every window WINDOW seconds and the arbiter the agents use on a local chain.
function deploy() {
  const out = execFileSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--unlocked", "--sender", DEPLOYER0, "--broadcast"], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, ARBITER_ADDRESS: ARBITER5, REVEAL_WINDOW: String(WINDOW), ADJUDICATION_WINDOW: String(WINDOW), DISCLOSURE_WINDOW: String(WINDOW), ARBITRATION_WINDOW: String(WINDOW) },
  });
  writeFileSync(join(OUT, "deploy.log"), out);
  const m = /MARKET_ADDRESS=(0x[0-9a-fA-F]{40})/.exec(out);
  if (!m) throw new Error("forge script printed no MARKET_ADDRESS; see demo/out/present/deploy.log");
  return m[1];
}
// The page, from a scratch copy pointed at this chain; docs/deployment.json (the testnet) is never written.
function writeSite(address, deployedBlock) {
  mkdirSync(SITE, { recursive: true });
  for (const f of SITE_FILES) copyFileSync(join(ROOT, "docs", f), join(SITE, f));
  writeFileSync(join(SITE, "deployment.json"), JSON.stringify({ chainId: CHAIN_ID, address, rpc: RPC, explorer: "", deployedBlock }) + "\n");
}
// The sellers keep per-sale material under agents/.state keyed by chain and address. A fresh chain at the same
// address would otherwise inherit material for sales that no longer exist; only that namespace is dropped.
function clearSellerState(address) {
  if (!existsSync(STATE_DIR)) return;
  const ns = `${CHAIN_ID}:${address.toLowerCase()}`;
  for (const f of readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"))) {
    const all = readJson(join(STATE_DIR, f), null);
    if (all && ns in all) { delete all[ns]; writeFileSync(join(STATE_DIR, f), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 }); }
  }
}
function startScenes(address) {
  const out = openSync(join(OUT, "scenes.log"), "w");
  const p = spawn("bash", [join(here, "scenes.sh")], {
    cwd: ROOT, detached: true, stdio: ["ignore", out, out],
    env: { ...env, PRESENT: "1", PRESENT_DIR: OUT, LOGS_DIR: LOGS, SCENE_FILE: join(OUT, "scene.txt"), TIMELINE_FILE: join(OUT, "timeline.json"),
           MARKET_ADDRESS: address, CHAIN: "anvil", RPC_URL: RPC, BOUNTY_ETH: process.env.BOUNTY_ETH ?? "0.0005", EPILOGUE: "0" },
  });
  p.on("exit", (code) => {
    if (run.pids.scenes !== p.pid) return;
    run.pids.scenes = 0; run.scenesExit = code;
    if (run.phase === "running" || run.phase === "ready") run.phase = code === 0 ? "done" : "failed";
    if (code !== 0 && !run.error) run.error = `scenes.sh exited with ${code}; see demo/out/present/scenes.log`;
    log(`scenes.sh exited (${code})`);
  });
  p.unref();
  run.pids.scenes = p.pid;
  writeFileSync(join(OUT, "pids.json"), JSON.stringify(run.pids) + "\n");
}
function fail(msg) { run.phase = "failed"; run.error = msg; log("FAILED:", msg); }

let resetting = null;
// A fresh chain, a fresh market, a fresh page, and scenes.sh waiting at the first gate. Reentrant: a second
// call while one is under way waits for it.
function reset() {
  if (resetting) return resetting;
  resetting = (async () => {
    run.phase = "booting"; run.error = ""; run.market = null; run.scenesExit = null; run.startedAt = Date.now();
    stopAll();
    await sleep(300);
    const gates = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.startsWith("go.")) : [];
    for (const f of ["status.json", "scene.txt", "timeline.json", "logs", ...gates]) rmSync(join(OUT, f), { recursive: true, force: true });
    mkdirSync(LOGS, { recursive: true });
    try {
      startAnvil();
      await waitRpc();
      const deployedBlock = Number(await rpc("eth_blockNumber"));
      const address = deploy();
      writeSite(address, deployedBlock);
      clearSellerState(address);
      run.market = { address, rpc: RPC, chainId: CHAIN_ID };
      startScenes(address);
      run.phase = "running";
      log(`market ${address} on a fresh local chain at ${RPC}; page http://localhost:${PORT}/?present=1`);
    } catch (e) {
      fail(String(e.message || e).split("\n")[0]);
    }
  })().finally(() => { resetting = null; });
  return resetting;
}

// ---------- state for the page ----------
const tail = (file, n) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-n) : [];
function state() {
  const status = readJson(join(OUT, "status.json"), { waiting: null, running: null, done: [] });
  const raw = existsSync(join(OUT, "scene.txt")) ? readFileSync(join(OUT, "scene.txt"), "utf8").trim() : "";
  let line = null;
  if (raw) { try { line = JSON.parse(raw); } catch { line = { caption: raw }; } }
  const failedLine = !!line && /^Demo failed:/.test(line.caption || "");
  let phase = run.phase;
  if (phase === "running" && status.waiting !== null) phase = "ready";
  if (line && line.caption === "END" && phase !== "failed") phase = run.scenesExit === 0 || run.scenesExit === null ? "done" : "failed";
  if (failedLine) phase = "failed";
  const logs = existsSync(LOGS) ? readdirSync(LOGS).filter((f) => f.endsWith(".log")).flatMap((f) => tail(join(LOGS, f), 40)) : [];
  return { phase, market: run.market, error: run.error || (failedLine ? line.caption : ""), ...status, line, logs, anvil: alive(run.pids.anvil), scenes: alive(run.pids.scenes) };
}
function go(n) {
  const status = readJson(join(OUT, "status.json"), {});
  if (status.waiting !== n) return { ok: false, error: `scene ${n} is not the one waiting (waiting: ${status.waiting})` };
  writeFileSync(join(OUT, `go.${n}`), "");
  log(`go: scene ${n}`);
  return { ok: true };
}

// ---------- http ----------
const send = (res, code, body, type = TYPES[".json"]) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const m = /^\/api\/(state|reset|stop|go\/(\d))$/.exec(url.pathname);
  if (m) {
    if (m[1] === "state") return send(res, 200, JSON.stringify(state()));
    if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "POST" }));
    if (m[1] === "reset") { reset(); return send(res, 200, JSON.stringify({ ok: true })); }
    if (m[1] === "stop") { run.phase = "stopped"; stopAll(); return send(res, 200, JSON.stringify({ ok: true })); }
    return send(res, 200, JSON.stringify(go(Number(m[2]))));
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = join(SITE, rel);
  if (rel.includes("..") || !existsSync(file)) return send(res, 404, "not found", "text/plain");
  send(res, 200, readFileSync(file), TYPES[extname(file)] || "application/octet-stream");
});

// ---------- boot ----------
mkdirSync(OUT, { recursive: true });
const stale = readJson(join(OUT, "pids.json"), {});
for (const pid of Object.values(stale)) if (alive(pid)) killGroup(pid);   // a console that was not shut down cleanly
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { log("stopping"); run.phase = "stopped"; stopAll(); process.exit(0); });
server.listen(PORT, () => {
  log(`presenter on http://localhost:${PORT}/?present=1 (anvil on ${ANVIL_PORT}); ctrl-c stops everything`);
  reset().then(() => { if (process.platform === "darwin" && !process.env.PRESENT_NO_OPEN) spawn("open", [`http://localhost:${PORT}/?present=1`], { stdio: "ignore" }).unref(); });
});
