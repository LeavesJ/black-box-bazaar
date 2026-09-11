// demo/record.mjs — records the page while scenes.sh runs, and overlays the demo's furniture on top of it:
// a scene badge, a step tracker, a callout (outline + label tag) on the card each caption is about, the caption
// bar with its note, a title card per scene, and the agent log panel. Everything is injected here; app.js only
// honours ?record=1. Seller-side log lines never show the pair (a, b, answers, truth, pair), so nothing leaks.
// Usage: node demo/record.mjs http://localhost:8080/?record=1   (start this first, then demo/scenes.sh)
// scene.txt is one JSON line: {"caption","note","focus","label","color","step","scene","title","subtitle","goto"};
// plain text is still accepted as a bare caption. A focus of sale:N, claim:N or addr:0x… scrolls that card into
// view and outlines it until the next focus. A title covers the page with a card for TITLE_MS. A goto navigates
// the page (the epilogue) and re-injects the overlays. Recording stops at caption END.
import { chromium } from "playwright";
import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_URL = process.argv[2];
if (!PAGE_URL) {
  console.error("usage: node demo/record.mjs <page url> [--check [out.png]]\n  e.g. node demo/record.mjs http://localhost:8080/?record=1   (the page served from docs/)\n  --check: no recording; overlays a sample title card, tracker, callout, caption and log lines, screenshots, exits");
  process.exit(2);
}
// --check <png>: the overlays on a fake sale card, screenshotted through the same code the recording uses.
const here = new URL(".", import.meta.url).pathname;
const OUT = join(here, "out"); mkdirSync(OUT, { recursive: true });
const CHECK = process.argv[3] === "--check" ? (process.argv[4] || join(OUT, "treatment-check.png")) : "";
const LOGS = join(here, "logs");
const SCENE = join(here, "scene.txt");
const TIMELINE = join(here, "timeline.json");
const MAX_LINES = 22;         // log panel lines; the newest are pinned to the bottom, older ones clip off the top
const OVERLAY_W = 520;        // the log column; the page, the top strip and the caption bar all stop short of it
const TOP_H = 52;             // the strip holding the badge and the tracker; the page is pushed down by it
const CAP_H = 130;            // room kept under the page for the caption bar
const TITLE_MS = 3500;        // how long a title card covers the page
const FOCUS_WAIT_MS = 20000;  // how long to keep looking for a focused card the page has not rendered yet
const NAV_TIMEOUT_MS = 15000; // a goto waits for networkidle at most this long, then carries on regardless
const POLL_MS = 700;
const SELLER_ROLES = new Set(["seller", "rogue", "newcomer", "quiet"]);
const HIDDEN_FOR_SELLERS = new Set(["a", "b", "answers", "truth"]);
const COLORS = { blue: "#7ab8ff", green: "#3ddc97", red: "#ff6b6b", orange: "#ffa657", grey: "#9aa4af", purple: "#c79bff", amber: "#ffc857" };
const ROLE_COLOR = { buyer: "blue", seller: "green", rogue: "red", newcomer: "orange", quiet: "grey", arbiter: "purple", sweep: "amber" };
const SCENE_COLOR = { 1: "green", 2: "red", 3: "orange", 4: "grey" };   // the badge: the colour of each scene's seller
const STEPS = [["claim", "Claim"], ["commit", "Commit"], ["reveal", "Reveal"], ["adjudicate", "Adjudicate"], ["dispute", "Dispute & Rule"], ["settle", "Settle"]];
const STEP_INDEX = { claim: 0, commit: 1, reveal: 2, adjudicate: 3, dispute: 4, rule: 4, settle: 5 };
const colorOf = (name) => COLORS[name] || COLORS.grey;

// Nothing from an earlier run may reach this recording: old agent logs would fill the overlay until scenes.sh
// clears them, a stale END would stop it at once, and a stale timeline would skew the cut.
if (!CHECK) {
  mkdirSync(LOGS, { recursive: true });
  for (const f of readdirSync(LOGS)) if (f.endsWith(".log")) unlinkSync(join(LOGS, f));
  writeFileSync(SCENE, "");
  if (existsSync(TIMELINE)) unlinkSync(TIMELINE);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(CHECK ? {} : { recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } }) });
