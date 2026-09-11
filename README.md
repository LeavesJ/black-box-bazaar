# Black Box Bazaar: a market of refutations

Autonomous agents buy and sell counterexamples to a claim about an AI model. The buyer cannot see a counterexample until its money is locked in escrow. Live on Base Sepolia.

- Page: https://leavesj.github.io/black-box-bazaar/
- Contract: `0xf347ff05478ad271adab818696134bc3cd0a07ed` on Base Sepolia, https://sepolia.basescan.org/address/0xf347ff05478ad271adab818696134bc3cd0a07ed
- Video: https://youtu.be/R-WpQ-6_KME (4:38). The four scenes on a local chain with the same code, closing on the live Base Sepolia market. The same file is in the repo: [media/bazaar-demo.mp4](media/bazaar-demo.mp4).
- The same four scenes recorded live on Base Sepolia, unedited apart from a cut: [media/bazaar-demo-testnet.mp4](media/bazaar-demo-testnet.mp4) (157 s)

## The problem, in one paragraph

Information is the one good you cannot inspect before you buy it. If the seller shows you the finding, you no longer need to pay for it. If they don't, you have no idea whether it is worth anything. Every marketplace answer starts the same way: commit a hash, escrow the payment, reveal, verify. The part most designs skip is what happens after the reveal, when the buyer has already paid and has no reason to check. "No dispute" then gets read as "satisfied", and a seller's reputation is built out of buyers who never looked. This market does two things about that. It only sells goods that check themselves once revealed. And it never lets silence count as approval.

## The vertical

Model-evaluation red-teaming. Someone who maintains a model, or an eval suite, wants to know where a property they believe in actually fails. Red-teamers find those failures. The good being sold is a counterexample: an input on which the model breaks a stated claim. Its whole value is that the buyer does not have it yet, and the moment it is revealed the buyer can test it with one re-run. That is what makes it a fair thing to sell blind.

The demo claim: `claude-haiku-4-5-20251001`, at temperature 0, multiplies two three-digit numbers correctly. Measured before building: it fails about 1 in 10 three-digit pairs (3 of 30). Four-digit pairs fail 3 in 4, which would make the claim silly. Three-digit is a claim a buyer would actually post.

## A sale, step by step

Three agents, each with its own wallet: a **buyer**, a **seller**, and an **arbiter**. All three query the same pinned model at the same settings. No language model ever touches the contract.

1. **The buyer posts a claim.** "This model multiplies three-digit numbers correctly." It says how to test it (the prompt, the pass condition, how many runs), what it pays per counterexample, how many it will buy, and publishes an encryption key. The whole bounty pool is escrowed now, before any seller shows up. That is what makes this a black box for the buyer: the money is committed before the goods exist.
2. **The seller hunts.** It asks the model random pairs until it finds one the model gets wrong. It commits a hash of that pair and posts a bond. The bond stops spam; a duplicate hash on the same claim is rejected; each commitment reserves one bounty slot so the escrow can never be over-promised.
3. **The seller reveals, encrypted.** The pair and its salt go on chain, sealed to the buyer's key. Everyone can see that something was delivered and when. Only the buyer can read it.
4. **The buyer checks.** It decrypts, confirms the hash matches the commitment, and re-runs the model three times. If the model is wrong in at least two, the buyer confirms. The seller is paid the bounty and gets its bond back.
5. **Or the buyer disputes.** It posts a bond of its own and a reason: could not decrypt, commitment mismatch, or not reproduced. The seller must now disclose the pair, the salt, and the encryption secret it used, on chain and in public. A seller that cannot is slashed and the buyer refunded.
6. **The arbiter rules.** First it checks delivery: does the disclosed secret reproduce the ciphertext that was posted? If not, the seller is refuted without running the model at all. If delivery checks out, the arbiter re-runs the pair five times. Upheld: the seller gets the bounty and both bonds, and the buyer's disputes-lost count rises. Refuted: the seller's bond goes to the buyer.
7. **Or the buyer says nothing.** When the window closes with no action, anyone can settle. The seller is paid, because the buyer had its chance. But the sale is recorded as *unadjudicated*, the buyer's silent count rises, and the seller's confirmed count stays where it was.

Every number the page shows is one of these counters, read from the chain.

## Four ways it goes wrong, and what happens

These are the four scenes in the video.

**A planted pair.** A rogue seller sells a pair the model actually gets right. The buyer re-runs it, sees the model is right, and disputes. The rogue discloses. The arbiter re-runs it five times, right every time, and refutes. The rogue loses its bond and its card reads *refuted history* from then on.

**A real pair, never delivered.** A seller finds a genuine counterexample, commits to it honestly, then reveals random bytes instead of the encrypted pair. Without a delivery check this seller wins: the buyer disputes, the seller discloses the real pair, the arbiter re-runs it and upholds the seller, and the buyer loses its bond for a good it never received. So the arbiter checks delivery first. The disclosed secret does not reproduce the posted reveal, and the seller is refuted with no model run.

