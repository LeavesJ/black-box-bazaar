// docs/app.js
import { createPublicClient, http, formatEther } from "https://esm.sh/viem@2";
import { baseSepolia, foundry } from "https://esm.sh/viem@2/chains";

const STATES = ["Committed","Revealed","Confirmed","Disputed","Refuted","Upheld","Unadjudicated","Withdrawn"];
const $ = (id) => document.getElementById(id);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

const dep = await (await fetch("./deployment.json", { cache: "no-store" })).json();
const abi = await (await fetch("./abi.json", { cache: "no-store" })).json();
const chain = dep.chainId === 84532 ? baseSepolia : foundry;
const client = createPublicClient({ chain, transport: http(dep.rpc) });
const addrLink = (a) => dep.explorer ? `<a href="${dep.explorer}/address/${a}" target="_blank" class="mono">${short(a)}</a>` : `<span class="mono">${short(a)}</span>`;
$("meta").innerHTML = `contract ${addrLink(dep.address)} · chain ${dep.chainId} · rpc ${esc(dep.rpc)}`;

const read = (fn, args = []) => client.readContract({ address: dep.address, abi, functionName: fn, args });

async function load() {
  const nClaims = Number(await read("claimCount"));
  const nSales = Number(await read("saleCount"));
  const claims = [], sales = [];
  for (let i = 0; i < nClaims; i++) claims.push({ id: i, ...(await read("getClaim", [BigInt(i)])) });
  for (let i = 0; i < nSales; i++) sales.push({ id: i, ...(await read("getSale", [BigInt(i)])) });
  const addrs = new Set([...claims.map(c => c.buyer), ...sales.map(s => s.seller)]);
  const reps = {};
  for (const a of addrs) {
    const r = await read("rep", [a]);
    reps[a] = { sellerConfirmed: r[0], sellerRefuted: r[1], sellerUnadjudicated: r[2], sellerWithdrawn: r[3], buyerAdjudicated: r[4], buyerSilent: r[5], buyerDisputesLost: r[6] };
  }
  render(claims, sales, reps);
}

function render(claims, sales, reps) {
  $("claims").innerHTML = claims.map(c => `
    <div class="card">
      <div class="row"><b>Claim #${c.id}</b><span class="muted">${c.closed ? "closed" : "open"}</span></div>
      <div class="muted">buyer ${addrLink(c.buyer)} · bounty ${formatEther(c.bounty)} ETH × ${c.maxHits} · bought ${c.hits} · pending ${c.pending}</div>
      <div class="mono muted" style="margin-top:6px">${esc(c.modelId)}</div>
      <div style="margin-top:6px">${esc(c.spec)}</div>
    </div>`).join("") || `<div class="muted">No claims yet.</div>`;

  $("sales").innerHTML = sales.slice().reverse().map(s => {
    const st = STATES[s.state];
    const pt = s.plaintext && s.plaintext !== "0x" ? new TextDecoder().decode(hexToBytes(s.plaintext)) : null;
    return `
    <div class="card">
      <div class="row"><b>Sale #${s.id} <span class="muted">on claim #${s.claimId}</span></b><span class="badge ${st}">${st}</span></div>
      <div class="muted">seller ${addrLink(s.seller)} · bond ${formatEther(s.sellerBond)} ETH${s.buyerBond > 0n ? ` · buyer bond ${formatEther(s.buyerBond)} ETH` : ""}</div>
      <div class="mono muted" style="margin-top:4px">commit ${short(s.commitHash)}</div>
      ${s.ciphertext && s.ciphertext !== "0x" ? `<div class="ct mono">reveal (encrypted to buyer): ${s.ciphertext}</div>` : ""}
      ${pt ? `<div class="mono" style="margin-top:4px">disclosed in dispute: <b>${esc(pt)}</b> — now public</div>` : ""}
    </div>`;
  }).join("") || `<div class="muted">No sales yet.</div>`;

  $("rep").innerHTML = Object.entries(reps).map(([a, r]) => {
    const isSeller = r.sellerConfirmed + r.sellerRefuted + r.sellerUnadjudicated + r.sellerWithdrawn > 0;
    const isBuyer = r.buyerAdjudicated + r.buyerSilent > 0;
    let head = "", cls = "unk";
    if (isSeller) {
      if (r.sellerConfirmed === 0) { head = "unknown"; cls = "unk"; }
      else { const bad = r.sellerRefuted + r.sellerWithdrawn; head = `${r.sellerConfirmed} confirmed`; cls = bad > 0 ? "bad" : "ok"; }
    }
    return `
    <div class="card">
      <div class="row">${addrLink(a)}<span class="muted">${isSeller ? "seller" : ""}${isSeller && isBuyer ? " · " : ""}${isBuyer ? "buyer" : ""}</span></div>
      ${isSeller ? `<div class="head ${cls}">${head}</div>
      <div class="triple"><div><b>${r.sellerConfirmed}</b>confirmed</div><div><b>${r.sellerRefuted + r.sellerWithdrawn}</b>refuted</div><div><b>${r.sellerUnadjudicated}</b>unadjudicated</div></div>` : ""}
      ${isBuyer ? `<div class="triple" style="margin-top:8px"><div><b>${r.buyerAdjudicated}</b>adjudicated</div><div><b>${r.buyerSilent}</b>silent</div><div><b>${r.buyerDisputesLost}</b>disputes lost</div></div>` : ""}
    </div>`;
  }).join("") || `<div class="muted">Nobody yet.</div>`;

  $("foot").textContent = `Refreshed ${new Date().toLocaleTimeString()}. A seller reads "unknown" until at least one sale is confirmed, no matter how many were paid in silence.`;
}

function hexToBytes(hex) { const h = hex.slice(2); const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; }

await load();
setInterval(() => load().catch(e => { $("foot").textContent = "refresh failed: " + e.message; }), 5000);
