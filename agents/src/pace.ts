// agents/src/pace.ts
// Demo pacing: the one wait an agent takes before a state-changing send. Each call site calls pace() just before its
// transaction is sent, and the mode is chosen per call:
// - DEMO_GATE_DIR unset or empty (the recording, demo/scenes.sh): sleep DEMO_STEP_MS when it is above 0 and
//   opts.sleep is not false, as each call site did inline before this file existed. The video relies on this.
// - DEMO_GATE_DIR set, read at call time (the step presenter, demo/console.mjs): DEMO_STEP_MS is ignored. The agent
//   writes <dir>/<key>.req.json and holds until <dir>/<key>.go exists. The server shows a request with no .go as
//   pending and releases it by writing the .go. A call for a key already released (a retried send) passes at once.
// The agent still decides what to send; the gate decides only when. There is no timeout: a gate waits as long as
// the presenter does, and the contract judges every send against its own windows when it lands.
// released() is the same gate for an agent that serves many sales in one loop (the sweep): it files the request and
// answers whether the send may go now, instead of holding the loop on one sale.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DEMO_STEP_MS } from "./config.ts";

export const GATE_POLL_MS = 200;

/// role.action.<saleId, else claimId, else "x">, every character outside [A-Za-z0-9._-] replaced by "_", so a key is
/// always one file name inside the gate directory. `??`, not `||`: sale 0 is a sale.
export function gateKey(role: string, action: string, fields: Record<string, unknown> = {}): string {
  return `${role}.${action}.${String(fields.saleId ?? fields.claimId ?? "x")}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

function gateFiles(dir: string, role: string, action: string, fields: Record<string, unknown>) {
  // The agents run in agents/, so a relative path would name a directory the server never reads, and every agent
  // would hold at its first gate with nothing on screen to say why.
  if (!isAbsolute(dir)) throw new Error(`DEMO_GATE_DIR must be an absolute path, got "${dir}"`);
  const key = gateKey(role, action, fields);
  return { key, go: join(dir, `${key}.go`), req: join(dir, `${key}.req.json`) };
}

function fileRequest(dir: string, key: string, role: string, action: string, fields: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  // key, role and action stay the gate's own even if a field shares a name, so a request and its file name agree.
  const req = Object.assign({ key, role, action }, fields, { key, role, action, t: new Date().toISOString() });
  const tmp = join(dir, `${key}.${process.pid}.tmp`); // never matches *.req.json, so a half-written request is never read
  writeFileSync(tmp, JSON.stringify(req, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
  renameSync(tmp, join(dir, `${key}.req.json`));
}

export async function pace(role: string, action: string, fields: Record<string, unknown> = {}, opts: { sleep?: boolean } = {}): Promise<void> {
  const dir = process.env.DEMO_GATE_DIR;
  if (!dir) {
    if (DEMO_STEP_MS > 0 && opts.sleep !== false) await sleep(DEMO_STEP_MS);
    return;
  }
  const { key, go } = gateFiles(dir, role, action, fields);
  if (existsSync(go)) return; // released already: a retry of a send the presenter let through
  fileRequest(dir, key, role, action, fields);
  while (!existsSync(go)) await sleep(GATE_POLL_MS);
}

/// The gate without the hold. With DEMO_GATE_DIR set it files the request once (a second call leaves it, and its
/// time, as they are) and answers whether its .go exists, so a gate the presenter never opens holds up only its own
/// sale, never every sale after it in the caller's loop. Without DEMO_GATE_DIR it paces exactly as pace() and
/// answers true.
export async function released(role: string, action: string, fields: Record<string, unknown> = {}, opts: { sleep?: boolean } = {}): Promise<boolean> {
  const dir = process.env.DEMO_GATE_DIR;
  if (!dir) { await pace(role, action, fields, opts); return true; }
  const { key, go, req } = gateFiles(dir, role, action, fields);
  if (existsSync(go)) return true;
  if (!existsSync(req)) fileRequest(dir, key, role, action, fields);
  return false;
}
