// docs/present.js — the step presenter behind ?present=1 (app.js loads it), driven by demo/console.mjs.
// The deck is a linear list of steps from /api/deck: slides, scene cards and live steps. A live step is one
// on-chain moment on this very page, under the overlays the recorded video uses (overlay.js: scene badge, step
// tracker, callout, caption bar, agents' log). Walk it with the large ◀ ▶ buttons or the keyboard: → Space
// PageDown Enter go next, ← PageUp go back, N toggles the notes. ▶ at the head posts /api/next, which runs exactly
// one step; ◀ walks back through what was already shown without undoing anything, and ▶ from there walks forward
// through that history with no server call. The right column is the presenter's: notes for the step on screen and
// what the next ▶ does, the agents' log, and the navigation pinned at its bottom. Slides and cards cover the left
// area only, so the column stays in view. Nothing here writes to the chain; the page keeps reading it on its own.
const API = "/api";
const POLL_MS = 600;
const ACCENT = "#7ab8ff";                   // kickers and bullet marks on slides; a scene card takes its scene's colour
const ROLE_NAME = { buyer: "Buyer", seller: "Seller", rogue: "Rogue", newcomer: "Newcomer", arbiter: "Arbiter", sweep: "Sweep" };   // a flow box's actor; a grey (quiet) box names nobody
const GRID_COLORS = ["blue", "purple", "green", "amber"];
const NOT_ANSWERING = "demo/console.mjs is not answering. Start it from the repository root:\n  node demo/console.mjs";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stored = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* no storage here */ } return null; };

// overlay.js is a classic script that defines window.BBB, so the recorder can inject the same file anywhere.
await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "./overlay.js"; s.onload = ok; s.onerror = () => no(new Error("overlay.js failed to load")); document.head.appendChild(s); });
const BBB = window.BBB;
BBB.install({ present: true });
const F = BBB.FONT, W = BBB.OVERLAY_W, MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
const hue = (name) => BBB.colorOf(BBB.ROLE_COLOR[name] || name);   // a role or a palette name
const px = (n) => `calc(${n}px * var(--s))`;                        // slide sizes scale with the left area (fit())

