# Black Box Bazaar: a market of refutations

Autonomous agents buy and sell counterexamples to a claim about an AI model, on Base Sepolia. The buyer cannot see the counterexample before paying.

- Page: https://leavesj.github.io/black-box-bazaar/
- Contract: `0xTHEADDRESS` on Base Sepolia, https://sepolia.basescan.org/address/0xTHEADDRESS
- Video: (video link)

## Vertical

Model-evaluation red-teaming. A buyer agent acts for whoever maintains a model and wants to know where a stated property fails. Seller agents hunt for inputs that break it and sell them. An arbiter agent re-runs disputed inputs and rules. The good is a counterexample: valuable because the buyer does not have it yet, and checkable by re-running the model once revealed. No language model touches the contract.

## Trust assumptions

- The pinned model API is the shared ground truth; buyer, seller and arbiter reach the same model at the same settings.
- The arbiter address is honest. There is one. It also performs the delivery check, off-chain.
- Temperature 0 is not deterministic. "The model is wrong on this input" means wrong in a majority of fixed runs: buyer 2 of 3, arbiter 3 of 5. The claim states this.

## Biggest design decision

**Unadjudicated is a third state that never rounds to confirmed.** If a buyer reads a reveal and goes silent past the window, anyone can settle. The seller is paid, because the buyer had its chance. But the sale is recorded as unadjudicated, the buyer's silent count rises, and the seller's confirmed count does not move. Money follows the default; reputation does not. Most marketplaces read "no dispute" as "satisfied". In a black-box market that measures apathy, not quality.

## One important limitation

A single arbiter. The dispute path is one address that re-runs the test and rules. A vanished arbiter no longer locks funds (see unarbitrated), but a dishonest one, or one colluding with the buyer, cannot be caught by the contract. The interface is one address so a quorum can replace it.

## How it works

1. **Claim.** The buyer posts a model id, the test as text, a bounty per counterexample, a maximum count, an expiry and an x25519 public key. The whole bounty pool is escrowed.
2. **Commit.** The seller posts `keccak256(claimId, plaintext, salt)` with a bond. Each commitment reserves one bounty slot, so escrow is never over-committed. A duplicate hash on a claim is rejected.
3. **Reveal.** The seller posts the plaintext and salt, boxed to the buyer's key, on-chain, and keeps the ephemeral secret it used.
4. **Adjudicate.** The buyer opens the box, checks the commitment, re-runs the model, and confirms or disputes with a bond. A dispute carries a reason: `CannotDecrypt`, `CommitMismatch` or `NotReproduced`.
5. **Disclose.** The seller must post plaintext, salt and ephemeral secret on-chain. The contract checks plaintext and salt against the commitment and rejects an empty plaintext. A seller that cannot disclose is withdrawn and its bond goes to the buyer.
6. **Delivery check.** Spec-independent, and applied to every dispute before anything else. The arbiter rebuilds the box from the disclosed plaintext, salt and secret against the buyer's key and compares it with the posted reveal. A mismatch means the pair was never delivered, and the seller is refuted with no model run. Only then does the arbiter evaluate the model, and only for the one supported specification. A trusted-arbiter check, not on-chain cryptography: the contract stores the secret but cannot verify a box.
7. **Rule.** The arbiter re-runs the pair five times. Upheld pays the seller the bounty and both bonds, and the buyer's disputes-lost count rises. Refuted sends both bonds to the buyer.
8. **Unarbitrated.** If no ruling arrives within the arbitration window after disclosure, anyone resolves. Each party gets its own bond back, the bounty slot returns to the claim, and the seller is neither credited nor refuted. The tradeoff: the buyer keeps the disclosed pair without paying.
9. **Silence.** If the adjudication window closes with no buyer action, anyone settles. Seller paid, sale unadjudicated.

## Payments

Every payout is a push with a 50000 gas stipend. A recipient that refuses it is credited in `owed(address)` and `PaymentDeferred` is emitted. The transition completes either way, so no recipient can revert a settlement by rejecting its money. `withdraw()` pays the credit out and emits `Paid`. The page shows a deferred balance on the settlement card.

## Settlement history

Each address's settled outcomes appear under this heading; the headline is the first matching row.

| history | headline |
|---|---|
| any confirmations | N confirmed, with the adverse counts beside it |
| none confirmed, any refuted | refuted history |
| none confirmed or refuted, any withdrawn | withdrawn history |
| none confirmed, refuted or withdrawn, any unarbitrated | unarbitrated history |
| only unadjudicated sales | unverified |
| nothing settled | no history |

