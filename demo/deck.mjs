// demo/deck.mjs — the step presenter's deck, in order: the opening slides, the four scenes (a title card, then one
// live step per on-chain moment), and the closing slides. demo/console.mjs serves it (GET /api/deck) and walks it
// one ▶ at a time; docs/present.js shows it. The slides themselves are in demo/present-slides.mjs.
// A live step's enter(ctx) runs once when the step is entered and does exactly one thing: post a claim, start an
// agent, release one agent's next transaction, or jump the local clock. ready(ctx) is polled until the chain or a
// log shows the result. view(ctx) builds the caption from values read at that moment, at enter and again at ready;
// a sentence whose value is missing is left out, and on a branch the scene did not plan for (a buyer that disputes
// where it was expected to confirm, an arbiter that upholds) the caption says what the chain says.
// Other fields: working (shown while it waits), progress(ctx), timeout (s), waits (named in a timeout's error),
// agent (the process whose exit means the wait is over for nothing), who (whose log a failure quotes), restart (Retry
// may start that agent again once it has stopped: only a hunt, whose seller has committed nothing and whose commit
// gate was never opened; demo/console.mjs restartable).
// ctx is demo/present-ctx.mjs makeCtx.
import { CLOSING, INTRO } from "./present-slides.mjs";
import { ST, fill, reasonText, says, span, tallyByCounts, word } from "./present-ctx.mjs";

const HUNT_S = 480;
// Pairs a hunt may have the model answer before it gives up (a failed call is not one). About 1 in 10 is a
// counterexample, so 200 all but never runs out (0.9^200); the agents' default of 40 ran out about 1.5% of the time.
const HUNT_BUDGET = "200";
const LOG_GRACE_MS = 15_000;
const NAME = { seller: "seller", rogue: "rogue", newcomer: "newcomer", quiet: "quiet wallet", buyer: "buyer", arbiter: "arbiter", sweep: "sweep" };
const live = (scene, id, label, step, color, def) => ({ id, kind: "live", scene, label, step, color, ...def });
const card = (scene, title, subtitle, say) =>
  ({ id: `scene${scene}`, kind: "card", scene, label: `Scene ${scene}: ${title}`, slide: { layout: "card", kicker: `Scene ${scene} of 4`, title, subtitle }, say });
const onSale = (id, label) => (id === undefined || id === null ? {} : { focus: `sale:${id}`, label: label || `SALE #${id}` });
const tries = (n) => (Number(n) === 1 ? "on its first try" : fill`after ${word(n)} tries`);
const decided = (g) => {
  if (!g) return "";
  if (g.action === "confirm") return "It has decided to confirm, and waits for me.";
  return fill`It has decided to dispute: ${reasonText(g.reason ?? g.reasonName)}.` || "It has decided to dispute, and waits for me.";
};
const settledAs = (s) => (s && s.terminal ? `Sale #${s.id} is ${s.stateName.toLowerCase()}.` : "");