const page = await ctx.newPage();
// The video starts with the page, so cut.sh aligns caption timestamps to this moment, taken before any load.
if (!CHECK) writeFileSync(join(OUT, "record-start.json"), JSON.stringify({ t: Date.now() / 1000 }) + "\n");
await page.goto(PAGE_URL, { waitUntil: "networkidle" });

const FONT = `ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;
const CSS = `
  #bbb-top { position:fixed; left:0; top:0; width:calc(100% - ${OVERLAY_W}px); height:${TOP_H}px; display:flex; align-items:center; padding:0 28px; background:rgba(8,10,13,.95); border-bottom:1px solid #2a3139; z-index:2147483000; font-family:${FONT} }
  #bbb-badge { font:700 13px/1 ${FONT}; letter-spacing:1.4px; padding:7px 10px 6px; border:1.5px solid currentColor; border-radius:4px; color:#9aa4af; white-space:nowrap }
  #bbb-track { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:flex; gap:8px }
  #bbb-track span { font:600 13px/1 ${FONT}; padding:7px 12px 6px; border-radius:999px; border:1.5px solid #3a434d; color:#8a94a0; white-space:nowrap }
  #bbb-track span.done { background:rgba(255,255,255,.13); border-color:transparent; color:#d7dde3 }
  #bbb-track span.now { border-color:transparent; color:#0b0d10 }
  #bbb-cap { position:fixed; left:0; bottom:0; width:calc(100% - ${OVERLAY_W}px); min-height:${CAP_H - 30}px; padding:16px 28px 18px; background:rgba(8,10,13,.95); border-top:1px solid #2a3139; z-index:2147483000 }
  #bbb-cap .text { font:600 24px/1.35 ${FONT}; color:#fff; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-align:left }
  #bbb-cap .note { font:italic 400 16px/1.4 ${FONT}; color:#8a94a0; margin-top:6px; text-align:left }
  #bbb-cap .note:empty { display:none }
  #bbb-logs { position:fixed; right:0; top:0; width:${OVERLAY_W}px; height:100%; overflow:hidden; display:flex; flex-direction:column; justify-content:flex-end; background:rgba(8,10,13,.93); color:#cfd6dd; font:13px/1.4 ui-monospace,Menlo,monospace; padding:10px 12px; border-left:1px solid #2a3139; z-index:2147482999 }
  #bbb-logs .lines { white-space:pre-wrap; word-break:break-word }
  #bbb-logs b { font-weight:700 }
  #bbb-tag { position:fixed; z-index:2147483001; font:700 12px/1 ${FONT}; letter-spacing:.9px; text-transform:uppercase; padding:5px 8px 4px; border-radius:4px 4px 0 0; color:#0b0d10; pointer-events:none; white-space:nowrap }
  #bbb-card { position:fixed; inset:0; z-index:2147483002; background:#07090b; display:flex; flex-direction:column; justify-content:center; align-items:flex-start; padding:0 140px; gap:16px }
  #bbb-card .t { font:700 44px/1.2 ${FONT}; color:#fff; letter-spacing:-.3px }
  #bbb-card .s { font:400 22px/1.45 ${FONT}; color:#9aa4af; max-width:980px }
  html.bbb-page body { padding-top:${TOP_H}px !important; padding-bottom:${CAP_H}px !important }
  html.bbb-page header, html.bbb-page main, html.bbb-page footer { padding-right:${OVERLAY_W + 20}px !important }
  html.bbb-ext #bbb-logs { display:none }
  html.bbb-ext #bbb-top, html.bbb-ext #bbb-cap { width:100% }
  html.bbb-ext body { padding-top:${TOP_H}px !important; padding-bottom:${CAP_H}px !important }`;

// Creates the overlay elements if the page does not have them (after a goto it does not). Idempotent.
async function inject(external) {
  await page.evaluate(([css, external, steps]) => {
    document.documentElement.classList.toggle("bbb-ext", !!external);
    document.documentElement.classList.toggle("bbb-page", !external);
    if (!document.getElementById("bbb-css")) { const s = document.createElement("style"); s.id = "bbb-css"; s.textContent = css; document.head.appendChild(s); }
    if (!document.getElementById("bbb-focus")) { const s = document.createElement("style"); s.id = "bbb-focus"; document.head.appendChild(s); }
    const mk = (id, html) => { let d = document.getElementById(id); if (!d) { d = document.createElement("div"); d.id = id; d.innerHTML = html; document.body.appendChild(d); } return d; };
    mk("bbb-top", `<span id="bbb-badge" hidden></span><span id="bbb-track" hidden>${steps.map(([k, t]) => `<span data-step="${k}">${t}</span>`).join("")}</span>`);
    mk("bbb-logs", `<div class="lines"></div>`);
    mk("bbb-cap", `<div class="text"></div><div class="note"></div>`);
    mk("bbb-tag", "").hidden = true;
  }, [CSS, !!external, STEPS]);
}
await inject(false);

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
    return `<b style="color:${colorOf(ROLE_COLOR[role])}">${esc(role)}</b> ${esc(event)}  ${short}`; } catch { return esc(line); }
}
// scene.txt: one JSON line, or plain text from an older writer. Every field is normalised to a string or number.
function readScene() {
  const raw = existsSync(SCENE) ? readFileSync(SCENE, "utf8").trim() : "";
  const line = { caption: "", note: "", focus: "", label: "", color: "", step: "", scene: 0, title: "", subtitle: "", goto: "" };
  if (!raw) return line;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      for (const k of Object.keys(line)) if (o[k] !== undefined && o[k] !== null) line[k] = k === "scene" ? Number(o[k]) || 0 : String(o[k]);
      return line;
    }
  } catch { /* plain text */ }
  line.caption = raw;
  return line;
}
// The card a focus names, as a selector on the page's own data attributes; anything malformed focuses nothing.
function selectorFor(focus) {
  const m = /^(sale|claim|addr):(.+)$/.exec(focus.trim());
  if (!m) return "";
  const v = m[2].trim().toLowerCase();
  return /^[0-9a-z]+$/.test(v) ? `[data-${m[1]}="${v}"]` : "";
}
// Outlines the card (a stylesheet rule keyed on the selector, so the page's own refresh, which rebuilds the
// cards, keeps it), scrolls it to the centre when asked, and pins the label tag to its top-left corner. The tag is
// re-placed on every poll because cards move when a newer sale is inserted above them. Returns whether it was found.
const focusOn = (sel, color, label, scroll) => page.evaluate(([sel, color, label, scroll, topH]) => {
  const el = sel ? document.querySelector(sel) : null;
  const style = document.getElementById("bbb-focus"), tag = document.getElementById("bbb-tag");
  if (!style || !tag) return false;
  style.textContent = el ? `${sel} { outline:3px solid ${color}; outline-offset:3px; box-shadow:0 0 22px ${color}55 }` : "";
  if (el && scroll) el.scrollIntoView({ block: "center", behavior: "instant" });
  if (el && label) {
    tag.textContent = label; tag.style.background = color; tag.hidden = false;
    const r = el.getBoundingClientRect(), h = tag.offsetHeight || 21;
    const top = r.top - 6 - h;   // sits on the outline's outer edge, above the card
    tag.style.left = `${Math.max(0, r.left - 6)}px`;
    tag.style.top = `${top < topH ? r.top - 3 : top}px`;
  } else tag.hidden = true;
  return !!el;
}, [sel, color, label, !!scroll, TOP_H]);

// Everything the badge, tracker, caption bar and title card show for one scene line.
const apply = (line, showCard) => page.evaluate(([line, colors, sceneColors, stepIndex, showCard]) => {
  const $ = (id) => document.getElementById(id);
  const color = colors[line.color] || colors.grey;
  const badge = $("bbb-badge"), track = $("bbb-track"), cap = $("bbb-cap");
  if (!badge || !track || !cap) return;
  const inScene = line.scene >= 1 && line.scene <= 4;
  badge.hidden = !inScene; track.hidden = !inScene;
  if (inScene) { badge.textContent = `SCENE ${line.scene} / 4`; badge.style.color = colors[sceneColors[line.scene]] || colors.grey; }
  const cur = line.step in stepIndex ? stepIndex[line.step] : -1;
  for (const pill of track.children) {
    const i = stepIndex[pill.dataset.step];
    pill.className = i === cur ? "now" : (cur >= 0 && i < cur ? "done" : "");
    pill.style.background = i === cur ? color : "";
  }
  cap.querySelector(".text").textContent = line.caption;
  cap.querySelector(".note").textContent = line.note;
  let card = $("bbb-card");
  if (showCard) {
    if (!card) { card = document.createElement("div"); card.id = "bbb-card"; document.body.appendChild(card); }
    card.innerHTML = `<div class="t"></div><div class="s"></div>`;
    card.querySelector(".t").textContent = line.title; card.querySelector(".s").textContent = line.subtitle;
  }
}, [line, COLORS, SCENE_COLOR, STEP_INDEX, !!showCard]);
const dropCard = () => page.evaluate(() => document.getElementById("bbb-card")?.remove());

if (CHECK) {
  // A fake sale card beside the page's own (which the page rebuilds, so the fake one sits after that container),
  // sample log lines in every role, a title card, then the reveal step with its callout, caption and note.
  await page.evaluate(() => {
    const sales = document.getElementById("sales"); if (!sales) return;
    const fake = document.createElement("div"); fake.className = "card"; fake.setAttribute("data-sale", "0");
    fake.innerHTML = `<div class="row"><b>Sale #0 <span class="muted">on claim #0</span></b><span><span class="badge Revealed">Revealed</span></span></div>
      <div class="muted">seller <span class="mono">0x3C44…93BC</span> · bond 0.0001 ETH</div><div class="mono muted" style="margin-top:4px">commit 0x9f1c…e2a7</div>
      <div class="ct mono">reveal (encrypted to buyer): 0x04a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f50617283940a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394</div>
      <ul class="tl"><li><span class="ev Committed">Committed</span><span>sale #0 on claim #0 · bond 0.0001 ETH <span class="when">#17</span></span><span class="mono">0x8a2f…11c0</span></li>
      <li><span class="ev Revealed">Revealed</span><span>sale #0 · 121 bytes encrypted to the buyer <span class="when">#19</span></span><span class="mono">0x5b7e…9a44</span></li></ul>`;
    sales.insertAdjacentElement("afterend", fake);
  });
  const sample = [
    { role: "arbiter", event: "watching for disclosed disputes", seconds: 900 }, { role: "sweep", event: "sweeping", from: "0x7479cF34…719E9", seconds: 900 },
    { role: "buyer", event: "claim posted", claimId: "0", tx: "https://x/tx/0x09c4c171747f1d07a6" }, { role: "seller", event: "hunting", claimId: "0", max: 1, attack: "none", budget: 40 },
    { role: "seller", event: "probe", a: 930, b: 415, wrong: 3, runs: 3, truth: "385950", answers: ["386,050"], tries: 1 }, { role: "seller", event: "counterexample found", a: 930, b: 415, tries: 1 },
    { role: "seller", event: "committed", saleId: "0", claimId: "0", hash: "0xc4477b049feb3b17b9878453", bond: "100000000000" }, { role: "seller", event: "revealed", saleId: "0", bytes: 121 },
    { role: "buyer", event: "re-running", saleId: "0", a: 930, b: 415, runs: 3 }, { role: "rogue", event: "hunting", claimId: "0", attack: "plant" },
    { role: "newcomer", event: "hunting", claimId: "0", attack: "garbage" }, { role: "quiet", event: "hunting", claimId: "1", attack: "none" },
  ].map((o, i) => JSON.stringify({ t: `2026-09-11T07:42:${String(40 + i).padStart(2, "0")}.000Z`, ...o }));
  await page.evaluate((h) => { document.querySelector("#bbb-logs .lines").innerHTML = h; }, sample.map(fmt).join("\n"));
  const card = { caption: "", note: "", focus: "", label: "", color: "", step: "", scene: 1, title: "Scene 1 · An honest sale", subtitle: "The buyer posts a claim. The seller finds a counterexample. The buyer checks it and pays.", goto: "" };
  await apply(card, true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: CHECK.replace(/\.png$/, "") + "-card.png" });
  await dropCard();
  const line = { caption: "The seller reveals the pair, encrypted to the buyer's key. Only the buyer can read it. This line is long enough to wrap onto a second line.", note: "Confirmed means the buyer checked. That is the only way this number moves.", focus: "sale:0", label: "SALE #0", color: "green", step: "reveal", scene: 1, title: "", subtitle: "", goto: "" };
  await apply(line, false);
  const found = await focusOn(selectorFor(line.focus), colorOf(line.color), line.label, true);
  await page.waitForTimeout(300);
  await focusOn(selectorFor(line.focus), colorOf(line.color), line.label, false);   // re-place the tag after the scroll
  await page.screenshot({ path: CHECK });
  console.log(`check: fake card found=${found}; wrote ${CHECK} and ${CHECK.replace(/\.png$/, "")}-card.png`);
  await ctx.close(); await browser.close();
  process.exit(0);
}

