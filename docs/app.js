// docs/app.js — the page is built from chain state plus the contract's event history. No backend.
import { createPublicClient, http, formatEther } from "https://esm.sh/viem@2";
import { baseSepolia, foundry } from "https://esm.sh/viem@2/chains";

const STATES = ["Committed","Revealed","Confirmed","Disputed","Refuted","Upheld","Unadjudicated","Withdrawn","Unarbitrated"];
const REASONS = ["cannot decrypt", "commit mismatch", "not reproduced"];
const CHUNK_START = 2000n;
const CHUNK_FLOOR = 16n;
const ACTIVITY_ROWS = 12;
const REFRESH_MS = new URLSearchParams(location.search).get("record") === "1" ? 1500 : 5000; // the recorder wants the badge under its caption
// A getLogs error that names the span is the RPC's cap; anything else is transient and retried.
const RANGE_ERROR = /range|limit|too many|exceed/i;
const RETRIES = 3;
const RETRY_MS = 2000;

const $ = (id) => document.getElementById(id);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// ?record=1 is the recorder's view: the thesis and each claim's spec text are hidden and cards are tighter, so the
// cards the captions point at fit beside the recorder's overlay. index.html carries the .record rules.
if (new URLSearchParams(location.search).get("record") === "1") document.documentElement.classList.add("record");

const dep = await (await fetch("./deployment.json", { cache: "no-store" })).json();
const abi = await (await fetch("./abi.json", { cache: "no-store" })).json();
const EVENTS = abi.filter((x) => x.type === "event");
const chain = dep.chainId === 84532 ? baseSepolia : foundry;
const client = createPublicClient({ chain, transport: http(dep.rpc) });
const addrLink = (a) => dep.explorer ? `<a href="${dep.explorer}/address/${a}" target="_blank" class="mono">${short(a)}</a>` : `<span class="mono">${short(a)}</span>`;
const txLink = (h) => dep.explorer ? `<a href="${dep.explorer}/tx/${h}" target="_blank" class="mono" title="${h}">${short(h)}</a>` : `<span class="mono" title="${h}">${short(h)}</span>`;
$("meta").innerHTML = `contract ${addrLink(dep.address)} · chain ${dep.chainId} · rpc ${esc(dep.rpc)}`;

const read = (fn, args = []) => client.readContract({ address: dep.address, abi, functionName: fn, args });

// ---------- event history ----------
// Fetched once from the deployment block in chunks, then only the blocks after the last one seen.
const logs = [];                 // every decoded log, in block order
const seen = new Set();          // transactionHash:logIndex, so a re-read range never doubles a row
let lastSeen = BigInt(dep.deployedBlock ?? 0) - 1n;
let chunk = CHUNK_START;
const blockTime = new Map();     // blockNumber (string) -> unix seconds

async function fetchRange(from, to) {
  const got = await client.getLogs({ address: dep.address, events: EVENTS, fromBlock: from, toBlock: to });
  for (const l of got) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    logs.push(l);
  }
}

async function syncLogs() {
  const latest = await client.getBlockNumber();
  let from = lastSeen + 1n;
  let retries = 0;
  while (from <= latest) {
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    try {
      await fetchRange(from, to);
      lastSeen = to;
      from = to + 1n;
      retries = 0;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (RANGE_ERROR.test(msg)) {
        // Public RPCs cap the block span of one getLogs call; halve until it fits, then give up loudly.
        if (chunk > CHUNK_FLOOR) { chunk = chunk / 2n; continue; }
        throw e;
      }
      // A dropped connection or a server error: the same range again, a few times, then give up loudly.
      if (retries < RETRIES) { retries++; await pause(RETRY_MS); continue; }
      throw e;
    }
  }
  chunk = CHUNK_START;   // a full pass got through; the next one starts wide again
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex - b.logIndex) : (a.blockNumber < b.blockNumber ? -1 : 1)));
  const missing = [...new Set(logs.map((l) => l.blockNumber.toString()))].filter((n) => !blockTime.has(n));
  await Promise.all(missing.map(async (n) => {
    const b = await client.getBlock({ blockNumber: BigInt(n) });
    blockTime.set(n, Number(b.timestamp));
  }));
}

// On anvil (31337) the clock is whatever evm_increaseTime last made it, so an event is placed by block number
// alone; on other chains the block's clock time is shown beside it.
const when = (l) => {
  if (dep.chainId === 31337) return `#${l.blockNumber}`;
  const ts = blockTime.get(l.blockNumber.toString());
  const clock = ts ? new Date(ts * 1000).toLocaleTimeString([], { hour12: false }) : "";
  return `${clock ? clock + " · " : ""}#${l.blockNumber}`;
};

