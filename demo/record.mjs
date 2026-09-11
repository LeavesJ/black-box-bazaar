// demo/record.mjs — records the page while scenes.sh runs; overlays the caption and agent logs.
// Seller-side lines never show the pair (a, b, answers, truth, pair) so nothing leaks before reveal.
// Usage: node demo/record.mjs http://localhost:8080/?record=1   (start this first, then demo/scenes.sh)
// scene.txt is one JSON line {"caption","focus"}; plain text is accepted as a caption with no focus. A focus
// of sale:N, claim:N or addr:0x… scrolls that card into view and outlines it. Recording stops at caption END.
import { chromium } from "playwright";
import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_URL = process.argv[2];
if (!PAGE_URL) {
  console.error("usage: node demo/record.mjs <page url>\n  e.g. node demo/record.mjs http://localhost:8080/?record=1   (the page served from docs/)");
  process.exit(2);
}
const here = new URL(".", import.meta.url).pathname;
const OUT = join(here, "out"); mkdirSync(OUT, { recursive: true });
const LOGS = join(here, "logs");
const SCENE = join(here, "scene.txt");
const TIMELINE = join(here, "timeline.json");
const MAX_LINES = 24;
const OVERLAY_W = 520;        // the log column; header and main are padded by this so it covers nothing
const HIGHLIGHT_MS = 5000;    // how long a focused card keeps its outline
const FOCUS_WAIT_MS = 20000;  // how long to keep looking for a focused card the page has not rendered yet
const SELLER_ROLES = new Set(["seller", "rogue", "newcomer", "quiet"]);
const HIDDEN_FOR_SELLERS = new Set(["a", "b", "answers", "truth"]);

// Nothing from an earlier run may reach this recording: old agent logs would fill the overlay until scenes.sh
// clears them, a stale END would stop it at once, and a stale timeline would skew the cut.
mkdirSync(LOGS, { recursive: true });
for (const f of readdirSync(LOGS)) if (f.endsWith(".log")) unlinkSync(join(LOGS, f));
writeFileSync(SCENE, "");
if (existsSync(TIMELINE)) unlinkSync(TIMELINE);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
// The video starts with the page, so cut.sh aligns caption timestamps to this moment, taken before any load.
writeFileSync(join(OUT, "record-start.json"), JSON.stringify({ t: Date.now() / 1000 }) + "\n");
await page.goto(PAGE_URL, { waitUntil: "networkidle" });
await page.addStyleTag({ content: `
  #cap { position:fixed; left:0; right:0; bottom:0; padding:14px 28px; background:rgba(8,10,13,.94); color:#fff; font:600 18px/1.4 ui-sans-serif,system-ui; border-top:1px solid #333; z-index:99999 }
  #logs { position:fixed; right:0; top:0; width:${OVERLAY_W}px; height:calc(100% - 70px); overflow:hidden; background:rgba(8,10,13,.92); color:#cfd6dd; font:12px/1.35 ui-monospace,Menlo,monospace; padding:10px 12px; border-left:1px solid #333; z-index:99998; white-space:pre-wrap }
  #logs b { color:#7ab8ff }
  header, main, footer { padding-right:${OVERLAY_W + 20}px !important }
  body { padding-bottom:110px }` });
await page.evaluate(() => {
  for (const id of ["cap", "logs"]) { const d = document.createElement("div"); d.id = id; document.body.appendChild(d); }
  const s = document.createElement("style"); s.id = "focus-style"; document.head.appendChild(s);
});

const tail = (file, n) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").slice(-n) : [];
const hidden = (role, key) => SELLER_ROLES.has(role) && (HIDDEN_FOR_SELLERS.has(key) || /pair/i.test(key));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// A value on one overlay line: a URL by its tail, a nested object or array as JSON, anything else as text.
function show(v) {
  if (typeof v === "string" && v.startsWith("http")) return v.split("/").pop().slice(0, 10) + "…";
  const s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}
function fmt(line) {
  try { const o = JSON.parse(line); const { t, role, event, ...rest } = o;
    const short = Object.entries(rest).filter(([k]) => !hidden(role, k)).map(([k, v]) => `${esc(k)}=${esc(show(v))}`).join(" ");
    return `<b>${esc(role)}</b> ${esc(event)}  ${short}`; } catch { return esc(line); }
}
// scene.txt: one JSON line, or plain text from an older writer.
function readScene() {
  const raw = existsSync(SCENE) ? readFileSync(SCENE, "utf8").trim() : "";
  if (!raw) return { caption: "", focus: "" };
  try { const o = JSON.parse(raw); if (o && typeof o === "object") return { caption: String(o.caption ?? ""), focus: String(o.focus ?? "") }; } catch { /* plain text */ }
  return { caption: raw, focus: "" };
}
// The card a focus names, as a selector on the page's own data attributes; anything malformed focuses nothing.
function selectorFor(focus) {
  const m = /^(sale|claim|addr):(.+)$/.exec(focus.trim());
  if (!m) return "";
  const v = m[2].trim().toLowerCase();
  return /^[0-9a-z]+$/.test(v) ? `[data-${m[1]}="${v}"]` : "";
}
// Scrolls the card into view and outlines it. The outline is a stylesheet rule keyed on the selector, so the
// page's own refresh (which rebuilds the cards) keeps it until the rule is cleared. Returns whether it was found.
const focusOn = (sel) => page.evaluate((sel) => {
  const el = sel ? document.querySelector(sel) : null;
  document.getElementById("focus-style").textContent = el ? `${sel} { outline:3px solid #7ab8ff; outline-offset:3px; box-shadow:0 0 0 6px rgba(122,184,255,.25) }` : "";
  if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
  return !!el;
}, sel);

let last = "", lastFocus = "", pending = null, highlightUntil = 0;
while (true) {
  const { caption, focus } = readScene();
  if (caption === "END") break;   // scene.txt was emptied above, so an END here is this run's
  if (focus !== lastFocus) {
    lastFocus = focus;
    pending = focus ? { sel: selectorFor(focus), since: Date.now() } : null;
    if (!pending) { highlightUntil = 0; await focusOn(""); }
  }
  if (pending) {
    // The page refreshes every few seconds, so a card the caption names may appear a moment after the caption.
    if (pending.sel && await focusOn(pending.sel)) { highlightUntil = Date.now() + HIGHLIGHT_MS; pending = null; }
    else if (!pending.sel || Date.now() - pending.since > FOCUS_WAIT_MS) pending = null;
  } else if (highlightUntil && Date.now() > highlightUntil) { highlightUntil = 0; await focusOn(""); }
  const lines = existsSync(LOGS) ? readdirSync(LOGS).filter(f => f.endsWith(".log")).flatMap(f => tail(join(LOGS, f), 40)) : [];
  lines.sort();
  const html = lines.slice(-MAX_LINES).map(fmt).join("\n");
  if (caption + html !== last) { await page.evaluate(([c, h]) => { document.getElementById("cap").textContent = c; document.getElementById("logs").innerHTML = h; }, [caption, html]); last = caption + html; }
  await page.waitForTimeout(700);
}
await page.waitForTimeout(2500);
await ctx.close(); await browser.close();
// The newest video that is not an earlier run's raw.webm is this run's.
const webm = readdirSync(OUT).filter(f => f.endsWith(".webm") && f !== "raw.webm")
  .map(f => [f, statSync(join(OUT, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0]?.[0];
if (!webm) throw new Error("no video was written under demo/out");
renameSync(join(OUT, webm), join(OUT, "raw.webm"));
console.log("recorded demo/out/raw.webm");
