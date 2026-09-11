// docs/present.js — the presenter panel behind ?present=1, for a live walkthrough: the procedure as a list of
// steps with one Run button at a time, the same overlays the recorded video uses (overlay.js: badge, step
// tracker, callout, caption, title card, agent log), fed from demo/console.mjs's /api/state, and what to say
// while each scene runs. The page keeps reading the chain on its own; nothing here writes to it.
const API = "/api";
const POLL_MS = 700;
const TITLES = { 1: "An honest sale", 2: "A planted pair", 3: "A real pair, never delivered", 4: "The silent buyer" };
const TALK = {
  0: ["Three agents, each with its own wallet: a buyer, a seller, an arbiter.",
      "All three query the same pinned model at the same settings. That model is the shared ground truth.",
      "The market is empty. Every number on this page is read from the chain as it happens."],
  1: ["The buyer escrows the whole bounty pool before any seller shows up. That is the black box: money first, goods later.",
      "The seller commits a hash of the pair plus a bond, then reveals the pair encrypted to the buyer's key. Everyone sees that something was delivered; only the buyer can read it.",
      "The buyer decrypts, checks the hash, re-runs the model three times, and confirms. The seller is paid and its bond comes back.",
      "Confirmed is the only number a buyer's own check can move."],
  2: ["A rogue sells a pair the model actually gets right.",
      "The buyer re-runs it, sees the model is right, and disputes: a bond of its own and a reason. The rogue must now disclose the pair on-chain, in public.",
      "The arbiter re-runs it five times and refutes. The rogue's bond goes to the buyer.",
      "A refutation stays on the record: this card reads refuted history from now on."],
  3: ["A real counterexample, an honest commit, and then random bytes instead of the encrypted pair.",
      "Without a delivery check this seller wins the dispute: the disclosed pair is real, so a re-run would uphold it, and the buyer would lose its bond for a good it never received.",
      "So the arbiter checks delivery first: does the disclosed key reproduce the posted reveal? No. Refuted without running the model."],
  4: ["Nobody watches the second claim. The window passes with no confirm and no dispute. On this local chain the clock is jumped; on the testnet the wait is real.",
      "Anyone can settle. The seller is paid, because the buyer had its chance.",
      "But the sale is recorded as unadjudicated, and the card reads unverified: one unadjudicated, zero confirmed.",
      "Money followed the default. Reputation did not. Silence is not evidence."],
  done: ["Not shown: a vanished arbiter. After its window each side takes its own bond back and the sale is recorded as unarbitrated, its own state, never folded into silence.",
         "Same code, live on Base Sepolia with four real sales: leavesj.github.io/black-box-bazaar. Reset the chain to run it again."],
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// overlay.js is a classic script that defines window.BBB, so the recorder can inject the same file anywhere.
await new Promise((ok, no) => { const s = document.createElement("script"); s.src = "./overlay.js"; s.onload = ok; s.onerror = () => no(new Error("overlay.js failed to load")); document.head.appendChild(s); });
const BBB = window.BBB;
BBB.install({ present: true });

const style = document.createElement("style");
style.textContent = `
  #bbb-panel { position:fixed; right:0; top:0; width:${BBB.OVERLAY_W}px; height:46%; z-index:2147483000; background:#0e1114; border-left:1px solid #2a3139; border-bottom:1px solid #2a3139; color:#e6e9ec; font:14px/1.45 ${BBB.FONT}; display:flex; flex-direction:column; overflow:hidden }
  #bbb-panel .hd { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid #2a3139 }
  #bbb-panel .hd b { font:700 12px/1 ${BBB.FONT}; letter-spacing:1.4px; color:#9aa4af }
  #bbb-panel .hd .market { flex:1; font:12px ui-monospace,Menlo,monospace; color:#8a94a0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
  #bbb-panel button { font:600 12px/1 ${BBB.FONT}; padding:7px 12px 6px; border-radius:6px; border:1px solid #3a434d; background:#181d23; color:#e6e9ec; cursor:pointer }
  #bbb-panel button:disabled { opacity:.35; cursor:default }
  #bbb-panel button.run { background:#3ddc97; border-color:transparent; color:#0b0d10 }
  #bbb-panel ol { list-style:none; margin:0; padding:8px 14px 4px }
  #bbb-panel li { display:flex; align-items:center; gap:10px; padding:6px 0; border-bottom:1px dashed #232a32 }
  #bbb-panel li i { width:10px; height:10px; border-radius:50%; border:1.5px solid #3a434d; flex:none }
  #bbb-panel li.done i { background:#3ddc97; border-color:#3ddc97 }
  #bbb-panel li.running i { background:#ffc857; border-color:#ffc857; animation:bbb-pulse 1s infinite alternate }
  #bbb-panel li.ready i { border-color:#3ddc97 }
  #bbb-panel li span { flex:1 }
  #bbb-panel li.pending span { color:#5f6873 }
  #bbb-panel li em { font-style:normal; font-size:12px; color:#8a94a0 }
  #bbb-panel .say { padding:8px 14px 10px; overflow:auto; flex:1 }
  #bbb-panel .say h4 { margin:0 0 4px; font:700 11px/1 ${BBB.FONT}; letter-spacing:1.2px; color:#9aa4af }
  #bbb-panel .say ul { margin:0; padding-left:18px; color:#cfd6dd; font-size:13px }
  #bbb-panel .say li { display:list-item; border:0; padding:2px 0 }
  #bbb-panel .err { padding:0 14px 10px; color:#ff6b6b; font-size:12px; white-space:pre-wrap }
  #bbb-panel .err:empty { display:none }
  @keyframes bbb-pulse { from { opacity:.5 } to { opacity:1 } }
  html.bbb-present #bbb-logs { top:46%; height:54% }`;
document.head.appendChild(style);

const panel = document.createElement("div");
panel.id = "bbb-panel";
panel.innerHTML = `<div class="hd"><b>PRESENTER</b><span class="market">starting a fresh chain…</span><button id="bbb-reset" title="Stop everything, start a fresh chain, redeploy, and hold before scene 1">Reset chain</button></div>
  <ol>${[0, 1, 2, 3, 4].map((n) => `<li data-n="${n}"><i></i><span>${n ? `Scene ${n} · ${TITLES[n]}` : "Fresh chain, empty market"}</span><em></em>${n ? `<button class="run" hidden>Run scene ${n}</button>` : ""}</li>`).join("")}</ol>
  <div class="say"><h4>SAY</h4><ul></ul></div><div class="err"></div>`;
document.body.appendChild(panel);
const say = (key) => { panel.querySelector(".say ul").innerHTML = (TALK[key] || []).map((t) => `<li>${esc(t)}</li>`).join(""); };

let clicked = 0;
for (const b of panel.querySelectorAll("button.run")) b.addEventListener("click", async () => {
  const n = Number(b.closest("li").dataset.n);
  b.disabled = true; clicked = n;
  const r = await fetch(`${API}/go/${n}`, { method: "POST" }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) { panel.querySelector(".err").textContent = r.error || "could not start the scene"; b.disabled = false; clicked = 0; }
});
$("bbb-reset").addEventListener("click", async () => {
  if (!confirm("Stop everything and start a fresh chain?")) return;
  await fetch(`${API}/reset`, { method: "POST" }).catch(() => {});
  // The page reads deployment.json once, so the new chain needs a fresh load: as soon as the console has deployed.
  const until = Date.now() + 60000;
  const poll = async () => {
    const s = await fetch(`${API}/state`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if ((s && s.phase !== "booting") || Date.now() > until) location.reload(); else setTimeout(poll, 500);
  };
  setTimeout(poll, 1500);
});

function renderSteps(s) {
  const done = new Set(s.done || []);
  for (const li of panel.querySelectorAll("li[data-n]")) {
    const n = Number(li.dataset.n), em = li.querySelector("em"), btn = li.querySelector("button");
    let cls = "pending", note = "";
    if (n === 0) { cls = s.phase === "booting" ? "running" : (s.phase === "failed" ? "pending" : "done"); note = s.phase === "booting" ? "starting…" : (s.phase === "failed" ? "failed" : "0 claims, 0 sales at start"); }
    else if (done.has(n)) { cls = "done"; note = "done"; }
    else if (s.running === n) { cls = "running"; note = "running…"; }
    else if (s.waiting === n && s.phase === "ready") { cls = "ready"; note = "ready"; }
    li.className = cls; em.textContent = note;
    if (btn) { btn.hidden = cls !== "ready"; btn.disabled = clicked === n && cls === "ready"; }
  }
  if (s.running) say(s.running); else if (s.phase === "done") say("done"); else if (s.waiting) say(s.waiting); else say(0);
  panel.querySelector(".market").textContent = s.market ? `${s.market.address} · local chain at ${s.market.rpc.replace("http://", "")}` : (s.phase === "booting" ? "starting a fresh chain…" : "no market");
  panel.querySelector(".err").textContent = s.error || "";
  $("bbb-reset").disabled = s.phase === "booting";
}

// The overlays, driven exactly as the recorder drives them: a title card for TITLE_MS, a callout that follows the
// focus and waits for a card the page has not rendered yet, and the agents' log lines.
let lastKey = "", lastFocusKey = "", lastFocus = "", pending = null, cardUntil = 0, current = null;
function applyLine(line) {
  const key = JSON.stringify(line);
  if (key !== lastKey) {
    lastKey = key; current = line;
    const withCard = !!line.title;
    BBB.apply(line, withCard);
    if (withCard) cardUntil = Date.now() + BBB.cardMs(line);
  }
  // A title card lifts once its time is up and a caption line has replaced it, so the bar is never empty as it lifts.
  if (cardUntil && Date.now() >= cardUntil && !line.title) { cardUntil = 0; BBB.dropCard(); }
  const focusKey = `${line.focus}|${line.color}|${line.label}`;
  if (focusKey !== lastFocusKey) {
    lastFocusKey = focusKey;
    const scroll = line.focus !== lastFocus; lastFocus = line.focus;
    pending = line.focus ? { sel: BBB.selectorFor(line.focus), since: Date.now(), scroll } : null;
    if (!pending) BBB.focusOn("", "", "", false);
  }
  if (pending) {
    if (pending.sel && BBB.focusOn(pending.sel, BBB.colorOf(line.color), line.label, pending.scroll)) { pending.since = Date.now(); pending.scroll = false; }
    else if (!pending.sel || Date.now() - pending.since > BBB.FOCUS_WAIT_MS) pending = null;
  }
}

async function tick() {
  let s;
  try { s = await fetch(`${API}/state`, { cache: "no-store" }).then((r) => r.json()); }
  catch { panel.querySelector(".err").textContent = "demo/console.mjs is not answering. Start it from the repository root:\n  node demo/console.mjs"; return; }
  if (s.waiting !== clicked) clicked = 0;
  renderSteps(s);
  if (s.line && s.line.caption !== "END") applyLine({ caption: "", note: "", focus: "", label: "", color: "", step: "", scene: 0, title: "", subtitle: "", goto: "", card_s: 0, ...s.line });
  else if (s.line && current && current.title && lastKey !== "END") {
    // The run is over: the closing card comes down and its words stay in the caption bar, over the finished market.
    lastKey = "END"; cardUntil = 0; BBB.dropCard();
    BBB.apply({ ...current, caption: current.title, note: current.subtitle, title: "", subtitle: "" }, false);
  }
  BBB.setLogs(s.logs || []);
}
tick();
setInterval(tick, POLL_MS);