function describe(l) {
  const a = l.args ?? {};
  const sale = a.saleId !== undefined ? `sale #${a.saleId}` : "";
  const claim = a.claimId !== undefined ? `claim #${a.claimId}` : "";
  switch (l.eventName) {
    case "ClaimPosted": return `${claim} by ${addrLink(a.buyer)} · ${formatEther(a.bounty)} ETH × ${a.maxHits}`;
    case "ClaimClosed": return `${claim} · refunded ${formatEther(a.refunded)} ETH`;
    case "Committed": return `${sale} on ${claim} · seller ${addrLink(a.seller)} · bond ${formatEther(a.bond)} ETH`;
    case "Revealed": return `${sale} · ${(a.ciphertext.length - 2) / 2} bytes encrypted to the buyer`;
    case "Confirmed": return `${sale} · buyer reproduced the failure, seller paid`;
    case "Disputed": return `${sale} · <span class="reason">${REASONS[a.reason] ?? "reason " + a.reason}</span> · buyer bond ${formatEther(a.buyerBond)} ETH`;
    case "Disclosed": return `${sale} · plaintext, salt and ephemeral secret now public`;
    case "Ruled": return `${sale} · arbiter: ${a.sellerWasRight ? "seller upheld" : "seller refuted"}`;
    case "Settled": return `${sale} · buyer silent past the window, paid as unadjudicated`;
    case "Withdrawn": return `${sale} · ${esc(a.reason)}, seller bond to buyer`;
    case "Unarbitrated": return `${sale} · arbiter never ruled, each bond returned`;
    case "PaymentDeferred": return `${addrLink(a.to)} refused ${formatEther(a.amount)} ETH · credited to owed, withdraw() to collect`;
    case "Paid": return `${addrLink(a.to)} withdrew ${formatEther(a.amount)} ETH`;
    default: return `${sale} ${claim}`.trim();
  }
}

const row = (l) => `<li><span class="ev ${esc(l.eventName)}">${esc(l.eventName)}</span><span>${describe(l)} <span class="when">${when(l)}</span></span><span>${txLink(l.transactionHash)}</span></li>`;

// ---------- state ----------
let busy = false;   // one load at a time; a tick that lands mid-load is skipped, not queued
async function load() {
  if (busy) return;
  busy = true;
  try {
    await syncLogs();
    const nClaims = Number(await read("claimCount"));
    const nSales = Number(await read("saleCount"));
    const claims = [], sales = [];
    for (let i = 0; i < nClaims; i++) claims.push({ id: i, ...(await read("getClaim", [BigInt(i)])) });
    for (let i = 0; i < nSales; i++) sales.push({ id: i, ...(await read("getSale", [BigInt(i)])) });
    const addrs = new Set([...claims.map(c => c.buyer), ...sales.map(s => s.seller)]);
    const reps = {}, owed = {};
    for (const a of addrs) {
      const r = await read("rep", [a]);
      reps[a] = { sellerConfirmed: r[0], sellerRefuted: r[1], sellerUnadjudicated: r[2], sellerWithdrawn: r[3], sellerUnarbitrated: r[4],
                  buyerAdjudicated: r[5], buyerSilent: r[6], buyerDisputesLost: r[7] };
      owed[a] = await read("owed", [a]);
    }
    render(claims, sales, reps, owed, new Set(claims.map(c => c.buyer)), new Set(sales.map(s => s.seller)));
  } finally {
    busy = false;
  }
}

// The headline is decided top-down: a confirmation beats every other outcome; below that, the worst
// adverse outcome names the history; silence alone is "unverified"; nothing settled is "no history".
// The adverse counts are shown beside the headline whenever any of them is non-zero.
function sellerHeadline(r) {
  const adverse = [];
  if (r.sellerRefuted > 0) adverse.push(`${r.sellerRefuted} refuted`);
  if (r.sellerWithdrawn > 0) adverse.push(`${r.sellerWithdrawn} withdrawn`);
  if (r.sellerUnarbitrated > 0) adverse.push(`${r.sellerUnarbitrated} unarbitrated`);
  const beside = adverse.join(" · ");
  if (r.sellerConfirmed > 0) return { text: `${r.sellerConfirmed} confirmed`, cls: "ok", beside };
  if (r.sellerRefuted > 0) return { text: "refuted history", cls: "bad", beside };
  if (r.sellerWithdrawn > 0) return { text: "withdrawn history", cls: "bad", beside };
  if (r.sellerUnarbitrated > 0) return { text: "unarbitrated history", cls: "warn", beside };
  if (r.sellerUnadjudicated > 0) return { text: "unverified", cls: "unk", beside };
  return { text: "no history", cls: "unk", beside };
}

