// docs/app.js — the page is built from chain state plus the contract's event history. No backend.
import { createPublicClient, http, formatEther } from "https://esm.sh/viem@2";
import { baseSepolia, foundry } from "https://esm.sh/viem@2/chains";

const STATES = ["Committed","Revealed","Confirmed","Disputed","Refuted","Upheld","Unadjudicated","Withdrawn","Unarbitrated"];
const REASONS = ["cannot decrypt", "commit mismatch", "not reproduced"];
const CHUNK_START = 2000n;
const CHUNK_FLOOR = 16n;
const ACTIVITY_ROWS = 12;

const $ = (id) => document.getElementById(id);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

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
let lastSeen = BigInt(dep.deployedBlock ?? 0) - 1n;
let chunk = CHUNK_START;
const blockTime = new Map();     // blockNumber (string) -> unix seconds

async function fetchRange(from, to) {
  const got = await client.getLogs({ address: dep.address, events: EVENTS, fromBlock: from, toBlock: to });
  for (const l of got) logs.push(l);
}

async function syncLogs() {
  const latest = await client.getBlockNumber();
  let from = lastSeen + 1n;
  while (from <= latest) {
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    try {
      await fetchRange(from, to);
      lastSeen = to;
      from = to + 1n;
    } catch (e) {
      // Public RPCs cap the block span of one getLogs call; halve until it fits, then give up loudly.
      if (chunk > CHUNK_FLOOR) { chunk = chunk / 2n; continue; }
      throw e;
    }
  }
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex - b.logIndex) : (a.blockNumber < b.blockNumber ? -1 : 1)));
  const missing = [...new Set(logs.map((l) => l.blockNumber.toString()))].filter((n) => !blockTime.has(n));
  await Promise.all(missing.map(async (n) => {
    const b = await client.getBlock({ blockNumber: BigInt(n) });
    blockTime.set(n, Number(b.timestamp));
  }));
}

const when = (l) => {
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
    default: return `${sale} ${claim}`.trim();
  }
}

const row = (l) => `<li><span class="ev ${esc(l.eventName)}">${esc(l.eventName)}</span><span>${describe(l)} <span class="when">${when(l)}</span></span><span>${txLink(l.transactionHash)}</span></li>`;

// ---------- state ----------
async function load() {
  await syncLogs();
  const nClaims = Number(await read("claimCount"));
  const nSales = Number(await read("saleCount"));
  const claims = [], sales = [];
  for (let i = 0; i < nClaims; i++) claims.push({ id: i, ...(await read("getClaim", [BigInt(i)])) });
  for (let i = 0; i < nSales; i++) sales.push({ id: i, ...(await read("getSale", [BigInt(i)])) });
  const addrs = new Set([...claims.map(c => c.buyer), ...sales.map(s => s.seller)]);
  const reps = {};
  for (const a of addrs) {
    const r = await read("rep", [a]);
    reps[a] = { sellerConfirmed: r[0], sellerRefuted: r[1], sellerUnadjudicated: r[2], sellerWithdrawn: r[3], sellerUnarbitrated: r[4],
                buyerAdjudicated: r[5], buyerSilent: r[6], buyerDisputesLost: r[7] };
  }
  render(claims, sales, reps, new Set(claims.map(c => c.buyer)), new Set(sales.map(s => s.seller)));
}

function sellerHeadline(r) {
  // Only adjudicated outcomes move the headline. Silence, withdrawal and an absent arbiter are shown, never folded in.
  const adverse = [];
  if (r.sellerRefuted > 0) adverse.push(`${r.sellerRefuted} refuted`);
  if (r.sellerWithdrawn > 0) adverse.push(`${r.sellerWithdrawn} withdrawn`);
  if (r.sellerUnarbitrated > 0) adverse.push(`${r.sellerUnarbitrated} unarbitrated`);
  if (r.sellerConfirmed > 0) return { text: `${r.sellerConfirmed} confirmed`, cls: "ok", beside: adverse.join(" · ") };
  if (r.sellerRefuted > 0) return { text: "refuted history", cls: "bad", beside: "" };
  return { text: "unverified", cls: "unk", beside: "" };
}

function render(claims, sales, reps, buyers, sellers) {
  const postedTx = {};
  for (const l of logs) if (l.eventName === "ClaimPosted") postedTx[l.args.claimId.toString()] = l.transactionHash;

  $("claims").innerHTML = claims.map(c => `
    <div class="card">
      <div class="row"><b>Claim #${c.id}</b><span class="muted">${c.closed ? "closed" : "open"}${postedTx[c.id] ? ` · ${txLink(postedTx[c.id])}` : ""}</span></div>
      <div class="muted">buyer ${addrLink(c.buyer)} · bounty ${formatEther(c.bounty)} ETH × ${c.maxHits} · bought ${c.hits} · pending ${c.pending}</div>
      <div class="mono muted" style="margin-top:6px">${esc(c.modelId)}</div>
      <div style="margin-top:6px">${esc(c.spec)}</div>
    </div>`).join("") || `<div class="muted">No claims yet.</div>`;

  $("activity").innerHTML = logs.slice(-ACTIVITY_ROWS).reverse().map(row).join("") || `<li class="muted">No events yet.</li>`;

  $("sales").innerHTML = sales.slice().reverse().map(s => {
    const st = STATES[s.state] ?? `state ${s.state}`;
    const pt = s.plaintext && s.plaintext !== "0x" ? new TextDecoder().decode(hexToBytes(s.plaintext)) : null;
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
    return `
    <div class="card" data-addr="${a}">
      <div class="row">${addrLink(a)}<span class="muted">${isSeller ? "seller" : ""}${isSeller && isBuyer ? " · " : ""}${isBuyer ? "buyer" : ""}</span></div>
      ${isSeller ? `<div class="head ${h.cls}"><span class="headline">${h.text}</span>${h.beside ? `<span class="adverse">${h.beside}</span>` : ""}</div>
      <div class="triple"><div><b>${r.sellerConfirmed}</b>confirmed</div><div><b>${r.sellerRefuted}</b>refuted</div><div><b>${r.sellerUnadjudicated}</b>unadjudicated</div></div>
      <div class="small"><div><b>${r.sellerWithdrawn}</b>withdrawn <span class="dim">(never revealed or never disclosed)</span></div><div><b>${r.sellerUnarbitrated}</b>unarbitrated <span class="dim">(arbiter never ruled)</span></div></div>` : ""}
      ${isBuyer ? `<div class="triple" style="margin-top:8px"><div><b>${r.buyerAdjudicated}</b>adjudicated</div><div><b>${r.buyerSilent}</b>silent</div><div><b>${r.buyerDisputesLost}</b>disputes lost</div></div>` : ""}
    </div>`;
  }).join("") || `<div class="muted">Nobody yet.</div>`;

  $("foot").textContent = `Refreshed ${new Date().toLocaleTimeString()} · ${logs.length} events through block ${lastSeen}. A seller reads "unverified" until a sale is confirmed or refuted; sales paid in silence never count as confirmed.`;
}

function hexToBytes(hex) { const h = hex.slice(2); const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; }

try { await load(); } catch (e) { $("foot").textContent = "load failed: " + e.message; }
setInterval(() => load().catch(e => { $("foot").textContent = "refresh failed: " + e.message; }), 5000);
