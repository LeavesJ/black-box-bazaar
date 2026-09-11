// demo/present-procs.mjs — the step presenter's process bookkeeping (demo/console.mjs). Every child the console starts
// leads its own process group (it is spawned detached), and demo/out/present/pids.json names each group by the child's
// name, beside the console's own pid under "console". A later console reads that file to tell a console still
// running, which it leaves alone, from one that died without cleaning up, whose children it stops.
// agents/test/present-procs.test.ts checks this against the titles npm really gives the agents' scripts.
import { execFileSync } from "node:child_process";

/**
 * A command line a console starts: its anvil on that port, a deploy, or an agent. npm retitles itself without -s and
 * -- ("npm run seller hunt --claim 0 …"), and the agent itself runs as "node … src/<agent>.ts …" in the same group.
 */
export const oursPattern = (anvilPort) =>
  new RegExp(`anvil .*--port ${anvilPort}\\b|forge script|npm run (-s )?(buyer|seller|arbiter|sweep)\\b|src/(buyer|seller|arbiter|sweep)\\.ts\\b`);

/** Every live process by process group: pgid -> [{ pid, cmd }]. Empty when ps cannot run. */
export function processGroups() {
  const out = new Map();
  let text = "";
  try { text = execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const g = Number(m[2]);
    if (!out.has(g)) out.set(g, []);
    out.get(g).push({ pid: Number(m[1]), cmd: m[3] });
  }
  return out;
}

/**
 * The groups a pids.json names that still hold something a console starts, as [{ name, pid, cmd }]. By group, not by
 * the leader alone: the leader is npm, whose title does not name the script's flags, and it may be gone while the
 * node child it started lives on. The "console" entry is not a child and is skipped.
 */
export function staleGroups(pids, anvilPort, groups = processGroups()) {
  const re = oursPattern(anvilPort), out = [];
  for (const [name, pid] of Object.entries(pids ?? {})) {
    if (name === "console" || !Number.isInteger(pid) || pid <= 1) continue;
    const hit = (groups.get(pid) ?? []).find((p) => re.test(p.cmd));
    if (hit) out.push({ name, pid, cmd: hit.cmd });
  }
  return out;
}

/** The console a pids.json names, when it is still running and is not this process; else null. */
export function liveConsole(pids) {
  const pid = pids?.console;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  let cmd = "";
  try { cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  return /console\.mjs/.test(cmd) ? pid : null;
}

/** SIGTERM to a whole process group, and to its leader should it have left the group. Never pid 0 or 1: -1 is everyone. */
export function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  for (const t of [-pid, pid]) { try { process.kill(t, "SIGTERM"); } catch { /* already gone */ } }
}

/** Waits up to ms for every one of these process groups to be empty; true when they are. */
export async function waitGone(pgids, ms = 3000) {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 100))) {
    const groups = processGroups();
    if (pgids.every((g) => !groups.has(g))) return true;
    if (Date.now() > end) return false;
  }
}