function render(claims, sales, reps, owed, buyers, sellers) {
  const postedTx = {};
  for (const l of logs) if (l.eventName === "ClaimPosted") postedTx[l.args.claimId.toString()] = l.transactionHash;

  $("claims").innerHTML = claims.map(c => `
    <div class="card" data-claim="${c.id}">
      <div class="row"><b>Claim #${c.id}</b><span class="muted">${c.closed ? "closed" : "open"}${postedTx[c.id] ? ` · ${txLink(postedTx[c.id])}` : ""}</span></div>
      <div class="muted">buyer ${addrLink(c.buyer)} · bounty ${formatEther(c.bounty)} ETH × ${c.maxHits} · bought ${c.hits} · pending ${c.pending}</div>
      <div class="mono muted" style="margin-top:6px">${esc(c.modelId)}</div>
      <div class="spec" style="margin-top:6px">${esc(c.spec)}</div>
    </div>`).join("") || `<div class="muted">No claims yet.</div>`;

  $("activity").innerHTML = logs.slice(-ACTIVITY_ROWS).reverse().map(row).join("") || `<li class="muted">No events yet.</li>`;

  $("sales").innerHTML = sales.slice().reverse().map(s => {
    const st = STATES[s.state] ?? `state ${s.state}`;
    const pt = s.disclosedAt > 0n && s.plaintext && s.plaintext !== "0x" ? new TextDecoder().decode(hexToBytes(s.plaintext)) : null;
    const disputed = s.disputedAt > 0n;
    const mine = logs.filter((l) => l.args?.saleId !== undefined && l.args.saleId === BigInt(s.id));
    return `
    <div class="card" data-sale="${s.id}">
      <div class="row"><b>Sale #${s.id} <span class="muted">on claim #${s.claimId}</span></b>
        <span>${disputed ? `<span class="reason">dispute: ${REASONS[s.disputeReason] ?? "reason " + s.disputeReason}</span> ` : ""}<span class="badge ${st}">${st}</span></span></div>
      <div class="muted">seller ${addrLink(s.seller)} · bond ${formatEther(s.sellerBond)} ETH${s.buyerBond > 0n ? ` · buyer bond ${formatEther(s.buyerBond)} ETH` : ""}</div>
      <div class="mono muted" style="margin-top:4px">commit ${short(s.commitHash)}</div>
      ${s.ciphertext && s.ciphertext !== "0x" ? `<div class="ct mono">reveal (encrypted to buyer): ${s.ciphertext}</div>` : ""}
      ${pt ? `<div class="mono" style="margin-top:4px">disclosed in dispute: <b>${esc(pt)}</b> — now public</div>` : ""}
      <ul class="tl">${mine.map(row).join("") || `<li class="dim">no events yet</li>`}</ul>
    </div>`;
  }).join("") || `<div class="muted">No sales yet.</div>`;

  $("rep").innerHTML = Object.entries(reps).map(([a, r]) => {
    const isSeller = sellers.has(a) || r.sellerConfirmed + r.sellerRefuted + r.sellerUnadjudicated + r.sellerWithdrawn + r.sellerUnarbitrated > 0;
    const isBuyer = buyers.has(a) || r.buyerAdjudicated + r.buyerSilent > 0;
    const h = sellerHeadline(r);
    const due = owed[a] ?? 0n;
    return `
    <div class="card" data-addr="${a.toLowerCase()}">
      <div class="row">${addrLink(a)}<span class="muted">${isSeller ? "seller" : ""}${isSeller && isBuyer ? " · " : ""}${isBuyer ? "buyer" : ""}</span></div>
      ${isSeller ? `<div class="head ${h.cls}"><span class="headline">${h.text}</span>${h.beside ? `<span class="adverse">${h.beside}</span>` : ""}</div>
      <div class="triple"><div><b>${r.sellerConfirmed}</b>confirmed</div><div><b>${r.sellerRefuted}</b>refuted</div><div><b>${r.sellerUnadjudicated}</b>unadjudicated</div></div>
      <div class="small"><div><b>${r.sellerWithdrawn}</b>withdrawn <span class="dim">(never revealed or never disclosed)</span></div><div><b>${r.sellerUnarbitrated}</b>unarbitrated <span class="dim">(arbiter never ruled)</span></div></div>` : ""}
      ${isBuyer ? `<div class="triple" style="margin-top:8px"><div><b>${r.buyerAdjudicated}</b>adjudicated</div><div><b>${r.buyerSilent}</b>silent</div><div><b>${r.buyerDisputesLost}</b>disputes lost</div></div>` : ""}
      ${due > 0n ? `<div class="owed">${formatEther(due)} ETH deferred, withdraw() to collect</div>` : ""}
    </div>`;
  }).join("") || `<div class="muted">Nobody yet.</div>`;

  $("foot").textContent = `Refreshed ${new Date().toLocaleTimeString()} · ${logs.length} events through block ${lastSeen}. A seller reads "unverified" while its only settled sales are unadjudicated; sales paid in silence never count as confirmed.`;
}

function hexToBytes(hex) { const h = hex.slice(2); const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; }

try { await load(); } catch (e) { $("foot").textContent = "load failed: " + e.message; }
setInterval(() => load().catch(e => { $("foot").textContent = "refresh failed: " + e.message; }), REFRESH_MS);
