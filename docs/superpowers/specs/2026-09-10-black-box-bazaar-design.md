# Black Box Bazaar: a market of refutations

Design spec. 2026-09-10. Status: approved in brainstorm, not yet built.

## 1. Vertical and participants

Model-evaluation red-teaming. The buyer is an agent acting for whoever owns or
maintains a model or an eval suite. It wants to know where a stated property of
a pinned model fails. The seller is a red-team agent that searches for such
failures and sells them. The arbiter is an agent that re-runs a disputed test
and rules. All three query the same pinned model at the same fixed settings.

The good being sold is a **counterexample**: an input on which the model
violates a claim the buyer wrote down. Its entire value is that the buyer does
not have it yet, and once revealed it can be tested in one deterministic step.
That is why this vertical fits a market where the buyer cannot inspect before
paying: the good is self-verifying after reveal, so no judge has to interpret
it.

## 2. The problem and the thesis

Arrow's information paradox: a buyer cannot value information without seeing
it, and once seen there is nothing left to pay for. The mechanical half of the
answer is well known: commit a hash, escrow payment, reveal, verify. The half
most designs cheat on is reputation. In a black-box market the buyer often
never checks after paying, so "no dispute" measures apathy, not quality.

The thesis of this market, inherited from three earlier projects that each
found it the hard way: **silence is not evidence.** A sale counts toward a
seller's record only once it has been adjudicated. Unadjudicated sales are a
disclosed third bucket that never rounds to confirmed. The arbiter is shown
catching a planted bad good before anyone is asked to trust its verdicts.

## 3. Mechanism

Claim-first. The buyer speaks first and defines what counts.

1. **Claim.** Buyer posts: pinned model id and version string, the test
   procedure as text (prompt template, predicate, run count, threshold), a
   bounty per counterexample, a maximum number it will buy, an expiry, and an
   x25519 public key. The whole bounty pool (bounty times max) is escrowed at
   posting. Payment is committed before any seller exists.
2. **Commit.** Seller posts `keccak256(abi.encode(claimId, plaintext, salt))`
   and a seller bond. The contract reserves one bounty slot per open
   commitment so escrow can never be over-committed. An identical commit hash
   on the same claim is rejected.
3. **Reveal.** Seller posts the plaintext encrypted to the buyer's key, stored
   on-chain in the reveal. The adjudication window opens. Delivery is therefore
   timestamped and unforgeable, and the whole market history reconstructs from
   chain data alone.
4. **Adjudicate.** Buyer decrypts, checks the plaintext against the commit,
   re-runs the test N times, and either confirms or disputes with a bond.
5. **Dispute.** Seller must disclose plaintext and salt on-chain; the contract
   checks them against the commit. A seller that cannot is withdrawn: bond to
   buyer, buyer's bond returned. If they match, the arbiter re-runs and rules.
   A buyer that disputes and loses forfeits its bond to the seller, and the
   counterexample is now public, so buyers dispute only when they mean it.
6. **Silence.** If the window closes with no buyer action, anyone may settle.
   The seller is paid, because the buyer had its chance. The sale is recorded
   as unadjudicated, the buyer's silent count rises, and the seller's confirmed
   count does not move. Money follows the default; reputation does not.

## 4. Contract

One contract, `RefutationMarket`, Solidity 0.8.x, Foundry. Base Sepolia
(chain id 84532, RPC `https://sepolia.base.org`, explorer
`https://sepolia.basescan.org`). No language model touches it.

Storage:

```
struct Claim {
  address buyer; string modelId; string spec; bytes32 buyerPubKey;
  uint256 bounty; uint32 maxHits; uint32 hits; uint32 pending;
  uint64 expiresAt; bool closed;
}
struct Sale {
  uint256 claimId; address seller; bytes32 commitHash; uint256 sellerBond;
  bytes ciphertext; uint64 committedAt; uint64 revealedAt; uint64 disputedAt;
  uint256 buyerBond; bytes plaintext; SaleState state;
}
enum SaleState { Committed, Revealed, Confirmed, Disputed, Refuted, Upheld,
                 Unadjudicated, Withdrawn }
struct Rep {
  uint32 sellerConfirmed; uint32 sellerRefuted; uint32 sellerUnadjudicated;
  uint32 sellerWithdrawn; uint32 buyerAdjudicated; uint32 buyerSilent;
  uint32 buyerDisputesLost;
}
```