**A silent buyer.** A wallet with no history sells a counterexample and the buyer never looks. The window passes, anyone settles, the seller is paid. Its card reads *unverified*: one unadjudicated, zero confirmed. Money followed the default. Reputation did not.

**A vanished arbiter.** A seller discloses and no ruling ever comes. After the arbitration window, anyone can resolve: each party takes back its own bond, the bounty slot returns to the claim, and the seller is neither credited nor refuted. The buyer keeps the disclosed pair without paying. That is a deliberate tradeoff, and it is recorded as its own state rather than disguised as silence.

## The four answers

**Vertical.** Model-evaluation red-teaming, as above.

**Trust assumptions.** The pinned model API is the shared ground truth, and buyer, seller and arbiter all reach the same model at the same settings. The arbiter is honest; there is one. Temperature 0 is not deterministic, so "the model is wrong on this input" means wrong in a majority of fixed runs (buyer 2 of 3, arbiter 3 of 5), and the claim says so.

**Biggest design decision.** Unadjudicated is a third state that never rounds to confirmed. A silent buyer pays the seller but earns it nothing. A seller with zero confirmed sales reads *unverified* no matter how many silent sales it was paid for. Most marketplaces read "no dispute" as "satisfied"; in a black-box market that measures apathy, not quality.

**One important limitation.** A single arbiter. It is one address that re-runs the test and rules, and it also does the delivery check, off chain. A vanished arbiter no longer locks funds, but a dishonest one, or one colluding with the buyer, cannot be caught by the contract. The interface is one address so a quorum can replace it.

## What the page shows

Under **Settlement history**, each address gets a headline; the first matching row wins.

| what the record holds | headline |
|---|---|
| any confirmations | N confirmed, with the adverse counts beside it |
| none confirmed, any refuted | refuted history |
| none confirmed or refuted, any withdrawn | withdrawn history |
| none of those, any unarbitrated | unarbitrated history |
| only unadjudicated sales | unverified |
| nothing settled | no history |

Withdrawn (never revealed, or never disclosed) and unarbitrated are shown as their own numbers and never folded into refuted. The page prints its own caveat: this is settlement history at the address level, not independent credibility. One party can post a claim from a second address, sell to itself, and confirm.

## Details that matter

- **A payment can never block a settlement.** Every payout is a push with a gas stipend. A recipient that refuses it is credited in `owed(address)` and can `withdraw()` later. Nobody can jam a transition by rejecting their own money.
- **One supported specification.** Before spending anything, the agents compare a claim's model id and spec text with the one they support, by exact match, and refuse anything else. Pairs must be three-digit.
- **The parser rule.** A reply counts only if it is a single integer, with thousands commas and one trailing period allowed. Anything else is malformed, and malformed never counts as a wrong multiplication, so a refusal or a sentence cannot be sold as a counterexample. A reply cut off at the token limit is malformed.
- **Delivery is checked by the arbiter, not the chain.** The contract stores the disclosed secret but cannot verify a box. That is a trusted-arbiter check, and this README says so rather than implying on-chain cryptography.

## What it does not catch

A dishonest single arbiter. A buyer and arbiter colluding. Resale of the same pair under a new salt (an on-chain check that opens a prior commitment is designed, not built). Self-dealing between addresses one party controls. A different model behind the same API. Delivery itself, since nothing on chain proves it, only the arbiter's reconstruction. A seller that commits to junk and never discloses simply forfeits its bond, which is the designed outcome.

## Run it

Foundry and Node 26.

```
forge test                      # 39 contract tests
cd agents && npm install && npm test
cp .env.example .env            # add ANTHROPIC_API_KEY and a funded DEPLOYER_KEY
npm run -s wallets -- gen       # appends six role keys to .env: buyer, seller, rogue, newcomer, quiet, arbiter
npm run -s wallets -- fund      # funds each role from the deployer
```

Deploy with `./scripts/deploy-testnet.sh`. It checks the deployer holds Base Sepolia ETH, generates and funds the role wallets if `.env` lacks them (shrinking the per-role amount to whatever the balance allows), deploys with all four windows at `WINDOW` seconds (default 60), writes the ABI and `docs/deployment.json`, submits the source to Sourcify, and puts `MARKET_ADDRESS` in `.env`. `./scripts/testnet-run.sh` does that and then publishes the page, records, cuts and fills in this file.

`./demo/scenes.sh` runs the four scenes above, each on its own wallet. The buyer wallet posts both claims and adjudicates only the first. The arbiter wallet rules. The sweep runs on the deployer wallet. Captions read every count from `rep(address)`.

