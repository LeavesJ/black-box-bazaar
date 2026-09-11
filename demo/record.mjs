// demo/record.mjs — records the page while scenes.sh runs, with the demo's furniture on top of it: a scene badge,
// a step tracker, a callout (outline + label tag) on the card each caption is about, the caption bar with its
// note, a title card per scene, and the agent log panel. The furniture is docs/overlay.js, the same file the
// presenter (docs/present.js) uses live; this recorder injects it into whatever page it is showing, the live site
// in the epilogue included, and drives it from scene.txt and the agents' logs. app.js only honours ?record=1.
// Seller-side log lines never show the pair (a, b, answers, truth, pair), so nothing leaks.
// Usage: node demo/record.mjs http://localhost:8080/?record=1   (start this first, then demo/scenes.sh)
// scene.txt is one JSON line: {"caption","note","focus","label","color","step","scene","title","subtitle","goto",
// "card_s"}; plain text is still accepted as a bare caption. A focus of sale:N, claim:N or addr:0x… scrolls that
// card under the top strip and outlines it until the next focus. A title covers the page with a card for TITLE_MS,
// or card_s seconds when set, and lifts only once a caption line has replaced it. A goto navigates the page (the
// epilogue) under a cover carrying the last caption, then the new one, until the page has drawn its data.
// Recording stops at caption END.
import { chromium } from "playwright";
import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync, unlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_URL = process.argv[2];
if (!PAGE_URL) {
  console.error("usage: node demo/record.mjs <page url> [--check [out.png]]\n  e.g. node demo/record.mjs http://localhost:8080/?record=1   (the page served from docs/)\n  --check: no recording; overlays a sample title card, tracker, callout, caption and log lines, a scene-0 line, a covered goto and the final card, screenshots each, exits");
  process.exit(2);
}
// --check <png>: the overlays on a fake sale card, screenshotted through the same code the recording uses.
const here = new URL(".", import.meta.url).pathname;
const OUT = join(here, "out"); mkdirSync(OUT, { recursive: true });
const CHECK = process.argv[3] === "--check" ? (process.argv[4] || join(OUT, "treatment-check.png")) : "";
const LOGS = join(here, "logs");
const SCENE = join(here, "scene.txt");
const TIMELINE = join(here, "timeline.json");
const OVERLAY_SRC = readFileSync(join(here, "..", "docs", "overlay.js"), "utf8");
const NAV_TIMEOUT_MS = 15000; // a goto waits for domcontentloaded at most this long, then carries on regardless
const NAV_SETTLE_MS = 1500;   // after domcontentloaded, before the overlays go back on
const READY_MS = 8000;        // then how long the cover waits for the page to draw its data (footer "Refreshed")
const POLL_MS = 700;

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

// Puts docs/overlay.js into the page if it is not there (after a goto it is not) and installs the furniture. Idempotent.
async function inject(external) {
  if (!await page.evaluate(() => !!window.BBB)) await page.addScriptTag({ content: OVERLAY_SRC });
  await page.evaluate((ext) => window.BBB.install({ external: ext }), !!external);
}
await inject(false);
const { TITLE_MS, FOCUS_WAIT_MS, MAX_LINES } = await page.evaluate(() => ({ TITLE_MS: BBB.TITLE_MS, FOCUS_WAIT_MS: BBB.FOCUS_WAIT_MS, MAX_LINES: BBB.MAX_LINES }));

const apply = (line, showCard) => page.evaluate(([line, showCard]) => window.BBB.apply(line, showCard), [line, !!showCard]);
const dropCard = () => page.evaluate(() => window.BBB.dropCard());
const focusOn = (sel, color, label, scroll) => page.evaluate(([sel, color, label, scroll]) => window.BBB.focusOn(sel, color, label, scroll), [sel, color, label, !!scroll]);
const selectorFor = (focus) => page.evaluate((f) => window.BBB.selectorFor(f), focus);
const colorOf = (name) => page.evaluate((n) => window.BBB.colorOf(n), name);
const setLogs = (lines) => page.evaluate((l) => window.BBB.setLogs(l), lines);
const uncover = () => page.evaluate(() => window.BBB.uncover());
const cardMs = (line) => line.card_s > 0 ? line.card_s * 1000 : TITLE_MS;

