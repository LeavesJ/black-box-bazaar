// demo/present-slides.mjs — the slides that open and close the step presenter's deck (demo/deck.mjs assembles the
// whole deck; demo/console.mjs serves it at /api/deck). A slide is data only: docs/present.js lays it out by its
// "layout". "say" is what the presenter says while it is on screen, first person, never more than README.md claims.
const slide = (id, label, s, say) => ({ id, kind: "slide", scene: 0, label, slide: s, say });

export const INTRO = [
  slide("title", "Title", {
    layout: "title", kicker: "Blockchain at Berkeley · technical take-home", title: "Black Box Bazaar", subtitle: "A market of refutations",
    body: "Autonomous agents buy and sell counterexamples to a claim about an AI model. The buyer can't see a counterexample until its money is locked in escrow.",
    foot: "Jarron Deng",
  }, [
    "I built a market where AI agents buy and sell counterexamples to a claim about a model.",
    "The catch: the buyer pays into escrow before it can see what it is buying.",
    "Five slides on the mechanism, then I run it live on a local chain.",
  ]),
  slide("problem", "The problem", {
    layout: "bullets", kicker: "The problem", title: "Information is the one good you can't inspect before you buy it",
    bullets: [
      "Show it to the buyer, and they no longer need to pay for it.",
      "Hide it, and they can't tell whether it's worth anything.",
      "The standard answer: commit a hash, escrow the payment, reveal, verify.",
      "The part most designs skip: after the reveal, \"no dispute\" gets read as \"satisfied\".",
    ],
    foot: "So a seller's reputation gets built out of buyers who never looked.",
  }, [
    "Commit, escrow, reveal, verify is the standard answer, and I use it.",
    "What I care about is the step after the reveal: a buyer who never checks still reads as a satisfied customer.",
    "That is how a reputation gets built out of buyers who never looked.",
  ]),
  slide("vertical", "The vertical", {
    layout: "bullets", kicker: "The vertical", title: "Model-evaluation red-teaming",
    bullets: [
      "Someone maintains a model or an eval suite and believes a claim about it.",
      "Red-teamers sell counterexamples: inputs on which the model breaks the claim.",
      "The good checks itself: once revealed, one re-run shows whether it's real.",
      "Demo claim: claude-haiku-4-5 at temperature 0 multiplies any two three-digit numbers correctly.",
    ],
    foot: "Measured before building: wrong on about 1 in 10 three-digit pairs. Four-digit pairs fail 3 in 4, which would make the claim silly.",
  }, [
    "I picked red-teaming because the good checks itself: one re-run tells the buyer whether it is real.",
    "That is what makes a counterexample fair to sell blind.",
    "The claim is deliberately modest. Three-digit pairs fail about one time in ten, so it is a claim a buyer would actually post.",
  ]),
  slide("mechanism", "The mechanism", {
    layout: "flow", kicker: "The mechanism", title: "A sale, step by step",
    flow: {
      main: [
        { role: "buyer", t: "Claim", s: "posts the claim and escrows the whole bounty pool" },
        { role: "seller", t: "Commit", s: "a hash of the pair, plus a bond" },
        { role: "seller", t: "Reveal", s: "the pair, encrypted to the buyer's key" },
        { role: "buyer", t: "Check", s: "decrypt, match the hash, re-run the model 3 times" },
      ],
      outcomes: [
        { role: "buyer", t: "Confirm", s: "seller paid, bond back; counts as confirmed" },
        { role: "arbiter", t: "Dispute", s: "buyer bonds a reason; seller must disclose; arbiter checks delivery, re-runs 5 times" },
        { role: "quiet", t: "Silence", s: "window passes; anyone settles; seller paid; recorded as unadjudicated" },
      ],
    },
    foot: "No language model touches the contract. Buyer, seller and arbiter each query the same pinned model off-chain.",
  }, [
    "The top row, left to right: claim, commit, reveal, check.",
    "Then the three ways a sale ends. Silence still pays the seller.",
    "The contract never runs a model. It records what three agents, querying the same pinned model, did.",
  ]),
  slide("decision", "The design decision", {
    layout: "table", kicker: "The design decision", title: "Unadjudicated never rounds to confirmed",
    table: {
      head: ["What an address's record holds", "Its headline"],
      rows: [
        ["any confirmations", "N confirmed"],
        ["none confirmed, any refuted", "refuted history"],
        ["none of those, any withdrawn", "withdrawn history"],
        ["none of those, any unarbitrated", "unarbitrated history"],
        ["only unadjudicated sales", "unverified"],
        ["nothing settled", "no history"],
      ],
    },
    foot: "A silent buyer still pays the seller. It just earns the seller nothing.",
  }, [
    "This is the page's rule: the first row that matches wins.",
    "Look at unverified: a seller paid only through silence never reads as confirmed.",
    "Most marketplaces read no dispute as satisfied. In a black-box market that measures apathy, not quality.",
  ]),
  slide("live", "Four scenes, live", {
    layout: "bullets", kicker: "Live demo", title: "Four scenes, live",
    bullets: [
      "A fresh local chain running the same contract and agents as the Base Sepolia deployment.",
      "Each ▶ moves the demo one step; every on-chain action waits for my ▶. The agents decide what to do; I decide when.",
      "Every number on screen is read from the chain, or from the agents' own logs, as it happens.",
    ],
    legend: [
      { role: "buyer", label: "Buyer" }, { role: "seller", label: "Seller" }, { role: "rogue", label: "Rogue seller" },
      { role: "newcomer", label: "Newcomer" }, { role: "quiet", label: "Quiet wallet" }, { role: "arbiter", label: "Arbiter" },
    ],
    foot: "Right column: my notes, and each agent's own log as it works.",
  }, [
    "From here it is live: a fresh local chain, the same contract and agents as the testnet.",
    "Each press moves the demo one step, and nothing lands on-chain until I press. The agents choose what to do; I choose when.",
    "The colours are the wallets. The right column is each agent's own log.",
  ]),
];