const css = document.createElement("style");
css.textContent = `
  #bbb-col { position:fixed; right:0; top:0; width:${W}px; height:100%; z-index:2147483004; display:flex; flex-direction:column; background:#0b0e12; border-left:1px solid #2a3139; color:#e6e9ec; font:15px/1.45 ${F} }
  #bbb-col button, #bbb-cap button { font-family:${F}; cursor:pointer }
  #bbb-notes { flex:0 1 auto; max-height:50%; overflow:auto; padding:14px 20px 16px; background:#0f1318; border-bottom:1px solid #2a3139 }
  html.bbb-notes-off #bbb-notes { display:none }
  .bbb-hd { display:flex; align-items:center; gap:10px; margin-bottom:12px }
  .bbb-hd b, .bbb-lh { font:700 12px/1 ${F}; letter-spacing:1.6px; text-transform:uppercase; color:#8a94a0 }
  #bbb-mk { flex:1; min-width:0; font:12px ${MONO}; color:#5f6873; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:right }
  #bbb-reset { flex:none; padding:6px 10px; border-radius:6px; border:1px solid #3a434d; background:none; color:#9aa4af; font:600 12px/1 ${F} }
  #bbb-reset:hover:not(:disabled) { color:#fff; border-color:#6b7580 } #bbb-reset:disabled { opacity:.4; cursor:default }
  #bbb-say { list-style:none; margin:0; padding:0 }
  #bbb-say li { position:relative; padding:0 0 9px 20px; font:400 17px/1.45 ${F} }
  #bbb-say li::before { content:""; position:absolute; left:3px; top:.62em; width:7px; height:7px; border-radius:50%; background:var(--acc) }
  #bbb-upnext { margin-top:4px; padding-top:12px; border-top:1px dashed #2a3139; font:600 17px/1.35 ${F}; color:#fff }
  #bbb-upnext b { display:block; margin-bottom:6px; font:700 12px/1 ${F}; letter-spacing:1.6px; color:#3ddc97 }
  #bbb-held { margin-top:8px; font:13px/1.5 ${MONO}; color:#8a94a0 }
  #bbb-msg { margin-top:10px; font:14px/1.45 ${F}; color:#ff6b6b; white-space:pre-wrap }
  #bbb-held:empty, #bbb-msg:empty { display:none }
  .bbb-lh { padding:12px 16px 2px }
  html.bbb-present #bbb-logs { position:relative; inset:auto; width:auto; height:auto; flex:1 1 0; min-height:0; border:0; background:none; padding:4px 16px 10px; z-index:auto;
    -webkit-mask-image:linear-gradient(to bottom, transparent 0, #000 40px); mask-image:linear-gradient(to bottom, transparent 0, #000 40px) }
  #bbb-nav { flex:none; padding:14px 16px; background:#0f1318; border-top:1px solid #2a3139 }
  #bbb-nav .meta { display:flex; justify-content:space-between; gap:12px; margin-bottom:9px; font:700 13px/1.2 ${F}; letter-spacing:1.2px; text-transform:uppercase; color:#9aa4af; white-space:nowrap }
  #bbb-scene { overflow:hidden; text-overflow:ellipsis }
  #bbb-bar { position:relative; height:4px; margin-bottom:12px; border-radius:2px; background:#1c232b; overflow:hidden }
  #bbb-bar i, #bbb-bar u { position:absolute; left:0; top:0; bottom:0; border-radius:2px; transition:width .2s }
  #bbb-bar i { background:#3a434d } #bbb-bar u { background:#3ddc97 }
  #bbb-nav .btns { display:flex; gap:12px }
  #bbb-nav .btns button { height:88px; border:0; border-radius:14px; display:flex; align-items:center; transition:background .12s }
  #bbb-prev { flex:none; width:104px; justify-content:center; background:#1f2730; color:#e6e9ec }
  #bbb-next { flex:1; min-width:0; gap:16px; padding:0 22px; background:#3ddc97; color:#06120c; text-align:left }
  #bbb-prev:hover:not(:disabled) { background:#2a343f } #bbb-next:hover:not(:disabled) { background:#5ce8ab }
  #bbb-next .l { min-width:0; font:700 21px/1.2 ${F} }
  #bbb-next .l i { font-style:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden }   /* the label clamps on its own, so NEXT above it is not one of its two lines */
  #bbb-next small { display:block; margin-bottom:5px; font:700 12px/1 ${F}; letter-spacing:1.6px; text-transform:uppercase; opacity:.7 }
  #bbb-nav .btns button:disabled { background:#161b21; color:#56606b; cursor:default }
  #bbb-nav #bbb-next.busy:disabled { background:#241f0d; color:#ffc857 }
  #bbb-nav svg { flex:none; width:36px; height:36px }
  #bbb-nav .keys { margin-top:10px; font:12.5px/1 ${F}; color:#5f6873; text-align:center }
  .bbb-spin { flex:none; display:inline-block; width:1em; height:1em; box-sizing:border-box; border:.15em solid currentColor; border-right-color:transparent; border-radius:50%; animation:bbb-rot .8s linear infinite }
  #bbb-next .bbb-spin { width:32px; height:32px; border-width:4px; margin:0 2px }
  @keyframes bbb-rot { to { transform:rotate(360deg) } }
  html.bbb-present #bbb-cap .text { -webkit-line-clamp:3 }
  html.bbb-present #bbb-top, html.bbb-present #bbb-cap { background:#080a0d }   /* opaque here: page text scrolled beneath never shows beside a caption */
  @media (max-width:1340px) {   /* a narrow left area (1280 wide): the page's three columns would run under this column */
    html.bbb-present #bbb-track { left:auto; right:20px; transform:translateY(-50%); gap:6px }   /* right of the badge, not under it */
    html.bbb-present #bbb-track span { font-size:12px; padding:6px 9px 5px }
    html.bbb-present #bbb-cap .text { font-size:22px }
    html.bbb-present main { grid-template-columns:minmax(0,1.3fr) minmax(0,1fr); grid-template-rows:auto 1fr }
    html.bbb-present main > section:nth-child(1) { grid-column:2; grid-row:1 }       /* claims, above */
    html.bbb-present main > section:nth-child(2) { grid-column:1; grid-row:1 / span 2 } /* sales, the long one */
    html.bbb-present main > section:nth-child(3) { grid-column:2; grid-row:2 } }     /* settlement history, below */
  #bbb-cap .bbb-st { display:flex; align-items:center; gap:12px; margin-top:8px; font:600 17px/1.35 ${F}; color:#ffc857 }
  #bbb-cap .bbb-st:empty { display:none }
  #bbb-cap .bbb-st.fail { color:#ff6b6b }
  #bbb-cap .bbb-st .e { flex:1; min-width:0; font:500 15px/1.4 ${F}; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word }
  #bbb-cap .bbb-st button { flex:none; padding:12px 24px; border:0; border-radius:10px; background:#ff6b6b; color:#1a0707; font:700 17px/1 ${F} }
  #bbb-cap .bbb-st button:disabled { opacity:.5; cursor:default }
  #bbb-hist { position:fixed; left:0; top:0; width:calc(100% - ${W}px); height:${BBB.TOP_H}px; z-index:2147483003; display:flex; align-items:center; gap:12px; padding:0 28px; box-sizing:border-box; background:#1f1906; border-bottom:2px solid #ffc857; color:#ffc857; font:600 17px/1.2 ${F}; cursor:pointer }
  #bbb-slide { position:fixed; left:0; top:0; bottom:0; width:calc(100% - ${W}px); z-index:2147483002; background:#07090b; color:#e6e9ec; overflow:hidden }
  #bbb-slide[hidden], #bbb-hist[hidden] { display:none !important }
  #bbb-slide .in { --s:1; position:absolute; inset:0; display:flex; flex-direction:column; padding:${px(76)} ${px(76)} ${px(58)}; box-sizing:border-box; overflow:hidden; font-family:${F} }
  #bbb-slide .L-title .main, #bbb-slide .L-card .main, #bbb-slide .L-end .main { margin:auto 0 }
  #bbb-slide .k { margin-bottom:${px(18)}; font:700 ${px(15)}/1.3 ${F}; letter-spacing:2.2px; text-transform:uppercase; color:var(--acc) }
  #bbb-slide h1 { margin:0; font:700 ${px(44)}/1.14 ${F}; letter-spacing:-.5px; color:#fff; max-width:21em }
  #bbb-slide .L-title h1, #bbb-slide .L-end h1 { font-size:${px(48)} }
  #bbb-slide .sub { margin-top:${px(14)}; font:400 ${px(28)}/1.35 ${F}; color:#9aa4af; max-width:30em }
  #bbb-slide .L-card .sub { font-size:${px(24)}; line-height:1.45 }
  #bbb-slide .body { margin-top:${px(30)}; font:400 ${px(23)}/1.5 ${F}; color:#cfd6dd; max-width:31em }
  #bbb-slide ul { list-style:none; margin:${px(36)} 0 0; padding:0 }
  #bbb-slide li { position:relative; margin-bottom:${px(20)}; padding-left:${px(34)}; font:400 ${px(24)}/1.42 ${F}; max-width:33em }
  #bbb-slide li::before { content:""; position:absolute; left:0; top:calc(.71em - ${px(6)}); width:${px(12)}; height:${px(12)}; border-radius:3px; background:var(--acc) }
  #bbb-slide .foot { margin-top:auto; padding-top:${px(26)}; font:400 ${px(19)}/1.45 ${F}; color:#8a94a0; max-width:40em }
  #bbb-slide .foot::before { content:""; display:block; width:${px(56)}; height:3px; margin-bottom:${px(14)}; border-radius:2px; background:var(--acc) }
  #bbb-slide .lg { display:grid; grid-template-columns:repeat(3, max-content); gap:${px(12)}; margin-top:${px(16)} }
  #bbb-slide .lg span { display:inline-flex; align-items:center; gap:${px(10)}; padding:${px(9)} ${px(16)}; border-radius:999px; border:1.5px solid var(--c); background:rgba(255,255,255,.03); font:600 ${px(19)}/1 ${F} }
  #bbb-slide .lg i { width:${px(11)}; height:${px(11)}; border-radius:50%; background:var(--c) }
  #bbb-slide .flow { position:relative; margin-top:${px(40)} }
  #bbb-slide .fr { display:flex; align-items:stretch }
  #bbb-slide .fr.o { margin-top:${px(70)}; gap:${px(20)} }
  #bbb-slide .bx { flex:1 1 0; min-width:0; padding:${px(14)} ${px(15)} ${px(16)}; border:1.5px solid var(--c); border-top-width:5px; border-radius:10px; background:rgba(255,255,255,.025) }
  #bbb-slide .bx em { display:block; min-height:1.2em; font:700 ${px(12.5)}/1.2 ${F}; font-style:normal; letter-spacing:1.4px; text-transform:uppercase; color:var(--c) }
  #bbb-slide .bx b { display:block; margin:${px(6)} 0; font:700 ${px(25)}/1.15 ${F}; color:#fff }
  #bbb-slide .bx span { display:block; font:400 ${px(16.5)}/1.38 ${F}; color:#b8c0c8 }
  #bbb-slide .ar { flex:none; width:${px(38)}; display:flex; align-items:center; justify-content:center }
  #bbb-slide .ar svg { width:100%; height:auto }
  #bbb-slide svg.lk { position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; overflow:visible }
  #bbb-slide table { margin-top:${px(34)}; width:100%; max-width:${px(900)}; border-collapse:collapse }
  #bbb-slide th { padding:0 ${px(18)} ${px(12)} 0; border-bottom:1.5px solid #3a434d; text-align:left; font:700 ${px(13.5)}/1.2 ${F}; letter-spacing:1.6px; text-transform:uppercase; color:#8a94a0 }
  #bbb-slide td { padding:${px(13)} ${px(18)} ${px(13)} 0; border-bottom:1px solid #1f262e; font:400 ${px(22)}/1.3 ${F}; color:#e6e9ec }
  #bbb-slide td.h { font-weight:700; color:var(--c); white-space:nowrap }
  #bbb-slide .gr { display:grid; grid-template-columns:1fr 1fr; gap:${px(18)}; margin-top:${px(30)} }
  #bbb-slide .gr div { padding:${px(18)} ${px(20)}; border:1px solid #232a32; border-top:4px solid var(--c); border-radius:10px; background:rgba(255,255,255,.025) }
  #bbb-slide .gr h3 { margin:0 0 ${px(8)}; font:700 ${px(21)}/1.2 ${F}; letter-spacing:0; text-transform:none; color:var(--c) }
  #bbb-slide .gr p { margin:0; font:400 ${px(18.5)}/1.45 ${F}; color:#cfd6dd }
  #bbb-slide dl { display:grid; grid-template-columns:auto 1fr; gap:${px(16)} ${px(28)}; margin:${px(42)} 0 0; align-items:baseline }
  #bbb-slide dt { font:700 ${px(13.5)}/1.2 ${F}; letter-spacing:1.6px; text-transform:uppercase; color:#8a94a0 }
  #bbb-slide dd { margin:0; font:500 ${px(21)}/1.35 ${MONO}; color:#e6e9ec; overflow-wrap:anywhere }
  #bbb-slide dd span { white-space:nowrap } #bbb-slide dd span + span { font-family:${F}; color:#8a94a0 }`;