// ---------- the moves every scene repeats ----------
/** A seller-side wallet starts hunting on a claim; ready once it has a pair and waits at its commit. */
const hunt = (scene, id, label, role, color, o) => live(scene, id, label, "commit", color, {
  timeout: HUNT_S, agent: role, restart: true, waits: `the ${NAME[role]} to find a pair and wait at its commit`, working: o.working,
  async enter(ctx) {
    if (o.before) await o.before(ctx);
    const claim = ctx.vars[o.claim];
    if (claim === undefined || claim === null) throw new Error(`there is no claim to hunt on (${o.claim} was never posted)`);
    ctx.startAgent(role, ["seller", "--", "hunt", "--claim", String(claim), "--max", "1", "--role", role, ...(o.attack ? ["--attack", o.attack] : []),
      "--budget", HUNT_BUDGET, "--seconds", "14400"]);
  },
  ready: (ctx) => !!ctx.gate(role, /^commit$/),
  // Pairs tried so far, and a failed call when it is newer than the last pair (the seller tries it again).
  progress(ctx) {
    const p = ctx.log(role, null, /^probe$/), f = ctx.log(role, null, /^sell loop failed/);
    const tried = p && p.tries != null ? `${p.tries} ${Number(p.tries) === 1 ? "pair" : "pairs"} tried` : "";
    return [tried, f && (!p || String(f.t) > String(p.t)) ? "the last call failed, retrying" : ""].filter(Boolean).join(" · ");
  },
  async view(ctx) {
    const waiting = !!ctx.gate(role, /^commit$/);
    return { caption: await o.caption(ctx), note: waiting && o.note ? o.note : "" };
  },
  say: o.say,
});
/** Releases that wallet's commit; ready once its sale is on-chain (id from its own "committed" line) and its reveal waits. */
const commit = (scene, id, label, role, color, sVar, o) => live(scene, id, label, "commit", color, {
  agent: role, waits: `the ${NAME[role]}'s sale to appear on-chain and its reveal to wait for release`,
  working: `The ${NAME[role]}'s commit is going on-chain.`,
  enter(ctx) { ctx.release(role, /^commit$/); },
  async ready(ctx) {
    const c = ctx.log(role, null, /^committed$/);
    const s = c && await ctx.sale(c.saleId);
    if (!s || s.seller.toLowerCase() !== ctx.addr(role).toLowerCase()) return false;
    ctx.vars[sVar] = s.id;
    return !!ctx.gate(role, /^reveal$/, s.id) || s.state !== ST.Committed;
  },
  async view(ctx) {
    const s = await ctx.sale(ctx.vars[sVar]);
    return s ? { caption: o.caption(ctx, s), note: o.note || "", ...onSale(s.id, o.tag && o.tag(s.id)) } : {};
  },
  say: o.say,
});
/** Releases that wallet's reveal; ready once revealedAt is set. */
const reveal = (scene, id, label, role, color, sVar, o) => live(scene, id, label, "reveal", color, {
  agent: role, waits: `the ${NAME[role]}'s reveal to land on-chain`, working: `The ${NAME[role]}'s reveal is going on-chain.`,
  enter(ctx) { ctx.release(role, /^reveal$/, ctx.vars[sVar]); },
  async ready(ctx) {
    const s = await ctx.sale(ctx.vars[sVar]);
    if (!s?.revealed) return false;
    if (!o.logged || ctx.log(role, s.id, o.logged)) return true;
    // A seller logs its reveal once its receipt arrives, which can be seconds after the block. A caption that quotes
    // that line waits for it, and after LOG_GRACE_MS goes on without it (the caption then says only what the chain says).
    const seen = (ctx.vars[`${id}:revealSeen`] ??= Date.now());
    return Date.now() - seen > LOG_GRACE_MS;
  },
  async view(ctx) {
    const s = await ctx.sale(ctx.vars[sVar]);
    return s ? { caption: s.revealed ? o.caption(ctx, s) : "", note: s.revealed && o.note ? o.note(ctx, s) : "", ...onSale(s.id) } : {};
  },
  say: o.say,
});
/** Nothing to release: the buyer decides by itself; ready once its confirm or dispute waits at a gate. */
const buyerCheck = (scene, id, sVar, o) => live(scene, id, "Buyer checks", "adjudicate", "blue", {
  agent: "buyer", waits: "the buyer's verdict to wait for release", working: o.working || "The buyer is decrypting and re-running the model.",
  ready: (ctx) => !!ctx.gate("buyer", /^(confirm|dispute)$/, ctx.vars[sVar]),
  view(ctx) {
    const s = ctx.vars[sVar], rr = ctx.log("buyer", s, /^re-run result$/);
    let caption = "";
    if (rr) caption = says(o.rerun(rr), tallyByCounts(rr));
    else if (ctx.log("buyer", s, /^cannot decrypt/)) caption = "The buyer can't decrypt it.";
    else if (ctx.log("buyer", s, /commit check/)) caption = "The buyer decrypts it, but it doesn't match the commitment.";
    else if (ctx.log("buyer", s, /not a pair/)) caption = "The buyer decrypts it, but it isn't a pair of three-digit numbers.";
    return { caption, note: decided(ctx.gate("buyer", /^(confirm|dispute)$/, s)), ...onSale(s) };
  },
  say: o.say,
});
/** Releases whatever the buyer decided; ready once the sale has moved past Revealed (and the seller waits to disclose). */
const buyerAct = (scene, id, label, step, sVar, o) => live(scene, id, label, step, "blue", {
  agent: "buyer", waits: "the buyer's transaction to land on-chain", working: "The buyer's transaction is going on-chain.",
  enter(ctx) { ctx.release("buyer", /^(confirm|dispute)$/, ctx.vars[sVar]); },
  async ready(ctx) {
    const s = await ctx.sale(ctx.vars[sVar]);
    if (!s || s.state === ST.Committed || s.state === ST.Revealed) return false;
    if (o.discloser && s.state === ST.Disputed && !s.disclosed) return !!ctx.gate(o.discloser, /^disclose$/, s.id);
    return true;
  },
  async view(ctx) {
    const s = await ctx.sale(ctx.vars[sVar]);
    if (!s || s.state === ST.Committed || s.state === ST.Revealed) return { ...onSale(s?.id) };
    if (s.state === ST.Confirmed) return { caption: o.confirmed, ...onSale(s.id) };
    if (s.disputed) return { caption: o.disputed(s), note: o.disputeNote || "", ...onSale(s.id) };
    return { caption: settledAs(s), ...onSale(s.id) };
  },
  say: o.say,
});
/** Releases the seller's disclosure; ready once disclosedAt is set, or the sale is already settled. */
const disclose = (scene, id, label, role, color, sVar, o) => live(scene, id, label, "dispute", color, {
  agent: role, waits: `the ${NAME[role]}'s disclosure to land on-chain`, working: `The ${NAME[role]}'s disclosure is going on-chain.`,
  async enter(ctx) { if (!(await ctx.sale(ctx.vars[sVar]))?.terminal) ctx.release(role, /^disclose$/, ctx.vars[sVar]); },
  ready: async (ctx) => { const s = await ctx.sale(ctx.vars[sVar]); return !!s && (s.disclosed || s.terminal); },
  async view(ctx) {
    const s = await ctx.sale(ctx.vars[sVar]);
    if (!s) return {};
    if (!s.disclosed) return { caption: s.terminal ? `${settledAs(s)} Nothing was disclosed.` : "", ...onSale(s.id) };
    return { caption: o.caption, note: o.note ? o.note(ctx) : "", ...onSale(s.id) };
  },
  say: o.say,
});
/** Nothing to release: the arbiter checks by itself; ready once its ruling is logged and waits at a gate. */
const arbiterCheck = (scene, id, label, sVar, o) => live(scene, id, label, "rule", "purple", {
  agent: "arbiter", waits: "the arbiter's ruling to wait for release", working: o.working,
  async ready(ctx) {
    const s = ctx.vars[sVar];
    if (ctx.log("arbiter", s, /^ruling$/) && ctx.gate("arbiter", /^rule$/, s)) return true;
    return !!(await ctx.sale(s))?.terminal;
  },
  async view(ctx) {
    const s = ctx.vars[sVar], r = ctx.log("arbiter", s, /^ruling$/);
    const sale = r ? null : await ctx.sale(s);
    return { ...(r ? o.view(ctx, r) : { caption: settledAs(sale) }), ...onSale(s, "ARBITER") };
  },
  say: o.say,
});
/** What the arbiter found, from its "ruling" line, which it writes before its transaction. */
function finding(ctx, r, s) {
  if (!r) return "";
  if (/delivery/.test(String(r.verdict ?? ""))) return "The arbiter checks delivery first: the disclosed key doesn't reproduce the posted reveal.";
  const checked = ctx.log("arbiter", s, /^delivery verified/);
  return says(checked ? fill`The arbiter checks delivery, then re-runs the pair ${word(r.runs)} times.` : fill`The arbiter re-runs the pair ${word(r.runs)} times.`, tallyByCounts(r));
}
const verdictNote = (r) => (r && r.sellerWasRight !== undefined ? `It has decided: the seller was ${r.sellerWasRight ? "right" : "wrong"}.` : "");
/** Releases the arbiter's ruling; ready once the sale is settled. */
const arbiterRule = (scene, id, sVar, o) => live(scene, id, "Arbiter rules", "rule", "purple", {
  agent: "arbiter", waits: "the arbiter's ruling to land on-chain", working: "The ruling is going on-chain.",
  async enter(ctx) { if (!(await ctx.sale(ctx.vars[sVar]))?.terminal) ctx.release("arbiter", /^rule$/, ctx.vars[sVar]); },
  ready: async (ctx) => !!(await ctx.sale(ctx.vars[sVar]))?.terminal,
  async view(ctx) {
    const s = await ctx.sale(ctx.vars[sVar]);
    return s && s.terminal ? { caption: o.caption(ctx, s), ...onSale(s.id) } : { ...onSale(s?.id) };
  },
  say: o.say,
});
/** A wallet's settlement card, as rep() reads it now. */
const record = (scene, id, label, role, color, o) => live(scene, id, label, "settle", color, {
  async view(ctx) {
    const r = await ctx.rep(ctx.addr(role));
    return { caption: o.caption(r), note: o.note ? o.note(r) : "", focus: `addr:${ctx.addr(role).toLowerCase()}`, label: o.tag };
  },
  say: o.say,
});
const refutedCard = (who, extra) => ({
  caption: (r) => says(fill`The ${who}'s card reads ${r.headline}.`, r.sellerRefuted > 0 && extra),
});