Immutable parameters set at deploy: `arbiter`, `revealWindow`,
`adjudicationWindow`, `disclosureWindow`, `bondBps` (seller and buyer bonds
are `bounty * bondBps / 10000`).

Functions and transitions:

| function | who | from → to | money |
|---|---|---|---|
| `postClaim` | anyone | creates Claim | escrow `bounty*maxHits` |
| `commit` | anyone | → Committed | seller bond in; `pending++`; requires `hits+pending < maxHits` |
| `reveal` | seller | Committed → Revealed | none |
| `confirm` | buyer | Revealed → Confirmed | bounty + bond to seller; `hits++`, `pending--` |
| `dispute` | buyer, in window | Revealed → Disputed | buyer bond in |
| `disclose` | seller | Disputed, sets plaintext | none; requires hash match |
| `rule(saleId, sellerWasRight)` | arbiter | Disputed+disclosed → Upheld or Refuted | Upheld: bounty + both bonds to seller, `hits++`. Refuted: seller bond to buyer, buyer bond back, bounty stays. `pending--` either way |
| `withdrawSale` | anyone, after disclosure window | Disputed, undisclosed → Withdrawn | seller bond to buyer, buyer bond back; `pending--` |
| `expireCommit` | anyone, after reveal window | Committed → Withdrawn | seller bond to buyer; `pending--` |
| `settle` | anyone, after adjudication window | Revealed → Unadjudicated | bounty + bond to seller; `hits++`, `pending--` |
| `closeClaim` | buyer, after expiry, `pending == 0` | closes | refund `bounty*(maxHits-hits)` |

Reputation counters move exactly once per terminal transition: Confirmed and
Upheld raise `sellerConfirmed`; Refuted raises `sellerRefuted`; Unadjudicated
raises `sellerUnadjudicated` and `buyerSilent`; Withdrawn raises
`sellerWithdrawn`; confirm and dispute raise `buyerAdjudicated`; Upheld raises
`buyerDisputesLost`.

Events, one per transition: `ClaimPosted, Committed, Revealed, Confirmed,
Disputed, Disclosed, Ruled, Settled, Withdrawn, ClaimClosed`. The page is built
from events only.

Stretch, built only after the three demo scenes work on testnet: on-chain
duplicate proof. A four-digit pair has about 10^8 possibilities, so an unsalted
commitment is brute-forceable and cannot be used for dedup. Instead the buyer
disputes a resold pair by opening a prior commitment it already paid for:
`disputeDuplicate(saleId, priorSaleId, priorPlaintext, priorSalt)`. The
contract checks the prior hash; when the seller discloses and the plaintexts
match, the sale is refuted with no arbiter. If not built, this is a documented
limitation.

## 5. Agents

TypeScript, Node 26, `viem` for chain access, `@anthropic-ai/sdk` for the
model, `tweetnacl` for encryption. Four wallets: deployer (funded by a human
from a faucet), buyer, seller, arbiter. A rogue seller reuses the seller code
with a flag that plants a pair the model gets right.

Model: `claude-haiku-4-5-20251001`, temperature 0, max tokens 32.
Prompt: `What is {a} × {b}? Reply with only the integer.` Predicate: parsed
integer equals `a*b` computed with BigInt. Plaintext canonical form:
`{"a":1234,"b":5678}` with no whitespace, so equal pairs hash equal.

- **Seller** samples random four-digit pairs, queries the model, and on the
  first pair the model gets wrong (2 of 3 runs) it commits, waits for
  inclusion, then reveals. Loop until the claim's slots are consumed.
- **Buyer** watches `Revealed` events on its claims, decrypts, checks the
  commit, runs 3 times, confirms if the model is wrong in at least 2, otherwise
  disputes. A `--silent` flag makes it do nothing, for the third demo scene.
- **Arbiter** watches `Disclosed` events, runs 5 times, rules the seller right
  if the model is wrong in at least 3.

Plan step zero is empirical: measure Haiku 4.5's failure rate on four-digit
multiplication before anything else. If it is too low for the seller to find
hits on camera within a minute, the claim moves to five digits.

## 6. Delivery and encryption