The agents behind it, each `npm run -s <agent>` in `agents/`: `buyer -- post`, `buyer -- watch --claim N [--silent]`, `seller -- hunt --claim N [--role seller|rogue|newcomer|quiet] [--attack plant|garbage]`, `arbiter -- watch`, `sweep`. Local dry run: start `anvil`, export `CHAIN=anvil` and `MARKET_ADDRESS`; `cast rpc evm_increaseTime 70` then `cast rpc evm_mine` passes a window.

To record, the chain must be fresh: the captions narrate an empty market, so `scenes.sh` reads `claimCount` and `saleCount` first and refuses to start unless both are 0 (`--allow-existing` overrides). Start a fresh chain, deploy, export the ABI, serve `docs/` locally, and run the recorder, the scenes and the cut:

```
anvil --block-time 1                                    # fresh chain; or CHAIN=base-sepolia in .env
ARBITER_ADDRESS=0x… REVEAL_WINDOW=60 ADJUDICATION_WINDOW=60 DISCLOSURE_WINDOW=60 ARBITRATION_WINDOW=60 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER_KEY --broadcast
./scripts/export-abi.sh <address> <chainId> <deployedBlock>   # or ./scripts/deploy-testnet.sh for both steps on Base Sepolia
(cd docs && python3 -m http.server 8080)                # serve the page locally
(cd demo && npm install)                                # once, for playwright
export MARKET_ADDRESS=<address> CHAIN=anvil             # a shell export wins over .env
node demo/record.mjs http://localhost:8080/?record=1    # terminal 1: records until the scenes end
./demo/scenes.sh                                        # terminal 2: the four scenes
./demo/cut.sh                                           # after both finish: demo/out/bazaar-demo.mp4
```

One trap: `cast` and `forge` load the repository's `.env` on their own, so once it says `CHAIN=base-sepolia`, export `CHAIN=anvil` in the shell for any local work.

### Present it live

For a walkthrough in front of people, at your own pace, one command:

```
node demo/console.mjs
```

It starts a fresh local chain, deploys the market on it with every window at one hour (`PRESENT_WINDOW`, in seconds), starts the arbiter and the sweep, and opens http://localhost:8082/?present=1. The page is a deck: slides on the problem and the mechanism, a title card for each of the four scenes, one live step for each on-chain moment of a scene, shown on the real market page with the video's caption bar, callout, step tracker and scene badge, and closing slides on the four answers.

Walk it with the large ◀ and ▶ buttons at the bottom of the right column, or the keyboard: → Space PageDown Enter go forward, ← PageUp go back, **N** shows or hides the notes.

- **▶ on a live step does at most one thing**: post a claim, start an agent, release one agent's next transaction, or jump the local clock. Some steps release nothing: they show what an agent has already decided, or a wallet's record. The step shows a working indicator until the chain shows the result, then ▶ comes back. Every agent stops before each transaction and waits for you, so nothing happens on-chain between presses. The agents still decide what to do (confirm or dispute, how to rule); you decide when. Nothing advances on a timer, so the time is yours: talk as long as you like on any step. Every contract window is an hour, far longer than any step needs.
- **◀ walks back** through what was already shown, without undoing anything. ▶ from there walks forward through that history, and at the newest step it runs the next one.
- **Notes**: the top of the right column says what to say for the step on screen and what the next ▶ will do. The agents' own logs run below it.
- **Retry**: a step that waits too long (four minutes, eight for a hunt) turns red, naming what it waited for and quoting the problem the agent last logged. Retry waits again with a fresh timeout; an action that already went through is never repeated. If the agent the step waits on has stopped, Retry starts it again when that cannot send anything you did not release (a hunting seller, the buyer, the arbiter, the sweep); for a seller that already holds a sale it says so instead, and Reset chain starts over.
- **Reset chain**, in the notes header, asks first, then stops everything and starts over from an empty market at the title slide. Ctrl-C in the terminal stops everything.

The model calls happen while the agents hunt and check: a hunting seller asks the model random pairs until one is wrong, the buyer re-runs a reveal three times, and the arbiter re-runs a dispute five times, each before it stops at its gate. A hunt or a check can therefore take a while after you press ▶; a release lands within a block or two.

Nothing touches the testnet or any committed file: the page is served from a scratch copy under `demo/out/present/`, with the agents' logs and gate files beside it. Needs Foundry, Node 26, `agents/node_modules` and `ANTHROPIC_API_KEY` in `.env`; each boot makes one model call to check the key, so a missing or refused one shows in the notes before the talk rather than at the first hunt. Ports: `PRESENT_PORT` (8082) and `PRESENT_ANVIL_PORT` (8546). One console at a time: running the command again while one is up exits at once and leaves the running one alone.

## Where the ideas came from

Three earlier projects each found that a check that never ran reads exactly like a check that found nothing: a mining verifier that skipped every template and reported zero false positives; a reasoning tutor that reports zero rejections in 64 pushes as "at most 4.7 percent"; a build harness whose rule is that a gate which cannot fail is not a gate. This market is that lesson applied to reputation.
