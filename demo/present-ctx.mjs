// demo/present-ctx.mjs — what a deck step (demo/deck.mjs) may ask of the world while demo/console.mjs presents it:
// the chain through viem, the agents' NDJSON logs, the gate files the agents wait at (agents/src/pace.ts), and the
// words a caption is built from. Every value a caption quotes comes through here, read at that moment.
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANVIL_ADDRESSES, ARBITER_RUNS, BUYER_RUNS } from "../agents/src/config.ts";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const require = createRequire(join(ROOT, "agents", "package.json"));
const { createPublicClient, http, formatEther } = require("viem");
const { foundry } = require("viem/chains");
const ABI = JSON.parse(readFileSync(join(ROOT, "agents", "src", "abi.json"), "utf8"));

export const STATES = ["Committed", "Revealed", "Confirmed", "Disputed", "Refuted", "Upheld", "Unadjudicated", "Withdrawn", "Unarbitrated"];
export const ST = Object.fromEntries(STATES.map((s, i) => [s, i]));
export const REASONS = ["cannot decrypt", "commit mismatch", "not reproduced"];          // the page's words (docs/app.js)
const REASON_KEYS = { CannotDecrypt: 0, CommitMismatch: 1, NotReproduced: 2 };            // agents/src/chain.ts REASON_NAMES
export const isTerminal = (state) => state !== ST.Committed && state !== ST.Revealed && state !== ST.Disputed;
export { ARBITER_RUNS, BUYER_RUNS };

// ---------- words ----------
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** A small count in words, as a caption reads it; anything else stays digits; a missing count is "" (see fill). */
export const word = (n) => {
  if (n === undefined || n === null || n === "") return "";
  const k = Number(n);
  return Number.isInteger(k) && k >= 0 && k <= 10 ? WORDS[k] : String(n);
};
/** A window's length as an adjective: 3600 -> "one-hour", 120 -> "two-minute", 90 -> "90-second". */
export function span(seconds) {
  const s = Number(seconds);
  if (s > 0 && s % 3600 === 0) return `${word(s / 3600)}-hour`;
  if (s > 0 && s % 60 === 0) return `${word(s / 60)}-minute`;
  return `${s}-second`;
}
/** A template tag for one sentence: "" when any value in it is missing, so a caption never carries a hole. */
export function fill(strings, ...vals) {
  if (vals.some((v) => v === undefined || v === null || v === "" || Number.isNaN(v))) return "";
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? String(vals[i]) : ""), "");
}
/** Sentences joined with a space, the omitted ones (empty or false) dropped. */
export const says = (...parts) => parts.filter(Boolean).join(" ");
/** A dispute reason, as the page words it, from an index, a numeric string, or the agents' enum name. */
export function reasonText(r) {
  if (r === undefined || r === null || r === "") return "";
  if (typeof r === "number" || typeof r === "bigint" || /^\d+$/.test(String(r))) return REASONS[Number(r)] ?? `reason ${r}`;
  if (String(r) in REASON_KEYS) return REASONS[REASON_KEYS[String(r)]];
  return String(r);
}
/**
 * demo/scenes.sh tally_phrase: what a log line's wrong, malformed and runs counts say. mode "fails": "It fails every
 * time." or "It fails W of N times."; mode "right": "The model is right every time." or "The model is wrong only W
 * of N times.". Empty when the line or its counts are missing, so a caption never states an outcome nobody logged.
 */
export function tally(o, mode) {
  if (!o || o.wrong === undefined || o.runs === undefined) return "";
  const w = Number(o.wrong), m = Number(o.malformed ?? 0), n = Number(o.runs);
  if (mode === "fails") return w === n ? "It fails every time." : `It fails ${word(w)} of ${word(n)} times.`;
  return w === 0 && m === 0 ? "The model is right every time." : `The model is wrong only ${word(w)} of ${word(n)} times.`;
}
/** The tally in whichever mode the counts themselves call for: a majority wrong reads "fails", else "right". */
export const tallyByCounts = (o) => (o && o.runs !== undefined ? tally(o, Number(o.wrong) * 2 > Number(o.runs) ? "fails" : "right") : "");

/** The page's settlement headline (docs/app.js sellerHeadline), rule for rule: the first matching row wins. */
export function headline(r) {
  if (r.sellerConfirmed > 0) return `${r.sellerConfirmed} confirmed`;
  if (r.sellerRefuted > 0) return "refuted history";
  if (r.sellerWithdrawn > 0) return "withdrawn history";
  if (r.sellerUnarbitrated > 0) return "unarbitrated history";
  if (r.sellerUnadjudicated > 0) return "unverified";
  return "no history";
}

// ---------- files the agents write ----------
/** Every NDJSON object in LOG_DIR/<role>.log, in write order; a torn or foreign line is skipped. */
export function readLog(logDir, role) {
  const f = join(logDir, `${role}.log`);
  if (!existsSync(f)) return [];
  const out = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o === "object") out.push(o); } catch { /* torn line */ }
  }
  return out;
}
/** The last non-empty line of LOG_DIR/<name>.log, else of <name>.out (a crash before the first log line), else "none". */
export function lastLine(logDir, name) {
  for (const ext of [".log", ".out"]) {
    const f = join(logDir, `${name}${ext}`);
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length) return lines[lines.length - 1].slice(0, 300);
  }
  return "none";
}
// An event that reports a problem: "sell loop failed", "probe budget exhausted", "the model API refused the call",
// "chain refused the ruling", "claim has no open slot", "adjudication window closed…", and any line with an error.
const PROBLEM = /failed|refused|exhausted|no open slot|unsupported|could not|never landed|window closed/i;
/**
 * The latest line of LOG_DIR/<role>.log written at or after sinceMs that reports a problem, or null. A step that fails
 * quotes it rather than the line after it: "probe budget exhausted" says why a hunt stopped, the "done" that follows
 * does not.
 */