document.head.appendChild(css);

// ---------- the furniture: the presenter column (notes, the agents' log, navigation), a slide, the history banner ----------
const PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5 19.5 12 7 20.5Z" fill="currentColor"/></svg>`;
const BACK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3.5 4.5 12 17 20.5Z" fill="currentColor"/></svg>`;
const col = document.createElement("div");
col.id = "bbb-col";
col.innerHTML = `<div id="bbb-notes"><div class="bbb-hd"><b>Notes</b><span id="bbb-mk"></span><button id="bbb-reset" type="button" title="Stop everything, start a fresh chain and go back to the first step">Reset chain</button></div>
    <ul id="bbb-say"></ul><div id="bbb-upnext"></div><div id="bbb-held"></div><div id="bbb-msg"></div></div>
  <div class="bbb-lh">Agents' log</div>
  <div id="bbb-nav"><div class="meta"><span id="bbb-count"></span><span id="bbb-scene"></span></div><div id="bbb-bar"><i></i><u></u></div>
    <div class="btns"><button id="bbb-prev" type="button" aria-label="Back" title="Back (← or PageUp)">${BACK}</button><button id="bbb-next" type="button" title="Next (→, Space, PageDown or Enter)"></button></div>
    <div class="keys">→ Space PageDown: next &nbsp;·&nbsp; ← PageUp: back &nbsp;·&nbsp; N: notes</div></div>`;