export const CLOSING = [
  slide("guarantees", "Two more guarantees", {
    layout: "bullets", kicker: "Also built", title: "Two more guarantees",
    bullets: [
      "If the arbiter never rules, anyone can resolve after its window: each side takes back its own bond, the bounty slot returns to the claim, and the sale is recorded as unarbitrated.",
      "The buyer keeps the disclosed pair without paying: a deliberate tradeoff, recorded as its own state rather than disguised as silence.",
      "A payment can never block a settlement: a payout the recipient refuses is credited to owed(address) and collected with withdraw().",
    ],
  }, [
    "Two paths I did not run live.",
    "A vanished arbiter no longer locks anyone's funds, and the outcome is its own state, never folded into silence.",
    "Nobody can jam a settlement by refusing their own money.",
  ]),
  slide("answers", "The four answers", {
    layout: "grid", kicker: "The brief", title: "The four answers",
    grid: [
      { h: "Vertical", b: "Model-evaluation red-teaming: sellers find inputs on which a pinned model breaks a stated claim. A counterexample checks itself, since once revealed one re-run shows whether it is real." },
      { h: "Trust assumptions", b: "The pinned model API is the shared ground truth, and the single arbiter is honest. Temperature 0 is not deterministic, so wrong means wrong in a majority of fixed runs: 2 of 3 for the buyer, 3 of 5 for the arbiter." },
      { h: "Biggest design decision", b: "Unadjudicated is a third state that never rounds to confirmed. A silent buyer pays the seller but earns it nothing." },
      { h: "One important limitation", b: "A single arbiter re-runs the test, checks delivery off-chain, and rules. A dishonest one, or one colluding with the buyer, cannot be caught by the contract; the interface is one address so a quorum can replace it." },
    ],
  }, [
    "The four answers the brief asked for.",
    "The one I would defend hardest is the design decision: unadjudicated never rounds to confirmed.",
    "The limitation is real. One arbiter, behind a single address, so a quorum can replace it.",
  ]),
  slide("origin", "Where it came from", {
    layout: "bullets", kicker: "Where it came from", title: "A check that never ran reads like a check that found nothing",
    bullets: [
      "ReserveGrid-OS: a mining verifier that skipped every template and reported zero false positives.",
      "Elenchus: a reasoning tutor that reports zero rejections in 64 pushes as \"at most 4.7 percent\", not zero.",
      "Felix: a build harness whose rule is that a gate which cannot fail is not a gate.",
    ],
    foot: "This market is that lesson applied to reputation.",
  }, [
    "Three earlier projects of mine each hit the same bug.",
    "Each time, a check that never ran looked exactly like a check that found nothing.",
    "Here the unrun check is a silent buyer, so silence is never counted.",
  ]),
  slide("end", "Silence is not evidence", {
    layout: "end", title: "Silence is not evidence.",
    lines: [
      { k: "Contract", v: "0xf347ff05478ad271adab818696134bc3cd0a07ed on Base Sepolia" },
      { k: "Live page", v: "leavesj.github.io/black-box-bazaar" },
      { k: "Video", v: "youtu.be/R-WpQ-6_KME" },
      { k: "Code", v: "github.com/LeavesJ/black-box-bazaar" },
    ],
    foot: "Four real sales on the testnet: confirmed, refuted, refuted, unadjudicated.",
  }, [
    "The same contract is live on Base Sepolia, and the page reads it straight from the chain.",
    "The video and the code are linked here. Happy to take questions.",
  ]),
];