// The epilogue's goto: a cover carrying the last caption goes over the page being left and, through an init
// script that carries overlay.js itself, over the next document as soon as it has a root; then the page loads,
// settles, and gets the furniture back. The caller applies the new line and then uncovers. A slow or refused
// load is not fatal. One init script per goto: the epilogue has one.
async function navigate(url, prev, next) {
  const args = await page.evaluate(([l, wait]) => window.BBB.coverArgs(l, wait), [prev, NAV_TIMEOUT_MS + NAV_SETTLE_MS]).catch(() => null);
  if (args) {
    await page.evaluate((a) => window.BBB.cover(a), args).catch(() => {});
    await page.addInitScript({ content: `${OVERLAY_SRC}\nwindow.BBB.cover(${JSON.stringify(args)});` });
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(NAV_SETTLE_MS);
  await inject(true);
  // The new line's words go onto the cover at once, and the cover stays until the page has drawn its data (a bazaar
  // page's footer then reads "Refreshed"; any other page is waited on for READY_MS), so neither a load in progress
  // nor a failed first read is ever on screen.
  const nextArgs = await page.evaluate(([l, wait]) => window.BBB.coverArgs(l, wait), [next, READY_MS + 1000]).catch(() => null);
  if (nextArgs) await page.evaluate((a) => window.BBB.cover(a), nextArgs).catch(() => {});
  await page.waitForFunction(() => /^Refreshed/.test(document.getElementById("foot")?.textContent || ""), null, { timeout: READY_MS, polling: 250 }).catch(() => {});
}

const tail = (file, n) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").slice(-n) : [];
const stamp = (line) => { try { return Date.parse(JSON.parse(line).t) || 0; } catch { return 0; } };
// The log panel's lines: the tail of every role's log, merged by timestamp; lines in the same millisecond keep
// their file order (the file, then the tail index), never their text order. overlay.js keeps that order for ties.
function logLines() {
  const files = existsSync(LOGS) ? readdirSync(LOGS).filter(f => f.endsWith(".log")).sort() : [];
  const entries = files.flatMap((f, fi) => tail(join(LOGS, f), 40).map((line, li) => ({ line, t: stamp(line), fi, li })));
  entries.sort((a, b) => a.t - b.t || a.fi - b.fi || a.li - b.li);
  return entries.slice(-MAX_LINES).map(e => e.line);
}
// scene.txt: one JSON line, or plain text from an older writer. Every field is normalised to a string or number.
const NUMERIC = new Set(["scene", "card_s"]);
function readScene() {
  const raw = existsSync(SCENE) ? readFileSync(SCENE, "utf8").trim() : "";
  const line = { caption: "", note: "", focus: "", label: "", color: "", step: "", scene: 0, title: "", subtitle: "", goto: "", card_s: 0 };
  if (!raw) return line;
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      for (const k of Object.keys(line)) if (o[k] !== undefined && o[k] !== null) line[k] = NUMERIC.has(k) ? Number(o[k]) || 0 : String(o[k]);
      return line;
    }
  } catch { /* plain text */ }
  line.caption = raw;
  return line;
}

