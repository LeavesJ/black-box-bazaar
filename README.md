# Black Box Bazaar: a market of refutations

Autonomous agents buy and sell counterexamples to a claim about an AI model, on Base Sepolia. The buyer cannot see the counterexample before paying.

- Page: https://leavesj.github.io/black-box-bazaar/
- Contract: `0xTHEADDRESS` on Base Sepolia, https://sepolia.basescan.org/address/0xTHEADDRESS
- Video: (video link)

## Vertical

Model-evaluation red-teaming. A buyer agent acts for whoever maintains a model or an eval suite and wants to know where a stated property fails. Seller agents hunt for inputs that break the property and sell them. An arbiter agent re-runs disputed inputs and rules. The good is a counterexample. Its value is that the buyer does not have it yet, and once revealed it is checked by re-running the model. No language model touches the contract.

## Trust assumptions

- The pinned model API is the shared ground truth, and buyer, seller and arbiter all reach the same model at the same settings.
- The arbiter address is honest. There is one. It also performs the delivery check, off-chain.
- Temperature 0 is not deterministic. "The model is wrong on this input" means wrong in a majority of fixed runs: buyer 2 of 3, arbiter 3 of 5. The claim states this.

## Biggest design decision

**Unadjudicated is a third state that never rounds to confirmed.** If a buyer reads a reveal and goes silent past the window, anyone can settle. The seller is paid, because the buyer had its chance. But the sale is recorded as unadjudicated, the buyer's silent count rises, and the seller's confirmed count does not move. Money follows the default; reputation does not. Most marketplaces read "no dispute" as "satisfied". In a black-box market that measures apathy, not quality.

## One important limitation

A single arbiter. The dispute path is one address that re-runs the test and rules. A vanished arbiter no longer locks funds (see unarbitrated below), but a dishonest one, or one colluding with the buyer, cannot be caught by the contract. The interface is one address so a quorum can replace it later.

## How it works

1. **Claim.** The buyer posts a model id, the test as text, a bounty per counterexample, a maximum count, an expiry and an x25519 public key. The whole bounty pool is escrowed.
2. **Commit.** The seller posts `keccak256(claimId, plaintext, salt)` with a bond. Each commitment reserves one bounty slot, so escrow is never over-committed. A duplicate hash on the same claim is rejected.
3. **Reveal.** The seller posts the plaintext and salt, boxed to the buyer's key, on-chain. The seller keeps the ephemeral secret it used for the box.
4. **Adjudicate.** The buyer opens the box, checks the commitment, re-runs the model, and confirms or disputes with a bond. A dispute carries a reason: `CannotDecrypt`, `CommitMismatch` or `NotReproduced`.
5. **Disclose.** The seller must post plaintext, salt and ephemeral secret on-chain. The contract checks plaintext and salt against the commitment. A seller that cannot is withdrawn and its bond goes to the buyer.
6. **Delivery check.** Before running the model, the arbiter rebuilds the box from the disclosed plaintext, salt and secret against the claim's buyer key and compares it with the posted reveal. A mismatch means the buyer never received the pair, and the seller is refuted. This is a trusted-arbiter check, not on-chain cryptography: the contract stores the secret but cannot verify a box.
7. **Rule.** The arbiter re-runs the pair five times. Upheld pays the seller the bounty and both bonds, and the buyer's disputes-lost count rises. Refuted sends both bonds to the buyer.
8. **Unarbitrated.** If no ruling arrives within the arbitration window after disclosure, anyone resolves. Each party gets its own bond back, the bounty slot returns to the claim, and the seller is neither credited nor refuted. The tradeoff: the buyer keeps the disclosed pair without paying. The arbiter can still rule until someone resolves.
9. **Silence.** If the adjudication window closes with no buyer action, anyone settles. Seller paid, sale unadjudicated.

## Settlement history

The page shows each address's settled outcomes under this heading. The headline follows this table.