The buyer's claim carries an x25519 public key. The seller generates an
ephemeral keypair and posts `ephemeralPub(32) || nonce(24) || box` as the
reveal ciphertext. Only the buyer can read the reveal. In a dispute the
plaintext becomes public by construction; that is a feature.

## 7. Page

One static `index.html` under `docs/`, served by GitHub Pages from the `main`
branch. `viem` from a CDN, reads all events from the public RPC, no backend.
Three views: the claim board; every sale with its state, links to the
transactions on Basescan, and the encrypted reveal shown as ciphertext; and
reputation cards. A seller card shows confirmed, refuted, and unadjudicated as
three separate numbers, and its headline reads **unknown** whenever confirmed
is zero, however many unadjudicated sales it has. A buyer card shows
adjudicated, silent, and disputes lost.

## 8. Failure modes

| failure | mitigation | where it came from |
|---|---|---|
| model nondeterminism at temperature 0 | majority of N runs; the claim states N and threshold; disclosed as a limitation | Elenchus: report bounds, never zero |
| model version drift | version string pinned in the claim; a new version needs a new claim | ReserveGrid: re-derive against what was declared |
| seller reveals garbage | disclose must match the commit or the seller is withdrawn and slashed | ReserveGrid: declared vs re-derived |
| buyer reads then disputes frivolously | dispute bond, and a losing dispute makes the finding public | |
| buyer goes silent | settle pays the seller, sale is unadjudicated, buyer's silent count rises | ReserveGrid: unadjudicated is disjoint from absent |
| commit-and-never-reveal spam | reveal window; expired commits forfeit the bond | |
| reputation built on unchecked sales | headline is unknown until confirmed > 0 | Elenchus: rule of three |
| resale of the same pair | stretch: on-chain duplicate proof by opening a prior commitment; else limitation | |
| arbiter never shown working | demo scene two plants a false counterexample and the arbiter refutes it | Felix: a gate that cannot fail is not a gate |

What we cannot catch and say so: a colluding buyer and arbiter; a dishonest
single arbiter; an attacker with a different model behind the same API.

## 9. Testing

Foundry tests for every transition in the table above, and for every refusal
(wrong caller, wrong state, wrong window, over-committed escrow, duplicate
commit). Each test is written and shown failing before the code that passes
it. Agents are dry-run against a local `anvil` chain with the same scripts
before Base Sepolia is touched. The end-to-end run on Base Sepolia is recorded
as the demo.

## 10. Demo

Three scenes, in this order, with demo windows of 90 seconds so each resolves
on camera. Production windows would be hours.

1. Honest sale: claim, commit, reveal, buyer confirms, seller paid.
2. Rogue seller: plants a pair the model gets right, buyer disputes, seller
   discloses, arbiter re-runs and refutes, seller slashed. The arbiter is seen
   catching something before the viewer is asked to trust it.
3. Silent buyer: a second claim whose buyer never adjudicates. After the window
   anyone settles. The seller is paid and the page shows the sale as
   unadjudicated and the seller's headline as unknown.

Recording: a Playwright script drives the page while the agents run in visible
terminal panes; caption bar per scene; `ffmpeg` cut under five minutes; a
synthetic-narration variant is rendered as an extra.

## 11. Deliverables

- Public repository with README covering: vertical (model-evaluation
  red-teaming), trust assumptions (the pinned model API is the shared ground
  truth; the arbiter is honest; all parties reach the same model), biggest
  design decision (unadjudicated is a third state that never rounds to
  confirmed, so silence pays the seller but earns no reputation), one important
  limitation (a single arbiter).
- Video under five minutes.
- Deployed page URL on GitHub Pages.
- Contract address and Basescan link.

## 12. Out of scope

Multiple arbiters or arbiter staking. Fees to the arbiter. Fuzzy duplicate
detection for prompt-shaped goods. Any claim family beyond arithmetic. Any
backend.

## 13. Parameters

| parameter | demo | production suggestion |
|---|---|---|
| revealWindow | 90 s | 1 h |
| adjudicationWindow | 90 s | 24 h |
| disclosureWindow | 90 s | 24 h |
| bondBps | 2000 (20% of bounty) | 2000 |
| bounty | 0.0005 ETH | market-set |
| maxHits per claim | 3 | market-set |
| buyer runs / threshold | 3 / 2 | 5 / 3 |
| arbiter runs / threshold | 5 / 3 | 9 / 5 |