let lastKey = "", lastHtml = "", lastFocusKey = "", lastFocus = "", pending = null, cardUntil = 0, external = false, current = readScene();
while (true) {
  const line = readScene();
  if (line.caption === "END") break;   // scene.txt was emptied above, so an END here is this run's
  const key = JSON.stringify(line);
  try {
    if (key !== lastKey) {
      lastKey = key; current = line;
      if (line.goto) {
        // The epilogue: the same overlays on a page this recorder did not serve. A slow or refused load is not fatal.
        await page.goto(line.goto, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS }).catch(() => {});
        external = true; await inject(true);
      }
      const withCard = !!line.title;
      await apply(line, withCard);
      if (withCard) cardUntil = Date.now() + TITLE_MS;
    }
    if (cardUntil && Date.now() >= cardUntil) { cardUntil = 0; await dropCard(); }
    // The callout follows the focus, and re-colours when the same card gets a new label or colour; it scrolls only on
    // a change of card. The page refreshes every few seconds, so a card the caption names may appear a moment later.
    const focusKey = `${current.focus}|${current.color}|${current.label}`;
    if (focusKey !== lastFocusKey) {
      lastFocusKey = focusKey;
      const scroll = current.focus !== lastFocus; lastFocus = current.focus;
      pending = current.focus ? { sel: selectorFor(current.focus), since: Date.now(), scroll } : null;
      if (!pending) await focusOn("", "", "", false);
    }
    if (pending) {
      if (pending.sel && await focusOn(pending.sel, colorOf(current.color), current.label, pending.scroll)) { pending.since = Date.now(); pending.scroll = false; }
      else if (!pending.sel || Date.now() - pending.since > FOCUS_WAIT_MS) pending = null;
    }
    if (!external) {
      const lines = existsSync(LOGS) ? readdirSync(LOGS).filter(f => f.endsWith(".log")).flatMap(f => tail(join(LOGS, f), 40)) : [];
      lines.sort();
      const html = lines.slice(-MAX_LINES).map(fmt).join("\n");
      if (html !== lastHtml) { await page.evaluate((h) => { const l = document.querySelector("#bbb-logs .lines"); if (l) l.innerHTML = h; }, html); lastHtml = html; }
    }
  } catch (e) {
    // An external page that navigated itself drops the overlays; put them back and carry on.
    console.error("overlay update failed, re-injecting:", String(e.message || e).split("\n")[0]);
    await inject(external).catch(() => {});
    lastKey = ""; lastHtml = ""; lastFocusKey = ""; lastFocus = "";
  }
  await page.waitForTimeout(POLL_MS);
}
await page.waitForTimeout(2500);
await ctx.close(); await browser.close();
// The newest video that is not an earlier run's raw.webm is this run's.
const webm = readdirSync(OUT).filter(f => f.endsWith(".webm") && f !== "raw.webm")
  .map(f => [f, statSync(join(OUT, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0]?.[0];
if (!webm) throw new Error("no video was written under demo/out");
renameSync(join(OUT, webm), join(OUT, "raw.webm"));
console.log("recorded demo/out/raw.webm");