// ---------- scene 1: an honest sale ----------
const SCENE1 = [
  card(1, "An honest sale", "The buyer posts a claim. A seller finds a counterexample. The buyer checks it and pays.", [
    "First, a sale where everyone behaves.",
    "On the page: claims on the left, sales in the middle, each address's settlement history on the right.",
  ]),
  live(1, "s1-post", "Post the claim", "claim", "blue", {
    who: "buyer", waits: "the new claim to be readable on-chain", working: "The buyer is posting the claim and escrowing the bounty pool.",
    async enter(ctx) {
      ctx.vars.claimA = await ctx.post();
      ctx.startAgent("buyer", ["buyer", "--", "watch", "--claim", String(ctx.vars.claimA), "--seconds", "14400"]);
    },
    ready: async (ctx) => !!(await ctx.claim(ctx.vars.claimA)),
    async view(ctx) {
      const c = await ctx.claim(ctx.vars.claimA);
      if (!c) return {};
      const n = Number(c.maxHits);
      return { caption: fill`The buyer posts the claim and escrows ${n === 1 ? "one bounty" : `${word(n)} bounties`} of ${ctx.eth(c.bounty)} ETH each.`,
        note: "The money is locked before any seller exists.", focus: `claim:${ctx.vars.claimA}`, label: "THE CLAIM" };
    },
    say: [
      "Point at the claim card: the bounty per counterexample, and how many the buyer will buy.",
      "The whole pool is escrowed now, before any seller exists. Money first, goods later: that is the black box.",
      "The claim also carries the buyer's encryption key. Every reveal gets sealed to it.",
    ],
  }),
  hunt(1, "s1-hunt", "Seller hunts", "seller", "green", {
    claim: "claimA", working: "The seller is asking the model random pairs, looking for a wrong answer.",
    caption(ctx) {
      const f = ctx.log("seller", null, /^counterexample found$/);
      return says(fill`The seller found a pair the model gets wrong, ${f && tries(f.tries)}.`, f && "Only the seller knows it.");
    },
    note: "It hasn't committed yet. It waits for me.",
    say: [
      "The seller is calling the model right now with random three-digit pairs.",
      "A pair only counts if the model is wrong in at least two of three runs, the same test the buyer will apply.",
      "When it has one, it stops and waits for me before it commits.",
    ],
  }),
  commit(1, "s1-commit", "Seller commits", "seller", "green", "s1", {
    caption: (ctx, s) => fill`The seller commits a hash of the pair and posts a bond of ${ctx.eth(s.sellerBond)} ETH.`,
    note: "The hash pins the seller to this exact pair. The bond makes spam expensive.", tag: (id) => `SALE #${id}`,
    say: [
      "Point at the new sale card: a commit hash and a bond. Nothing readable yet.",
      "The hash pins the seller to one exact pair, and each commit reserves one bounty slot, so the escrow can never be over-promised.",
    ],
  }),
  reveal(1, "s1-reveal", "Seller reveals", "seller", "green", "s1", {
    caption: () => "The seller reveals the pair, encrypted to the buyer's key. Everyone can see something was delivered; only the buyer can read it.",
    say: [
      "Point at the reveal on the sale card: ciphertext sealed to the buyer's key.",
      "Everyone can see that something was delivered, and when. Only the buyer can read it.",
    ],
  }),
  buyerCheck(1, "s1-check", "s1", {
    rerun: (rr) => fill`The buyer decrypts it, checks the hash, and re-runs the model ${word(rr.runs)} times.`,
    say: [
      "The buyer decrypts, checks the pair against the commit hash, and re-runs the model three times.",
      "Two wrong answers out of three and it confirms. It has already decided; nothing lands until I release it.",
    ],
  }),
  buyerAct(1, "s1-confirm", "Buyer confirms", "adjudicate", "s1", {
    confirmed: "The buyer confirms. The seller is paid the bounty, and its bond comes back.",
    disputed: (s) => `The buyer disputes, with the reason "${s.reason}", and posts a bond of its own.`,
    say: [
      "Point at the badge on the sale card as it turns Confirmed.",
      "One transaction pays the seller the bounty and returns its bond.",
    ],
  }),
  record(1, "s1-record", "Seller's record", "seller", "green", {
    caption: (r) => fill`The seller's card reads ${r.headline}.`,
    // The contract moves sellerConfirmed on a confirm and on an arbiter's upholding ruling (RefutationMarket.sol rule),
    // never on a settle, so the note says both and claims nothing more.
    note: () => "Confirmed means someone checked: a buyer confirming, or an arbiter upholding a dispute. Silence never moves this number.", tag: "SELLER'S CARD",
    say: [
      "Point at the seller's card under Settlement history.",
      "That count moved because a buyer checked and said so. Silence can't move it.",
    ],
  }),
];