document.body.appendChild(col);
col.insertBefore($("bbb-logs"), $("bbb-nav"));   // setLogs finds it by id wherever it lives
const slide = document.createElement("div"); slide.id = "bbb-slide"; slide.hidden = true; document.body.appendChild(slide);
const hist = document.createElement("div"); hist.id = "bbb-hist"; hist.hidden = true; hist.title = "Return to the market's step"; document.body.appendChild(hist);
const stEl = document.createElement("div"); stEl.className = "bbb-st"; $("bbb-cap").appendChild(stEl);   // working / failed, under the caption
if (stored("bbb-notes") === "off") document.documentElement.classList.add("bbb-notes-off");

// ---------- state ----------
let deck = null, S = null, cursor = null;      // cursor: the step on screen, never above S.head
let busy = false, lost = false, resetting = false, sawBoot = false, msg = "", fetchedAt = 0;
let seq = 0, applied = 0, resetAfter = Infinity;
const shown = new Map();                        // what each element last showed, so a tick that changes nothing touches nothing
const put = (id, html) => { if (shown.get(id) !== html) { shown.set(id, html); $(id).innerHTML = html; } };

const get = (p) => fetch(API + p, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); });
const post = (p, body) => fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
  .then((r) => r.json()).catch((e) => ({ ok: false, error: String(e.message || e) }));

