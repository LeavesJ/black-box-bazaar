// docs/overlay.js — the demo's furniture, shared by the recorder (demo/record.mjs injects this file into the page
// it records, the live site in the epilogue included) and the presenter (docs/present.js loads it behind
// ?present=1), so the video and a live walkthrough look the same. A classic script: it defines window.BBB and
// touches nothing until install() or cover() is called.
//   install({external, present})   the top strip (scene badge, step tracker), caption bar, log column, callout tag
//                                  and the page padding; idempotent, so safe again after a navigation
//   apply(line, showCard)          badge, tracker, caption and note for one scene line, and a title card when asked
//   dropCard() · cardMs(line)      lifts the title card; how long a line's card stays up (card_s, else TITLE_MS)
//   focusOn(sel, color, label, scroll) -> found   outlines the card sel names, scrolls it under the top strip when
//                                  asked, pins the label tag above it; the tag is re-placed on every call, on
//                                  scroll and resize, and within a frame of any change under <main>
//   selectorFor(focus)             "sale:N" | "claim:N" | "addr:0x…" -> the page's data-attribute selector, or ""
//   setLogs(lines)                 the agents' NDJSON lines -> the log column, merged by timestamp, ties in the
//                                  order given; seller- and buyer-side lines never show the pair (a, b, answers,
//                                  truth, pair)
//   coverArgs(line) · cover(args) · uncover()   a near-black cover carrying a caption across a navigation, sized from
//                                  the caption bar so the text does not move; cover() also works from a
//                                  document-start script, before <body> exists
//   colorOf(name)                  the palette
(function () {
  const MAX_LINES = 22;         // log column lines; the newest are pinned to the bottom, older ones clip off the top
  const OVERLAY_W = 520;        // the log column; the page, the top strip and the caption bar all stop short of it
  const TOP_H = 52;             // the strip holding the badge and the tracker; the page is pushed down by it
  const CAP_H = 130;            // room kept under the page for the caption bar
  const FOCUS_PAD = 12;         // px between the top strip and a focused card's callout
  const TITLE_MS = 3500;        // how long a title card covers the page (scenes.sh TITLE_S; keep them equal)
  const FOCUS_WAIT_MS = 20000;  // how long a caller keeps looking for a focused card the page has not rendered yet
  // The pair is private until a dispute discloses it: the sellers hold it, and the buyer reads it once it is
  // revealed. Their lines never show it. The arbiter's do: it only ever sees a pair already disclosed on-chain.
  const PRIVATE_ROLES = new Set(["seller", "rogue", "newcomer", "quiet", "buyer"]);
  const PRIVATE_FIELDS = new Set(["a", "b", "answers", "truth"]);
  const COLORS = { blue: "#7ab8ff", green: "#3ddc97", red: "#ff6b6b", orange: "#ffa657", grey: "#9aa4af", purple: "#c79bff", amber: "#ffc857" };
  const ROLE_COLOR = { buyer: "blue", seller: "green", rogue: "red", newcomer: "orange", quiet: "grey", arbiter: "purple", sweep: "amber" };
  const SCENE_COLOR = { 1: "green", 2: "red", 3: "orange", 4: "grey" };   // the badge: the colour of each scene's seller
  const STEPS = [["claim", "Claim"], ["commit", "Commit"], ["reveal", "Reveal"], ["adjudicate", "Adjudicate"], ["dispute", "Dispute & Rule"], ["settle", "Settle"]];
  const STEP_INDEX = { claim: 0, commit: 1, reveal: 2, adjudicate: 3, dispute: 4, rule: 4, settle: 5 };
  const FONT = `ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;
  const colorOf = (name) => COLORS[name] || COLORS.grey;
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
  #bbb-card .s { font:400 22px/1.45 ${FONT}; color:#9aa4af; max-width:1120px }
  html.bbb-page body { padding-top:${TOP_H}px !important; padding-bottom:${CAP_H}px !important }
  html.bbb-page header, html.bbb-page main, html.bbb-page footer { padding-right:${OVERLAY_W + 20}px !important }
  html.bbb-ext #bbb-logs { display:none }
  html.bbb-ext #bbb-top, html.bbb-ext #bbb-cap { width:100% }
  html.bbb-ext body { padding-top:${TOP_H}px !important; padding-bottom:${CAP_H}px !important }`;
  // The cover is styled inline: it may be the only thing on a document that has no <head> yet.
  const COVER_CSS = {
    cover: `position:fixed;inset:0;z-index:2147483003;background:#07090b;margin:0`,
    bar: `position:absolute;left:0;bottom:0;box-sizing:border-box;border-top:1px solid transparent;padding:16px 28px 18px;font-family:${FONT}`,   // the border matches #bbb-cap's, so the text sits on the same row
    text: `font:600 24px/1.35 ${FONT};color:#fff;text-align:left`,
    note: `font:italic 400 16px/1.4 ${FONT};color:#8a94a0;margin-top:6px;text-align:left`,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const focus = { sel: "", color: "", label: "", raf: 0, anchor: null };   // the current callout; anchor: the viewport top focusOn placed it at
  let installed = false;
  let lastLogs = "";

  function install({ external = false, present = false } = {}) {
    const html = document.documentElement;
    html.classList.toggle("bbb-ext", !!external);
    html.classList.toggle("bbb-page", !external);
    html.classList.toggle("bbb-present", !!present);
    if (!$("bbb-css")) { const s = document.createElement("style"); s.id = "bbb-css"; s.textContent = CSS; document.head.appendChild(s); }
    if (!$("bbb-focus")) { const s = document.createElement("style"); s.id = "bbb-focus"; document.head.appendChild(s); }
    const mk = (id, inner) => { let d = $(id); if (!d) { d = document.createElement("div"); d.id = id; d.innerHTML = inner; document.body.appendChild(d); } return d; };
    mk("bbb-top", `<span id="bbb-badge" style="display:none"></span><span id="bbb-track" style="display:none">${STEPS.map(([k, t]) => `<span data-step="${k}">${t}</span>`).join("")}</span>`);
    mk("bbb-logs", `<div class="lines"></div>`);
    mk("bbb-cap", `<div class="text"></div><div class="note"></div>`);
    mk("bbb-tag", "").hidden = true;
    if (installed) return;
    installed = true;
    // Cards move when the page inserts a newer sale above them; the tag follows within a frame.
    new MutationObserver(schedule).observe(document.querySelector("main") || document.body, { childList: true, subtree: true, characterData: true });
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    // A person scrolling (the presenter) takes over from the anchor.
    for (const ev of ["wheel", "touchmove", "keydown"]) addEventListener(ev, () => { focus.anchor = null; }, { passive: true });
  }

  // Everything the badge, tracker, caption bar and title card show for one scene line. The badge and tracker are
  // shown only inside a scene (not on the opening, the closing card or the epilogue), hidden by style.display
  // rather than the hidden attribute alone: the tracker's own display:flex rule outranks the attribute.
  function apply(line, showCard) {
    const color = colorOf(line.color);
    const badge = $("bbb-badge"), track = $("bbb-track"), cap = $("bbb-cap");
    if (!badge || !track || !cap) return;
    const scene = Number(line.scene) || 0;
    const inScene = scene >= 1 && scene <= 4;
    for (const el of [badge, track]) { el.hidden = !inScene; el.style.display = inScene ? "" : "none"; }
    if (inScene) { badge.textContent = `SCENE ${scene} / 4`; badge.style.color = colorOf(SCENE_COLOR[scene]); }
    const cur = line.step in STEP_INDEX ? STEP_INDEX[line.step] : -1;
    for (const pill of track.children) {
      const i = STEP_INDEX[pill.dataset.step];
      pill.className = i === cur ? "now" : (cur >= 0 && i < cur ? "done" : "");
      pill.style.background = i === cur ? color : "";
    }
    cap.querySelector(".text").textContent = line.caption || "";
    cap.querySelector(".note").textContent = line.note || "";
    if (showCard) {
      let card = $("bbb-card");
      if (!card) { card = document.createElement("div"); card.id = "bbb-card"; document.body.appendChild(card); }
      card.innerHTML = `<div class="t"></div><div class="s"></div>`;
      card.querySelector(".t").textContent = line.title || ""; card.querySelector(".s").textContent = line.subtitle || "";
    }
  }
  const dropCard = () => { const c = $("bbb-card"); if (c) c.remove(); };
  const cardMs = (line) => Number(line.card_s) > 0 ? Number(line.card_s) * 1000 : TITLE_MS;

  // The card a focus names, as a selector on the page's own data attributes; anything malformed focuses nothing.
  function selectorFor(focusText) {
    const m = /^(sale|claim|addr):(.+)$/.exec(String(focusText || "").trim());
    if (!m) return "";
    const v = m[2].trim().toLowerCase();
    return /^[0-9a-z]+$/.test(v) ? `[data-${m[1]}="${v}"]` : "";
  }
  // Pins the label tag to the top-left corner of the focused card, on the outline's outer edge.
  function place() {
    focus.raf = 0;
    const el = focus.sel ? document.querySelector(focus.sel) : null;
    // The card stays where focusOn put it while the page grows around it. The page rebuilds its lists on every
    // refresh, which defeats the browser's own scroll anchoring, so the drift is scrolled back here.
    if (el && focus.anchor !== null) {
      const dy = el.getBoundingClientRect().top - focus.anchor;
      if (Math.abs(dy) > 1) scrollBy({ top: dy, behavior: "instant" });
    }
    const tag = $("bbb-tag");
    if (!tag) return;
    if (!el || !focus.label) { tag.hidden = true; return; }
    if (tag.textContent !== focus.label) tag.textContent = focus.label;
    tag.style.background = focus.color; tag.hidden = false;
    const r = el.getBoundingClientRect(), h = tag.offsetHeight || 21;
    const top = r.top - 6 - h;
    tag.style.left = `${Math.max(0, r.left - 6)}px`;
    tag.style.top = `${top < TOP_H ? r.top - 3 : top}px`;
  }
  const schedule = () => { if (!focus.raf) focus.raf = requestAnimationFrame(place); };
  // Outlines the card (a stylesheet rule keyed on the selector, so the page's own refresh, which rebuilds the
  // cards, keeps it), scrolls it under the top strip when asked, and pins the tag. Returns whether the card exists
  // yet; callers keep trying for a card the page has not rendered.
  function focusOn(sel, color, label, scroll) {
    const el = sel ? document.querySelector(sel) : null;
    const style = $("bbb-focus");
    if (!style) return false;
    style.textContent = el ? `${sel} { outline:3px solid ${color}; outline-offset:3px; box-shadow:0 0 22px ${color}55 }` : "";
    if (!el || sel !== focus.sel) focus.anchor = null;
    focus.sel = el ? sel : ""; focus.color = color; focus.label = label;
    if (el && scroll) {
      // The callout's top goes FOCUS_PAD px under the strip: the tag, when there is one, then the card. When the
      // card fits between the strip and the caption bar its bottom is kept above the bar too; the first scroll can
      // be clamped near the top of the page.
      const tag = $("bbb-tag"), lead = label ? (tag?.offsetHeight || 21) + 6 : 0;
      let r = el.getBoundingClientRect();
      scrollBy({ top: r.top - (TOP_H + FOCUS_PAD + lead), behavior: "instant" });
      r = el.getBoundingClientRect();
      const room = innerHeight - TOP_H - FOCUS_PAD - lead - CAP_H, over = r.bottom - (innerHeight - CAP_H);
      if (r.height <= room && over > 0) scrollBy({ top: over, behavior: "instant" });
      focus.anchor = el.getBoundingClientRect().top;
    }
    place();
    return !!el;
  }

  // ---------- the log column ----------
  const hidden = (role, key) => PRIVATE_ROLES.has(role) && (PRIVATE_FIELDS.has(key) || /pair/i.test(key));
  // A value on one line: a URL by its tail, a nested object or array as JSON, anything else as text.
  function show(v) {
    if (typeof v === "string" && v.startsWith("http")) return v.split("/").pop().slice(0, 10) + "…";
    const s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > 40 ? s.slice(0, 40) + "…" : s;
  }
  function fmt(line) {
    try {
      const { t, role, event, ...rest } = JSON.parse(line);
      const short = Object.entries(rest).filter(([k]) => !hidden(role, k)).map(([k, v]) => `${esc(k)}=${esc(show(v))}`).join(" ");
      return `<b style="color:${colorOf(ROLE_COLOR[role])}">${esc(role)}</b> ${esc(event)}  ${short}`;
    } catch { return esc(line); }
  }
  const stamp = (line) => { try { return Date.parse(JSON.parse(line).t) || 0; } catch { return 0; } };
  // Merged by timestamp; lines in the same millisecond keep the order given (each file's tail is in write order).
  function setLogs(lines) {
    const box = document.querySelector("#bbb-logs .lines");
    if (!box) return;
    const ordered = lines.map((l, i) => ({ l, i, t: stamp(l) })).sort((a, b) => a.t - b.t || a.i - b.i).slice(-MAX_LINES);
    const html = ordered.map((o) => fmt(o.l)).join("\n");
    if (html !== lastLogs) { box.innerHTML = html; lastLogs = html; }
  }

  // ---------- a cover across a navigation ----------
  // coverArgs measures the caption bar so the cover's bar takes the same width and height and the text does not
  // move. cover puts the sheet on the current document as soon as it has a root; a newer cover (higher seq)
  // replaces an older one, and a document created after `expires` gets none, or it would keep one.
  function coverArgs(line, waitMs = 20000) {
    const r = $("bbb-cap")?.getBoundingClientRect();
    const size = r ? `width:${r.width}px;height:${r.height}px` : `width:100%;min-height:${CAP_H - 30}px`;
    return { css: { ...COVER_CSS, bar: `${COVER_CSS.bar};${size}` }, text: line.caption || "", note: line.note || "", seq: Date.now(), expires: Date.now() + waitMs };
  }
  function cover({ css, text, note, seq, expires }) {
    const put = () => {
      if (Date.now() > expires) return true;
      const root = document.documentElement; if (!root) return false;
      const old = document.getElementById("bbb-cover");
      if (old && Number(old.dataset.seq) >= seq) return true;
      old?.remove();
      const d = document.createElement("div"); d.id = "bbb-cover"; d.dataset.seq = String(seq); d.setAttribute("style", css.cover);
      const bar = document.createElement("div"); bar.setAttribute("style", css.bar);
      const t = document.createElement("div"); t.setAttribute("style", css.text); t.textContent = text; bar.appendChild(t);
      if (note) { const n = document.createElement("div"); n.setAttribute("style", css.note); n.textContent = note; bar.appendChild(n); }
      d.appendChild(bar); root.appendChild(d);
      return true;
    };
    if (!put()) new MutationObserver((_, mo) => { if (put()) mo.disconnect(); }).observe(document, { childList: true, subtree: true });
  }
  const uncover = () => { for (const c of document.querySelectorAll("#bbb-cover")) c.remove(); };

  window.BBB = { install, apply, dropCard, cardMs, focusOn, selectorFor, setLogs, fmt, coverArgs, cover, uncover, colorOf,
    COLORS, ROLE_COLOR, SCENE_COLOR, STEPS, STEP_INDEX, FONT, OVERLAY_W, TOP_H, CAP_H, TITLE_MS, FOCUS_WAIT_MS, MAX_LINES };
})();