// ---------- scene 2: a planted pair ----------
const SCENE2 = [
  card(2, "A planted pair", "A rogue sells a pair the model actually gets right.", [
    "Now a seller that cheats: it sells a pair the model actually gets right.",
    "The question is whether a dispute catches it without anyone trusting the buyer's word.",
  ]),
  hunt(2, "s2-hunt", "Rogue hunts", "rogue", "red", {
    claim: "claimA", attack: "plant", working: "The rogue is looking for a pair the model gets right.",
    caption: (ctx) => (ctx.log("rogue", null, /^attack plant/) ? "The rogue picks a pair the model answers correctly, and will sell it anyway." : ""),
    say: [
      "The rogue probes the model like any seller, but keeps a pair the model answers correctly.",
      "It is about to sell that as a counterexample.",
    ],
  }),
  commit(2, "s2-commit", "Rogue commits", "rogue", "red", "s2", {
    caption: () => "The rogue commits and posts a bond, like any seller.",
    note: "On-chain, nothing tells it apart from an honest seller yet.", tag: () => "ROGUE",
    say: [
      "Point at its sale card: a hash and a bond, exactly like the honest seller's.",
      "Nothing on-chain can tell the two apart yet. That is why the buyer's check matters.",
    ],
  }),
  reveal(2, "s2-reveal", "Rogue reveals", "rogue", "red", "s2", {
    caption: () => "It reveals the pair to the buyer.",
    say: ["The pair is sealed to the buyer's key, like before.", "Only the buyer can read it."],
  }),
  buyerCheck(2, "s2-check", "s2", {
    rerun: () => "The buyer re-runs it.",
    say: [
      "The buyer re-runs the pair three times, and the model gets it right.",
      "So it won't confirm. It has chosen to dispute, and waits for me.",
    ],
  }),
  buyerAct(2, "s2-dispute", "Buyer disputes", "dispute", "s2", {
    discloser: "rogue",
    confirmed: "The buyer confirms. The rogue is paid the bounty, and its bond comes back.",
    disputed: (s) => `The buyer disputes with a reason, "${s.reason}", and posts a bond of its own.`,
    disputeNote: "Disputing costs the buyer a bond, so it can't dispute for free.",
    say: [
      "The dispute carries a reason, shown beside the sale, and a bond from the buyer, so disputing isn't free.",
      "Now the rogue has to disclose in public, or lose its bond.",
    ],
  }),
  disclose(2, "s2-disclose", "Rogue discloses", "rogue", "red", "s2", {
    caption: "The rogue must now disclose the pair, its salt and its encryption key, on-chain and in public. A seller that doesn't is slashed.",
    say: [
      "Point at the disclosed line on the sale card: the pair is public now.",
      "The salt and the encryption secret are public too, so anyone can check what was delivered.",
    ],
  }),
  arbiterCheck(2, "s2-arbiter", "Arbiter checks", "s2", {
    working: "The arbiter is checking delivery and re-running the pair.",
    view: (ctx, r) => ({ caption: finding(ctx, r, ctx.vars.s2), note: verdictNote(r) }),
    say: [
      "The arbiter checks delivery first: the disclosed secret has to reproduce the posted ciphertext.",
      "Then it re-runs the pair five times. It would need three wrong answers to side with the seller.",
    ],
  }),
  arbiterRule(2, "s2-rule", "s2", {
    caption: (ctx, s) => s.state === ST.Refuted ? "The arbiter refutes the rogue. The rogue's bond goes to the buyer, and the buyer's bond comes back."
      : s.state === ST.Upheld ? "The arbiter upholds the seller: it gets the bounty and both bonds." : settledAs(s),
    say: ["Point at the badge: Refuted.", "The buyer gets the rogue's bond, and its own bond back. Checking paid off."],
  }),
  record(2, "s2-record", "Rogue's record", "rogue", "red", {
    ...refutedCard("rogue", "A refutation stays on the record."), tag: "ROGUE'S CARD",
    say: ["Point at the rogue's card: refuted history, in red.", "It stays. Even a later confirmation would be shown with the refutation beside it."],
  }),
];