async function poll() {
  const my = ++seq;
  try {
    if (!deck) {
      const d = await get("/deck");
      if (!Array.isArray(d?.steps) || !d.steps.length) throw new Error("the deck is empty");
      deck = d;
    }
    const s = await get("/state");
    if (my < applied) return;                  // an older answer that a newer one overtook
    applied = my; lost = false;
    // The page reads deployment.json once, so a fresh chain needs a fresh load: after a reset, or when this page
    // was opened while the chain was still starting.
    if (s.phase === "booting") sawBoot = true;
    else if (sawBoot || my > resetAfter) { location.reload(); return; }
    const follow = cursor === null || !S || cursor >= S.head;
    S = s; fetchedAt = Date.now();
    S.head = Math.max(0, Math.min(Number(s.head) || 0, deck.steps.length - 1));
    if (follow || cursor > S.head) cursor = S.head;
  } catch { if (my >= applied) lost = true; }
  render();
}
(async function loop() { await poll(); setTimeout(loop, POLL_MS); })();

// ---------- actions ----------
async function next() {
  if (!deck || !S || lost) return;
  if (cursor < S.head) { cursor++; msg = ""; render(); return; }     // forward through history: no server call
  const cur = S.current || {}, nx = deck.steps[cursor + 1];
  // Slides and cards need no chain, so they may be walked while it starts; a live step needs it running.
  if (busy || !nx || (cur.status && cur.status !== "ready") || (S.phase !== "ready" && nx.kind === "live")) return;
  busy = true; msg = ""; render();
  const r = await post("/next", { from: S.head });
  if (!r?.ok) msg = r?.error || "The server did not advance.";
  await poll();                                // the cursor was at the old head, so it follows the new one
  busy = false; render();
}
function back() { if (deck && S && cursor > 0) { cursor--; msg = ""; render(); } }
async function retry() {
  if (busy) return;
  busy = true; render();
  const r = await post("/retry");
  if (!r?.ok) msg = r?.error || "Retry was refused.";
  await poll();
  busy = false; render();
}
async function reset() {
  if (!confirm("Stop everything and start a fresh chain? The deck goes back to the first step.")) return;
  resetting = true; msg = ""; render();
  const r = await post("/reset");
  if (r?.ok === false) { resetting = false; msg = r.error || "Reset was refused."; render(); return; }
  await sleep(1000);
  resetAfter = seq;                            // a state read from here on that is not booting reloads the page
}
function toggleNotes() { const off = document.documentElement.classList.toggle("bbb-notes-off"); stored("bbb-notes", off ? "off" : "on"); }

$("bbb-prev").addEventListener("click", back);
$("bbb-next").addEventListener("click", next);
$("bbb-reset").addEventListener("click", reset);
hist.addEventListener("click", () => { if (S) { cursor = S.head; render(); } });
stEl.addEventListener("click", (e) => { if (e.target.closest("button")) retry(); });
// A clicked button never takes focus, so Space or Enter afterwards is the deck's key and never a second click.
for (const el of [col, stEl]) el.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
  if (["ArrowRight", " ", "Spacebar", "PageDown", "Enter"].includes(e.key)) { e.preventDefault(); if (!e.repeat) next(); }
  else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); back(); }
  else if (e.key === "n" || e.key === "N") { e.preventDefault(); toggleNotes(); }
}, true);
addEventListener("resize", () => { if (!slide.hidden) fit(); });