if (CHECK) {
  // A fake sale card beside the page's own (which the page rebuilds, so the fake one sits after that container),
  // sample log lines in every role, a title card, the reveal step with its callout, caption and note, a scene-0
  // line (no badge, no tracker), then the epilogue: a covered goto back to this same page, and the final card.
  const blank = { caption: "", note: "", focus: "", label: "", color: "", step: "", scene: 0, title: "", subtitle: "", goto: "", card_s: 0 };
  const shot = (suffix) => page.screenshot({ path: suffix ? CHECK.replace(/\.png$/, "") + `-${suffix}.png` : CHECK });
  await page.evaluate(() => {
    const sales = document.getElementById("sales"); if (!sales) return;
    for (let i = 5; i >= 1; i--) {   // filler sales above the fake one, so it starts below the fold and the focus has to scroll
      const f = document.createElement("div"); f.className = "card";
      f.innerHTML = `<div class="row"><b>Sale #${i} <span class="muted">on claim #0</span></b><span class="badge Confirmed">Confirmed</span></div><div class="muted">seller <span class="mono">0x3C44…93BC</span> · bond 0.0001 ETH</div><ul class="tl"><li><span class="ev Confirmed">Confirmed</span><span>sale #${i}</span><span class="mono">0x…</span></li></ul>`;
      sales.insertAdjacentElement("afterend", f);
    }
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
  await setLogs(sample);
  const card = { ...blank, scene: 1, title: "Scene 1 · An honest sale", subtitle: "The buyer posts a claim. The seller finds a counterexample. The buyer checks it and pays." };
  await apply(card, true);
  await page.waitForTimeout(300);
  await shot("card");
  await dropCard();
  const line = { ...blank, caption: "The seller reveals the pair, encrypted to the buyer's key. Only the buyer can read it. This line is long enough to wrap onto a second line.", note: "Confirmed means the buyer checked. That is the only way this number moves.", focus: "sale:0", label: "SALE #0", color: "green", step: "reveal", scene: 1 };
  await apply(line, false);
  const found = await focusOn(await selectorFor(line.focus), await colorOf(line.color), line.label, true);
  await page.waitForTimeout(300);
  await focusOn(await selectorFor(line.focus), await colorOf(line.color), line.label, false);   // re-place the tag after the scroll
  await shot("");
  const zero = { ...blank, caption: "The market is empty. The arbiter is watching. The sweep runs on the deployer wallet.", note: "Every count on screen is read from the chain as it happens.", color: "grey" };
  await apply(zero, false); await focusOn("", "", "", false);
  await page.waitForTimeout(200);
  await shot("scene0");
  const args = await page.evaluate(([l, wait]) => window.BBB.coverArgs(l, wait), [zero, NAV_TIMEOUT_MS + NAV_SETTLE_MS]);
  await page.evaluate((a) => window.BBB.cover(a), args);
  await shot("cover");
  await page.addInitScript({ content: `${OVERLAY_SRC}\nwindow.BBB.cover(${JSON.stringify(args)});` });
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await shot("cover-nav");   // the init-script cover on the new document, before the overlays are back
  await page.waitForTimeout(NAV_SETTLE_MS); await inject(true);
  const epi = { ...blank, caption: "The same contract, live on Base Sepolia. Four real sales: confirmed, refuted, refuted, unadjudicated.", color: "grey", goto: PAGE_URL };
  await apply(epi, false); await uncover();
  await page.waitForTimeout(200);
  await shot("epilogue");
  const fin = { ...blank, title: "Silence is not evidence.", subtitle: "0xf347ff05478ad271adab818696134bc3cd0a07ed on Base Sepolia · leavesj.github.io/black-box-bazaar", card_s: 65 };
  await apply(fin, true);
  await page.waitForTimeout(300);
  await shot("final");
  console.log(`check: fake card found=${found}; wrote ${CHECK} and its -card, -scene0, -cover, -cover-nav, -epilogue, -final siblings`);
  await ctx.close(); await browser.close();
  process.exit(0);
}

let lastKey = "", lastFocusKey = "", lastFocus = "", pending = null, cardUntil = 0, external = false, current = readScene();
while (true) {
  const line = readScene();
  if (line.caption === "END") break;   // scene.txt was emptied above, so an END here is this run's
  const key = JSON.stringify(line);
  try {
    if (key !== lastKey) {
      lastKey = key;
      const prev = current; current = line;
      if (line.goto) {
        // The epilogue: the same overlays on a page this recorder did not serve, loaded under the last caption.
        await navigate(line.goto, prev, line);
        external = true;
      }
      const withCard = !!line.title;
      await apply(line, withCard);
      await uncover();
      if (withCard) cardUntil = Date.now() + cardMs(line);
    }
    // A title card lifts once its time is up and a caption line has replaced it, so the bar is never empty as it lifts.
    if (cardUntil && Date.now() >= cardUntil && !current.title) { cardUntil = 0; await dropCard(); }
    // The callout follows the focus, and re-colours when the same card gets a new label or colour; it scrolls only on
    // a change of card. The page refreshes every few seconds, so a card the caption names may appear a moment later.
    const focusKey = `${current.focus}|${current.color}|${current.label}`;
    if (focusKey !== lastFocusKey) {
      lastFocusKey = focusKey;
      const scroll = current.focus !== lastFocus; lastFocus = current.focus;
      pending = current.focus ? { sel: await selectorFor(current.focus), color: await colorOf(current.color), since: Date.now(), scroll } : null;
      if (!pending) await focusOn("", "", "", false);
    }
    if (pending) {
      if (pending.sel && await focusOn(pending.sel, pending.color, current.label, pending.scroll)) { pending.since = Date.now(); pending.scroll = false; }
      else if (!pending.sel || Date.now() - pending.since > FOCUS_WAIT_MS) pending = null;
    }
    if (!external) await setLogs(logLines());
  } catch (e) {
    // An external page that navigated itself drops the overlays; put them back and carry on.
    console.error("overlay update failed, re-injecting:", String(e.message || e).split("\n")[0]);
    await inject(external).catch(() => {});
    lastKey = ""; lastFocusKey = ""; lastFocus = "";
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