| history | headline |
|---|---|
| only unadjudicated sales | unverified |
| refutations and no confirmations | refuted history |
| confirmations present | N confirmed, with refuted, withdrawn and unarbitrated counts beside it |

Withdrawn (never revealed, or never disclosed) and unarbitrated are shown as their own counts and are never folded into refuted. Address-level history can be self-dealt: a seller can post a claim from a second address, sell to itself and confirm. Nothing here says who is behind an address.

## The one supported specification

The agents support exactly one claim, held in `agents/src/config.ts`: `claude-haiku-4-5-20251001` at temperature 0 multiplies two three-digit integers correctly, prompt `What is {a} × {b}? Reply with only the integer.` Before any spend, buyer, seller and arbiter compare the claim's model id and spec text with this one by exact match and refuse anything else. Pairs are validated to 100..999 on both sides.

Measured before building, at temperature 0: three-digit pairs fail 3 of 30, four-digit pairs fail 15 of 20. Four-digit would make the claim obviously false and the hunt trivial, so the claim is three-digit.

## The parser rule

A reply counts as an answer only if it is a single integer, with optional thousands commas and at most one trailing period. Anything else is malformed. A malformed reply never counts as a wrong multiplication, so a refusal or a sentence cannot be sold as a counterexample. Output truncated by the token limit (`stop_reason` of `max_tokens`) is malformed. Only an answer that parses and differs from `a*b` counts as wrong.

## Failure modes

Designed against: nondeterminism (majority of stated runs); version drift (version pinned in the claim); garbage reveals (delivery check, then refutation); a reveal the buyer cannot open (dispute reason, delivery check); frivolous disputes (bond, and a lost dispute makes the pair public); silent buyers (settle rule, unverified headline); commit-and-vanish (reveal window, bond forfeited); a vanished arbiter (unarbitrated); replies that are not answers (parser rule); trading against a claim the agent does not understand (exact-match refusal).

Not caught: a dishonest single arbiter; a buyer and arbiter colluding; resale of the same pair under a new salt (the pair space is small enough that an unsalted commitment is guessable, so dedup needs the buyer to open a prior commitment on-chain: designed, not built); self-dealing between addresses one party controls; a different model behind the same API.

## Run it

Foundry and Node 26.

```
forge test                      # 33 contract tests
cd agents && npm install && npm test
cp .env.example .env            # add ANTHROPIC_API_KEY and a funded DEPLOYER_KEY
npm run -s wallets -- gen       # appends role keys to .env
npm run -s wallets -- fund      # sends each role ETH from the deployer
```

Deploy with `ARBITER_ADDRESS` set and the four windows in seconds (`REVEAL_WINDOW`, `ADJUDICATION_WINDOW`, `DISCLOSURE_WINDOW`, `ARBITRATION_WINDOW`, default 90):

```
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --private-key "$DEPLOYER_KEY" --broadcast
./scripts/export-abi.sh <address> 84532 <block>
```

Put the printed `MARKET_ADDRESS` in `.env`. Then `./demo/scenes.sh` runs the three scenes: an honest sale, a rogue seller caught by the arbiter, and a silent buyer settled by the sweep. The agents behind it: `npm run -s buyer -- post`, `npm run -s buyer -- watch --claim N [--silent]`, `npm run -s seller -- hunt --claim N [--role rogue --attack plant]`, `npm run -s arbiter -- watch`, `npm run -s sweep`. For a local dry run, start `anvil`, export `CHAIN=anvil` and `MARKET_ADDRESS`, and pass a window with `cast rpc evm_increaseTime 70` then `cast rpc evm_mine`. To record: `cd demo && npm install && node record.mjs`, then `./demo/cut.sh`.

## Where the ideas came from

Three earlier projects each found that a check that never ran reads like a check that found nothing: a mining verifier that reported zero false positives from a shield that skipped every template; a reasoning tutor that reports zero rejections in 64 pushes as at most 4.7 percent; a build harness whose invariant is that a gate which cannot fail is not a gate. This market is that lesson applied to reputation.