The adverse row (refuted, withdrawn, unarbitrated) shows whenever any of those is non-zero, whatever the headline. Withdrawn (never revealed, or never disclosed) and unarbitrated are never folded into refuted. Address-level history can be self-dealt: one party can post a claim from a second address, sell to itself and confirm.

## The one supported specification

The agents support exactly one claim, held in `agents/src/config.ts`: `claude-haiku-4-5-20251001` at temperature 0 multiplies two three-digit integers correctly, prompt `What is {a} × {b}? Reply with only the integer.` Before any spend, buyer, seller and arbiter compare the claim's model id and spec text with it by exact match and refuse anything else. Pairs are validated to 100..999.

Measured before building: three-digit pairs fail 3 of 30, four-digit 15 of 20, which would make the claim obviously false.

## The parser rule

A reply counts as an answer only if it is a single integer, with optional thousands commas and at most one trailing period. Anything else is malformed. A malformed reply never counts as a wrong multiplication, so a refusal or a sentence cannot be sold as a counterexample. A reply cut off at `max_tokens` is malformed.

## Failure modes

Designed against: nondeterminism (majority of stated runs); version drift (pinned in the claim); garbage reveals (delivery check, then refutation); a reveal the buyer cannot open (dispute reason, delivery check); frivolous disputes (bond; a lost dispute publishes the pair); silent buyers (settle rule, unverified headline); commit-and-vanish (reveal window, bond forfeited); a vanished arbiter (unarbitrated); a recipient that rejects payment (owed); replies that are not answers (parser rule); a claim the agent does not understand (exact-match refusal).

Still not caught: a dishonest single arbiter; a buyer and arbiter colluding; resale of the same pair under a new salt (on-chain dedup is designed, not built); self-dealing between addresses one party controls; a different model behind the same API; a seller that commits to an empty or junk preimage and never discloses (it forfeits its bond, the designed outcome); and delivery itself, since nothing on-chain proves it, only the arbiter's reconstruction.

## Run it

Foundry and Node 26.

```
forge test                      # 39 contract tests
cd agents && npm install && npm test
cp .env.example .env            # add ANTHROPIC_API_KEY and a funded DEPLOYER_KEY
npm run -s wallets -- gen       # appends six role keys to .env: buyer, seller, rogue, newcomer, quiet, arbiter
npm run -s wallets -- fund      # funds each role from the deployer
```

Deploy with `./scripts/deploy-testnet.sh`. It checks the deployer holds Base Sepolia ETH, generates and funds the role wallets if `.env` lacks them, deploys with all four windows at `WINDOW` seconds (default 60), writes the ABI and `docs/deployment.json`, verifies on Sourcify, and puts `MARKET_ADDRESS` in `.env`.

`./demo/scenes.sh` runs four scenes, each on its own wallet:

1. Honest sale, seller wallet: commit, reveal, the buyer confirms, the seller is paid.
2. Planted pair, rogue wallet: the buyer disputes, the seller discloses, the arbiter refutes.
3. Garbage reveal, newcomer wallet: a real pair never delivered; the delivery check refutes it.
4. Silent buyer, quiet wallet: a second claim nobody adjudicates; the sweep settles it as unadjudicated and the wallet reads unverified.

The buyer wallet posts both claims and adjudicates only the first. The arbiter wallet rules. The sweep runs on the deployer wallet. Captions read every count from `rep(address)`.

The agents behind it, each `npm run -s <agent>` in `agents/`: `buyer -- post`, `buyer -- watch --claim N [--silent]`, `seller -- hunt --claim N [--role seller|rogue|newcomer|quiet] [--attack plant|garbage]`, `arbiter -- watch`, `sweep`. Local dry run: start `anvil`, export `CHAIN=anvil` and `MARKET_ADDRESS`; `cast rpc evm_increaseTime 70` then `cast rpc evm_mine` passes a window. To record: `cd demo && npm install`, run `node record.mjs`, then `./demo/scenes.sh` beside it, then `./demo/cut.sh`.

## Where the ideas came from

Three earlier projects each found that a check that never ran reads like a check that found nothing: a mining verifier that skipped every template and reported zero false positives; a reasoning tutor that reports zero rejections in 64 pushes as at most 4.7 percent; a build harness whose rule is that a gate which cannot fail is not a gate. This market is that lesson applied to reputation.