export function latestProblem(logDir, role, sinceMs = 0) {
  const all = readLog(logDir, role);
  for (let k = all.length - 1; k >= 0; k--) {
    const o = all[k];
    if ((Date.parse(o.t) || 0) < sinceMs) break;
    if (o.error !== undefined || PROBLEM.test(String(o.event ?? ""))) return o;
  }
  return null;
}
/** Gates an agent is waiting at: <key>.req.json present, <key>.go absent. Oldest first. */
export function pendingGates(gateDir) {
  if (!existsSync(gateDir)) return [];
  const out = [];
  for (const f of readdirSync(gateDir)) {
    if (!f.endsWith(".req.json")) continue;
    const key = f.slice(0, -".req.json".length);
    if (existsSync(join(gateDir, `${key}.go`))) continue;
    try { out.push({ ...JSON.parse(readFileSync(join(gateDir, f), "utf8")), key }); } catch { /* mid-rename */ }
  }
  return out.sort((a, b) => String(a.t ?? "").localeCompare(String(b.t ?? "")));
}

/**
 * The ctx one fresh market gets. The runtime pieces (startAgent, post, jump) come from demo/console.mjs, which owns
 * the processes; vars is the per-run scratch the deck keeps its claim and sale ids in.
 */
export function makeCtx({ address, rpc, logDir, gateDir, startAgent, post, jump }) {
  const client = createPublicClient({ chain: foundry, transport: http(rpc) });
  const read = (functionName, args = []) => client.readContract({ address, abi: ABI, functionName, args });
  const matches = (g, role, re, saleId) =>
    g.role === role && re.test(String(g.action)) && (saleId === undefined || saleId === null || String(g.saleId) === String(saleId));
  const ctx = {
    vars: {},
    claimCount: async () => Number(await read("claimCount")),
    saleCount: async () => Number(await read("saleCount")),
    getClaim: (id) => read("getClaim", [BigInt(id)]),
    getSale: (id) => read("getSale", [BigInt(id)]),
    adjudicationWindow: async () => Number(await read("adjudicationWindow")),
    /** rep(address): the eight counters by name, plus the page's headline. */
    async rep(who) {
      const r = await read("rep", [who]);
      const names = ["sellerConfirmed", "sellerRefuted", "sellerUnadjudicated", "sellerWithdrawn", "sellerUnarbitrated", "buyerAdjudicated", "buyerSilent", "buyerDisputesLost"];
      const o = Object.fromEntries(names.map((n, i) => [n, Number(r[i])]));
      return { ...o, headline: headline(o) };
    },
    /** A claim that exists (a nonzero buyer), or null: an unset id, a failed read and an empty slot all read as null. */
    async claim(id) {
      if (id === undefined || id === null) return null;
      try { const c = await ctx.getClaim(id); return /^0x0{40}$/i.test(c.buyer) ? null : c; } catch { return null; }
    },
    /** A sale with its state named and its timestamps as flags, or null (unset id, no such sale, a failed read). */
    async sale(id) {
      if (id === undefined || id === null) return null;
      try {
        const s = await ctx.getSale(id);
        if (/^0x0{40}$/i.test(s.seller)) return null;
        const state = Number(s.state);
        return { ...s, id: Number(id), state, stateName: STATES[state] ?? `state ${state}`, terminal: isTerminal(state),
          revealed: s.revealedAt > 0n, disputed: s.disputedAt > 0n, disclosed: s.disclosedAt > 0n,
          reason: s.disputedAt > 0n ? reasonText(Number(s.disputeReason)) : "" };
      } catch { return null; }
    },
    /** The latest line of LOG_DIR/<role>.log whose event matches, for that sale when saleId is given; else null. */
    log(role, saleId, re) {
      const all = readLog(logDir, role);
      for (let k = all.length - 1; k >= 0; k--) {
        const o = all[k];
        if ((saleId === undefined || saleId === null || String(o.saleId) === String(saleId)) && re.test(String(o.event ?? ""))) return o;
      }
      return null;
    },
    lastLine: (name) => lastLine(logDir, name),
    pending: () => pendingGates(gateDir),
    /** The newest pending gate of that role whose action matches (and that sale, when given), or null. */
    gate: (role, re, saleId) => pendingGates(gateDir).filter((g) => matches(g, role, re, saleId)).pop() ?? null,
    /** Opens that gate by writing <key>.go; throws when nothing matching is waiting. */
    release(role, re, saleId) {
      const g = ctx.gate(role, re, saleId);
      if (!g) throw new Error(`nothing from the ${role} is waiting at a ${re.source.replace(/[\^$()]/g, "")} gate${saleId != null ? ` for sale #${saleId}` : ""}`);
      writeFileSync(join(gateDir, `${g.key}.go`), "");
      return g;
    },
    startAgent, post, jump,
    addr: (role) => ANVIL_ADDRESSES[role],
    word, tally, eth: (wei) => formatEther(BigInt(wei)),
  };
  return ctx;
}