// ---------- scene 3: a real pair, never delivered ----------
const SCENE3 = [
  card(3, "A real pair, never delivered", "A seller commits to a real counterexample, then reveals garbage.", [
    "This is the attack an external reviewer found in my first version.",
    "A seller commits to a real counterexample, then reveals garbage.",
  ]),
  hunt(3, "s3-hunt", "Newcomer hunts", "newcomer", "orange", {
    claim: "claimA", attack: "garbage", working: "The newcomer is hunting for a real counterexample.",
    caption(ctx) { const f = ctx.log("newcomer", null, /^counterexample found$/); return fill`A newcomer finds a real counterexample, ${f && tries(f.tries)}.`; },
    say: ["The newcomer starts honestly: it hunts for a real counterexample.", "Remember that. The pair it finds genuinely breaks the model."],
  }),
  commit(3, "s3-commit", "Newcomer commits", "newcomer", "orange", "s3", {
    caption: () => "It commits to that pair, honestly.", tag: () => "NEWCOMER",
    say: ["It commits to that real pair, with a hash and a bond.", "Nothing wrong yet."],
  }),
  reveal(3, "s3-reveal", "Newcomer reveals", "newcomer", "orange", "s3", {
    logged: /^attack garbage|^revealed$/,
    caption: (ctx, s) => (ctx.log("newcomer", s.id, /^attack garbage/) ? "But it reveals random bytes instead of the encrypted pair." : "It reveals to the buyer."),
    note: (ctx, s) => (ctx.log("newcomer", s.id, /^attack garbage/) ? "From the outside, the ciphertext looks like any other." : ""),
    say: ["Here is the cheat: the reveal is random bytes of the right length, not the sealed pair.", "Point at it. From outside, it looks like any other ciphertext."],
  }),
  buyerCheck(3, "s3-check", "s3", {
    working: "The buyer is trying to decrypt the reveal.",
    rerun: (rr) => fill`The buyer decrypts it and re-runs the model ${word(rr.runs)} times.`,
    say: ["The buyer's key doesn't open it.", "It never gets a pair, so there is nothing to re-run. It will dispute."],
  }),
  buyerAct(3, "s3-dispute", "Buyer disputes", "dispute", "s3", {
    discloser: "newcomer",
    confirmed: "The buyer confirms. The newcomer is paid the bounty, and its bond comes back.",
    disputed: (s) => `The buyer disputes, "${s.reason}", and posts a bond.`,
    say: ["The dispute reason goes on-chain beside the sale, and the buyer bonds it like any dispute.", "Now the newcomer has to disclose."],
  }),
  disclose(3, "s3-disclose", "Newcomer discloses", "newcomer", "orange", "s3", {
    caption: "The newcomer discloses the real pair, the salt, and the key it says it used.",
    note: (ctx) => (ctx.log("newcomer", null, /^counterexample found$/) ? "That pair really is a counterexample." : ""),
    say: ["It discloses the real pair, the salt, and the key it says it used.", "That pair really does break the model. If the arbiter only re-ran it, the seller would win."],
  }),
  arbiterCheck(3, "s3-trap", "The trap", "s3", {
    working: "The arbiter is checking what was delivered.",
    view(ctx, r) {
      const trap = ctx.log("newcomer", ctx.vars.s3, /^attack garbage/) && ctx.log("newcomer", null, /^counterexample found$/);
      return trap ? { caption: "A re-run alone would uphold this seller, and the buyer would lose its bond for goods it never received.", note: "So the arbiter checks delivery first." }
        : { caption: finding(ctx, r, ctx.vars.s3), note: verdictNote(r) };
    },
    say: [
      "An external reviewer found exactly this hole in my first version: the arbiter only ever looked at the disclosure.",
      "Garbage reveal, honest disclosure, and the seller won. The buyer lost its bond for goods it never received.",
      "The fix was to check delivery before running the model: rebuild the sealed box from what was disclosed and compare it with what was posted.",
    ],
  }),
  arbiterRule(3, "s3-rule", "s3", {
    caption(ctx, s) {
      const r = ctx.log("arbiter", s.id, /^ruling$/);
      const delivery = /delivery/.test(String(r?.verdict ?? "")) || !!ctx.log("arbiter", s.id, /^ruled: delivery/);
      const ran = !!ctx.log("arbiter", s.id, /^re-running/);
      if (delivery && !ran) return `The disclosed key doesn't reproduce the posted reveal. ${s.stateName}, without running the model.`;
      return `The arbiter rules: ${s.stateName.toLowerCase()}.`;
    },
    say: [
      "The disclosed key doesn't reproduce the posted bytes, so the seller is refuted without a single model call.",
      "That check runs in the arbiter, off-chain. The contract stores the secret but can't verify a box, and the README says so.",
    ],
  }),
  record(3, "s3-record", "Newcomer's record", "newcomer", "orange", {
    ...refutedCard("newcomer", "A real counterexample that was never delivered earns nothing."), tag: "NEWCOMER'S CARD",
    say: ["Point at the newcomer's card: refuted history.", "A real counterexample that was never delivered earns nothing, and costs the seller its bond."],
  }),
];