// ---------- render ----------
function render() {
  if (!deck || !S) {
    put("bbb-say", ""); put("bbb-upnext", ""); put("bbb-held", "");
    put("bbb-msg", lost ? esc(NOT_ANSWERING) : "");
    put("bbb-mk", lost ? "" : "connecting…");
    nextButton("", lost ? "Server not answering" : "Connecting…", true, !lost);
    $("bbb-prev").disabled = true;
    return;
  }
  const n = deck.steps.length, head = S.head, i = Math.min(cursor, head), step = deck.steps[i], cur = S.current || {};
  const status = i === head && (cur.i === undefined || Number(cur.i) === head) ? (cur.status || "ready") : "ready";
  showLeft(step, i, status, cur);
  showNotes(step, i, status);
  showNav(i, status);
  hist.hidden = i >= head;
  if (!hist.hidden) put("bbb-hist", `<span style="font-size:22px">↺</span><span>Looking back: step ${i + 1} of ${n}. The market is at step ${head + 1}. ▶ to return.</span>`);
  BBB.setLogs(S.logs || []);
}

let slideKey = "", lineKey = "";
function showLeft(step, i, status, cur) {
  if (step.kind !== "live") {
    const key = JSON.stringify([i, step.slide]);
    if (key !== slideKey) { slideKey = key; slide.innerHTML = slideHTML(step); slide.hidden = false; fit(); }
    clearFocus();
    return;
  }
  if (slideKey) { slideKey = ""; slide.hidden = true; slide.innerHTML = ""; }
  const v = { caption: "", note: "", focus: "", label: "", color: "", step: "", scene: step.scene, ...(S.views?.[i] || {}) };
  let caption = v.caption, note = v.note, sts = "";
  if (status === "working") {
    const secs = Math.max(0, Math.floor(((Number(cur.waitedMs) || 0) + Date.now() - fetchedAt) / 1000));
    caption = cur.working || v.caption || `${step.label}…`; note = "";
    sts = `<span class="bbb-spin"></span><span>${esc([cur.working ? "" : "Waiting for the chain", cur.progress, `${secs} s`].filter(Boolean).join(" · "))}</span>`;
  } else if (status === "failed") {
    caption = `Step ${i + 1} did not finish: ${step.label}.`; note = "";
    sts = `<span class="e">${esc(cur.error || "No error was reported.")}</span><button type="button">Retry</button>`;
  }
  const line = { caption, note, scene: v.scene, step: v.step, color: v.color };
  const key = JSON.stringify(line);
  if (key !== lineKey) { lineKey = key; BBB.apply(line, false); }
  if (shown.get("st") !== sts) { shown.set("st", sts); stEl.innerHTML = sts; stEl.classList.toggle("fail", status === "failed"); }
  const rb = stEl.querySelector("button"); if (rb) rb.disabled = busy;
  focusStep(v, status);
}

// The callout, with the recorder's retry-until-found: a card the page has not drawn yet is looked for on every tick
// for FOCUS_WAIT_MS. It re-arms when the step's view or status changes, and scrolls only to a card not already scrolled to.
let fKey = "", fPending = null, scrolled = "";
function focusStep(v, status) {
  const key = `${v.focus}|${v.color}|${v.label}|${status}`;
  if (key !== fKey) {
    fKey = key;
    fPending = v.focus ? { sel: BBB.selectorFor(v.focus), focus: v.focus, since: Date.now() } : null;
    if (!fPending?.sel) BBB.focusOn("", "", "", false);
  }
  if (!fPending) return;
  const scroll = fPending.focus !== scrolled;
  if (fPending.sel && BBB.focusOn(fPending.sel, BBB.colorOf(v.color), v.label || "", scroll)) { fPending.since = Date.now(); if (scroll) scrolled = fPending.focus; }
  else if (!fPending.sel || Date.now() - fPending.since > BBB.FOCUS_WAIT_MS) fPending = null;
}
function clearFocus() { if (fKey) { fKey = ""; fPending = null; scrolled = ""; BBB.focusOn("", "", "", false); } }