// ---------- scene 4: the silent buyer ----------
const SCENE4 = [
  card(4, "The silent buyer", "A sale nobody checks.", ["The last scene is the design decision, live.", "A sale where the buyer never checks at all."]),
  live(4, "s4-post", "Second claim", "claim", "blue", {
    who: "buyer", waits: "the second claim to be readable on-chain", working: "The buyer is posting a second claim.",
    async enter(ctx) { ctx.vars.claimB = await ctx.post(); },
    ready: async (ctx) => !!(await ctx.claim(ctx.vars.claimB)),
    async view(ctx) {
      const c = await ctx.claim(ctx.vars.claimB);
      return c ? { caption: "The buyer posts a second claim, and this time never looks at it.", focus: `claim:${ctx.vars.claimB}`, label: `CLAIM #${ctx.vars.claimB}` } : {};
    },
    say: ["Point at the second claim card. Same buyer.", "Its watcher only follows the first claim, so nobody will ever check this one."],
  }),
  hunt(4, "s4-hunt", "Quiet wallet hunts", "quiet", "grey", {
    claim: "claimB", working: "The quiet wallet is hunting.",
    async before(ctx) { ctx.vars.quietBefore = (await ctx.rep(ctx.addr("quiet"))).headline; },
    caption(ctx) {
      const f = ctx.log("quiet", null, /^counterexample found$/);
      return f ? fill`A wallet with ${ctx.vars.quietBefore} finds a counterexample.` : "";
    },
    say: ["A separate wallet with no history hunts on the second claim.", "It is a different wallet so this scene can't touch the honest seller's record."],
  }),
  commit(4, "s4-commit", "It commits", "quiet", "grey", "s4", {
    caption: () => "It commits and posts a bond.", tag: () => "QUIET WALLET",
    say: ["Commit and bond, like every seller before it.", "Point at its sale card: on-chain it looks like every other sale so far."],
  }),
  reveal(4, "s4-reveal", "It reveals", "quiet", "grey", "s4", {
    caption: () => "It reveals to the buyer. The buyer never decrypts it.",
    say: ["Sealed to the buyer's key.", "The buyer never opens it."],
  }),
  live(4, "s4-window", "The window passes", "adjudicate", "grey", {
    agent: "sweep", waits: "the sweep to see the closed window and wait at its settle",
    working: "The local clock jumps past the window. The sweep is looking for a sale it can settle.",
    async enter(ctx) { ctx.vars.window = await ctx.adjudicationWindow(); await ctx.jump(ctx.vars.window + 10); },
    ready: async (ctx) => !!ctx.gate("sweep", /^settle$/, ctx.vars.s4) || !!(await ctx.sale(ctx.vars.s4))?.terminal,
    async view(ctx) {
      const s = await ctx.sale(ctx.vars.s4);
      const open = s && s.state === ST.Revealed && ctx.gate("sweep", /^settle$/, s.id);
      return { caption: open ? fill`The ${span(ctx.vars.window)} window for the buyer to respond passes with no confirm and no dispute.` : settledAs(s),
        note: open ? "Local chain: the clock is jumped ahead here. On the testnet the wait is real." : "", ...onSale(s?.id) };
    },
    say: ["On this local chain I jump the clock past the window instead of waiting.", "No confirm, no dispute. Most markets would read that as a satisfied buyer."],
  }),
  live(4, "s4-settle", "Anyone settles", "settle", "amber", {
    agent: "sweep", waits: "the settle to land on-chain", working: "The settle is going on-chain.",
    async enter(ctx) { if (!(await ctx.sale(ctx.vars.s4))?.terminal) ctx.release("sweep", /^settle$/, ctx.vars.s4); },
    ready: async (ctx) => !!(await ctx.sale(ctx.vars.s4))?.terminal,
    async view(ctx) {
      const s = await ctx.sale(ctx.vars.s4);
      if (!s || !s.terminal) return { ...onSale(s?.id) };
      const silent = s.state === ST.Unadjudicated;
      return { caption: silent ? `Anyone can settle. The seller is paid, because the buyer had its chance. But the sale is recorded as ${s.stateName.toLowerCase()}.` : settledAs(s),
        note: silent ? "The sweep runs on the deployer wallet. It holds no special role: anyone could call settle." : "", ...onSale(s.id) };
    },
    say: ["Anyone can call settle once the window closes. The sweep that does it holds no special role.", "The seller is paid, because the buyer had its chance. Point at the badge: Unadjudicated, not Confirmed."],
  }),
  record(4, "s4-record", "Its record", "quiet", "grey", {
    caption: (r) => says(`The quiet wallet's card reads ${r.headline}: ${word(r.sellerUnadjudicated)} unadjudicated, ${word(r.sellerConfirmed)} confirmed.`,
      r.sellerUnadjudicated > 0 && r.sellerConfirmed === 0 && "Money followed the default. Reputation did not."),
    note: (r) => (r.sellerUnadjudicated > 0 && r.sellerConfirmed === 0 ? "Silence is not evidence." : ""), tag: "QUIET WALLET'S CARD",
    say: [
      "Point at the quiet wallet's card: unverified. One unadjudicated, zero confirmed.",
      "Compare the honest seller's card: that confirmed count came from a buyer who checked.",
      "Money followed the default. Reputation did not.",
    ],
  }),
];

export const DECK = [...INTRO, ...SCENE1, ...SCENE2, ...SCENE3, ...SCENE4, ...CLOSING];