function showNotes(step, i, status) {
  const v = S.views?.[i] || {};
  $("bbb-notes").style.setProperty("--acc", step.kind === "live" ? BBB.colorOf(v.color) : step.kind === "card" ? BBB.colorOf(BBB.SCENE_COLOR[step.scene]) : ACCENT);
  put("bbb-say", (step.say || []).map((t) => `<li>${esc(t)}</li>`).join(""));
  const nx = deck.steps[i + 1];
  put("bbb-upnext", `<b>NEXT ▶</b>${esc(nx ? nx.label : "Nothing: this is the last step.")}`);
  const held = i === S.head ? (S.pending || []) : [];
  put("bbb-held", held.length ? `Held for ▶: ${held.slice(0, 4).map(gateText).join(", ")}` : "");
  const m = S.market;
  put("bbb-mk", m?.address ? esc(`${m.address.slice(0, 8)}…${m.address.slice(-6)} · ${String(m.rpc || "").replace(/^https?:\/\//, "")}`) : S.phase === "booting" ? "starting a fresh chain…" : "");
  // A refused Retry says why (msg), in place of the standing line.
  const text = lost ? NOT_ANSWERING : S.phase === "failed" ? `The live demo cannot go on: ${S.error || "no error was reported"}. Reset chain to start again.`
    : status === "failed" ? msg || "This step did not finish. What happened, and whether Retry can help, is under the caption." : msg;
  put("bbb-msg", esc(text));
  $("bbb-reset").disabled = resetting || S.phase === "booting";
}
// A commit gate is keyed by its claim (no sale exists until the commit lands); every other gate by its sale.
const gateText = (k) => {
  const [role, action, id] = String(k).split(".");
  const of = id && id !== "x" ? ` ${action === "commit" ? "claim" : "sale"} #${esc(id)}` : "";
  return `<b style="color:${hue(role)}">${esc(role)}</b> ${esc(action || "")}${of}`;
};

function showNav(i, status) {
  const n = deck.steps.length, head = S.head, nx = deck.steps[i + 1], sc = sceneOf(i);
  $("bbb-count").textContent = `Step ${i + 1} / ${n}`;
  $("bbb-scene").textContent = sc.name; $("bbb-scene").style.color = sc.color;
  $("bbb-bar").firstElementChild.style.width = `${((head + 1) / n) * 100}%`;
  $("bbb-bar").lastElementChild.style.width = `${((i + 1) / n) * 100}%`;
  $("bbb-prev").disabled = i === 0;
  if (lost) nextButton("", "Server not answering", true, false);
  else if (i < head) nextButton("Next", nx.label, false, false);
  else if (!nx) nextButton("", "End", true, false);
  else if (busy || status === "working") nextButton("", "Working…", true, true);
  else if (S.phase === "booting" && nx.kind === "live") nextButton("", "Starting the chain…", true, true);
  else nextButton("Next", nx.label, status === "failed" || (S.phase !== "ready" && nx.kind === "live"), false);
}
function nextButton(kicker, label, disabled, spinning) {
  const b = $("bbb-next");
  const html = `${spinning ? `<span class="bbb-spin"></span>` : PLAY}<span class="l">${kicker ? `<small>${esc(kicker)}</small>` : ""}<i>${esc(label)}</i></span>`;
  if (shown.get("next") !== html) { shown.set("next", html); b.innerHTML = html; }
  b.disabled = disabled; b.classList.toggle("busy", !!spinning);
  b.setAttribute("aria-label", kicker ? `${kicker}: ${label}` : label);
}
// A scene's name comes from its card; outside the scenes, the steps before the first are the introduction.
function sceneOf(i) {
  const sc = Number(deck.steps[i].scene) || 0;
  if (sc) {
    const card = deck.steps.find((x) => x.kind === "card" && Number(x.scene) === sc);
    return { name: `Scene ${sc}${card?.slide?.title ? ` · ${card.slide.title}` : ""}`, color: BBB.colorOf(BBB.SCENE_COLOR[sc]) };
  }
  const first = deck.steps.findIndex((x) => Number(x.scene) > 0);
  return { name: first >= 0 && i > first ? "Closing" : "Introduction", color: "#9aa4af" };
}

// ---------- slides ----------
// Built from whatever the slide object carries, so a layout with an extra field (a legend on bullets) still shows it.
function slideHTML(step) {
  const s = step.slide || {}, L = String(s.layout || step.kind).replace(/[^a-z]/g, "");
  const acc = L === "card" ? BBB.colorOf(BBB.SCENE_COLOR[step.scene]) : ACCENT;
  const kicker = s.kicker || (L === "card" && step.scene ? `Scene ${step.scene} of 4` : "");
  let h = (kicker ? `<div class="k">${esc(kicker)}</div>` : "") + `<h1>${esc(s.title)}</h1>`;
  if (s.subtitle) h += `<div class="sub">${esc(s.subtitle)}</div>`;
  if (s.body) h += `<div class="body">${esc(s.body)}</div>`;
  if (s.bullets?.length) h += `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
  if (s.flow) h += flowHTML(s.flow);
  if (s.table) h += tableHTML(s.table);
  if (s.grid?.length) h += `<div class="gr">${s.grid.map((c, k) => `<div style="--c:${hue(GRID_COLORS[k % 4])}"><h3>${esc(c.h)}</h3><p>${esc(c.b)}</p></div>`).join("")}</div>`;
  // An address stays on one line; words after it wrap as a unit ("0x… on Base Sepolia").
  const val = (v) => esc(v).replace(/^(0x[0-9a-fA-F]{40})\s+(.+)$/, "<span>$1</span> <span>$2</span>");
  if (s.lines?.length) h += `<dl>${s.lines.map((l) => `<dt>${esc(l.k)}</dt><dd>${val(l.v)}</dd>`).join("")}</dl>`;
  if (s.legend?.length) h += `<div class="lg">${s.legend.map((x) => `<span style="--c:${hue(x.role)}"><i></i>${esc(x.label)}</span>`).join("")}</div>`;
  return `<div class="in L-${L}" style="--acc:${acc}"><div class="main">${h}</div>${s.foot ? `<div class="foot">${esc(s.foot)}</div>` : ""}</div>`;
}
const ARROW = `<svg viewBox="0 0 40 20" aria-hidden="true"><path d="M3 10H27" stroke="#5f6873" stroke-width="2.5"/><path d="M25 3.5 37 10 25 16.5Z" fill="#5f6873"/></svg>`;
const box = (b) => `<div class="bx" style="--c:${hue(b.role)}"><em>${esc(ROLE_NAME[b.role] || "")}</em><b>${esc(b.t)}</b><span>${esc(b.s)}</span></div>`;
function flowHTML(f) {
  const main = (f.main || []).map(box).join(`<div class="ar">${ARROW}</div>`);
  const outs = f.outcomes?.length ? `<svg class="lk" aria-hidden="true"></svg><div class="fr o">${f.outcomes.map(box).join("")}</div>` : "";
  return `<div class="flow"><div class="fr m">${main}</div>${outs}</div>`;
}
// The headline column takes the page's own headline colours (app.js sellerHeadline: ok, bad, warn, unknown).
const headlineHue = (t) => hue(/confirmed/i.test(t) ? "green" : /refuted|withdrawn/i.test(t) ? "red" : /unarbitrated/i.test(t) ? "amber" : "grey");
function tableHTML(t) {
  const head = t.head || [], rows = t.rows || [], last = Math.max(head.length, rows[0]?.length || 0) - 1;
  const cell = (c, k) => k === last && last > 0 ? `<td class="h" style="--c:${headlineHue(String(c))}">${esc(c)}</td>` : `<td>${esc(c)}</td>`;
  return `<table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("")}</tbody></table>`;
}
// Sizes follow the left area (1 at 920 x 900, within 0.92-1.04), then shrink until nothing overflows.
function fit() {
  const inn = slide.firstElementChild;
  if (!inn) return;
  let s = Math.min(1.04, Math.max(0.92, Math.min(slide.clientWidth / 920, slide.clientHeight / 900)));
  inn.style.setProperty("--s", s.toFixed(3));
  while ((inn.scrollHeight > inn.clientHeight + 1 || inn.scrollWidth > inn.clientWidth + 1) && s > 0.6) { s -= 0.03; inn.style.setProperty("--s", s.toFixed(3)); }
  drawLinks();
}
// The outcomes branch from the last box of the main row: down, across, and an arrow into each.
function drawLinks() {
  const svg = slide.querySelector("svg.lk"), mains = slide.querySelectorAll(".fr.m .bx"), outs = slide.querySelectorAll(".fr.o .bx");
  if (!svg || !mains.length || !outs.length) return;
  const o = svg.parentElement.getBoundingClientRect(), last = mains[mains.length - 1].getBoundingClientRect();
  const x0 = last.left + last.width / 2 - o.left, y0 = last.bottom - o.top;
  const tops = [...outs].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2 - o.left, y: r.top - o.top }; });
  const ym = (y0 + tops[0].y) / 2, xs = tops.map((t) => t.x).concat(x0);
  let d = `M${x0} ${y0 + 1}V${ym}M${Math.min(...xs)} ${ym}H${Math.max(...xs)}`, heads = "";
  for (const t of tops) { d += `M${t.x} ${ym}V${t.y - 11}`; heads += `<path d="M${t.x - 7} ${t.y - 13}L${t.x} ${t.y - 2}L${t.x + 7} ${t.y - 13}Z" fill="#5f6873"/>`; }
  svg.innerHTML = `<path d="${d}" fill="none" stroke="#5f6873" stroke-width="2.5" stroke-linejoin="round"/>${heads}`;
}
