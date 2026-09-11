# Black Box Bazaar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A claim-first market on Base Sepolia where agents buy and sell counterexamples to a claim about a pinned model, with silence recorded as unadjudicated rather than confirmed.

**Architecture:** One Solidity contract holds claims, commitments, encrypted reveals, disputes, escrow and reputation counters. Three TypeScript agents (buyer, seller, arbiter) plus a sweep script drive it against the real model API. One static page reads contract state from a public RPC. A Playwright recorder produces the demo video.

**Tech Stack:** Foundry 1.8 (Solidity ^0.8.24), Node 26 running TypeScript natively, viem 2, @anthropic-ai/sdk, tweetnacl, Playwright, ffmpeg, macOS `say`.

**Spec:** `docs/superpowers/specs/2026-09-10-black-box-bazaar-design.md`

## Global Constraints

- Model id everywhere: `claude-haiku-4-5-20251001`, temperature 0, max_tokens 32.
- Prompt everywhere: `What is {a} × {b}? Reply with only the integer.` with a multiplication sign U+00D7.
- Pairs are three-digit: 100..999 inclusive.
- Canonical plaintext: `{"a":123,"b":456}`, no whitespace, keys in that order.
- Commitment: `keccak256(abi.encode(claimId, plaintext, salt))` with `claimId` uint256, `plaintext` bytes, `salt` bytes32. Test vector: claimId 1, plaintext `0x7b2261223a3132332c2262223a3435367d`, salt `0x11..11` (32 bytes) → `0xe42ef964f458bf6a7f29035d0d681389f65fe8e1462a4346c7ee63f087a9f67f`.
- Reveal ciphertext layout: `ephemeralPub(32) || nonce(24) || nacl.box(plaintext || salt)`.
- Demo windows: reveal 90 s, adjudication 90 s, disclosure 90 s. bondBps 2000. bounty 0.0005 ETH. maxHits 3.
- Buyer verifies 3 runs, wrong ≥ 2. Arbiter verifies 5 runs, wrong ≥ 3.
- Chain: Base Sepolia, chain id 84532, RPC `https://sepolia.base.org`, explorer `https://sepolia.basescan.org`.
- Never commit `.env`. Never print a private key.
- Every Foundry test is run and seen failing before the code that passes it.
- Repo root is `~/Documents/BlackBoxBazaar`. Foundry lives at the root (`src/`, `test/`, `script/`). Agents live in `agents/`. The page lives in `docs/`. Demo tooling lives in `demo/`.
- Foundry binaries are at `~/.foundry/bin`; every shell that runs `forge`, `cast` or `anvil` does `export PATH="$HOME/.foundry/bin:$PATH"` first.

---

## File structure

```
foundry.toml                      Foundry config (src, test, script, solc 0.8.24)
src/RefutationMarket.sol          the market: claims, sales, escrow, reputation
test/RefutationMarket.t.sol       state machine tests, every transition and refusal
script/Deploy.s.sol               deploys with windows and arbiter from env
scripts/export-abi.sh             copies ABI to agents/src/abi.json and docs/abi.json
agents/package.json               type: module, deps, scripts
agents/src/config.ts              chain, RPC, model constants, role keys
agents/src/chain.ts               viem clients per role, contract handle, receipt wait
agents/src/log.ts                 NDJSON logger to stdout and demo/logs/<role>.log
agents/src/crypto.ts              x25519 keys, seal/open, canonical pair, commit hash
agents/src/model.ts               ask the model, parse, majority-of-runs verdict
agents/src/buyer.ts               post a claim; watch reveals; confirm or dispute; --silent
agents/src/seller.ts              hunt, commit, reveal; watch disputes and disclose; --rogue
agents/src/arbiter.ts             watch disclosures; re-run; rule
agents/src/sweep.ts               settle / expireCommit / withdrawSale where windows passed
agents/src/wallets.ts             generate role keys; fund them from the deployer
agents/test/crypto.test.ts        roundtrip, canonical form, cross-seam hash vector
agents/test/model.test.ts         parser cases
docs/index.html                   the page
docs/app.js                       page logic, viem from CDN
docs/deployment.json              address, chainId, rpc, explorer, deployedBlock (written by export-abi.sh)
docs/abi.json                     ABI for the page
demo/scenes.sh                    orchestrates the three scenes, writes demo/scene.txt and demo/timeline.json
demo/record.mjs                   Playwright recorder with caption and agent-log overlays
demo/narrate.sh                   optional synthetic narration muxed by scene timestamps
README.md                         the four required answers, how to run, addresses
```

---

### Task 1: Scaffold, claim posting, commit and reveal

**Files:**
- Create: `foundry.toml`
- Create: `src/RefutationMarket.sol`
- Create: `test/RefutationMarket.t.sol`

**Interfaces:**
- Produces: `RefutationMarket` with `postClaim`, `commit`, `reveal`, `bondFor`, `getClaim`, `getSale`, `claimCount`, `saleCount`, the `Claim`/`Sale`/`Rep` structs and `SaleState` enum exactly as below. Later tasks add functions to this same file.

- [ ] **Step 1: Scaffold Foundry at the repo root**

```bash
cd ~/Documents/BlackBoxBazaar && export PATH="$HOME/.foundry/bin:$PATH"
forge install foundry-rs/forge-std --no-commit 2>&1 | tail -1 || forge install foundry-rs/forge-std 2>&1 | tail -1
mkdir -p src test script
cat > foundry.toml <<'EOF'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
EOF
forge build 2>&1 | tail -1
```
Expected: `lib/forge-std` exists as a submodule; build succeeds with nothing to compile.

- [ ] **Step 2: Write the failing tests for claim, commit, reveal**

```solidity
// test/RefutationMarket.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {RefutationMarket} from "../src/RefutationMarket.sol";

contract RefutationMarketTest is Test {
    RefutationMarket m;
    address buyer = address(0xB0B);
    address seller = address(0x5E11);
    address arbiter = address(0xA4B);
    address other = address(0x07E4);

    uint64 constant REVEAL = 90;
    uint64 constant ADJ = 90;
    uint64 constant DISC = 90;
    uint256 constant BOUNTY = 0.0005 ether;
    uint32 constant MAX = 3;
    bytes32 constant PUB = bytes32(uint256(0xABCD));
    bytes PT = bytes('{"a":123,"b":456}');
    bytes32 constant SALT = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));

    function setUp() public {
        m = new RefutationMarket(arbiter, REVEAL, ADJ, DISC, 2000);
        vm.deal(buyer, 1 ether);
        vm.deal(seller, 1 ether);
        vm.deal(other, 1 ether);
    }

    // ---- helpers ----
    function _postMax(uint32 max) internal returns (uint256) {
        vm.prank(buyer);
        return m.postClaim{value: BOUNTY * max}("claude-haiku-4-5-20251001", "spec", PUB, BOUNTY, max, 1 hours);
    }
    function _post() internal returns (uint256) { return _postMax(MAX); }
    function _hash(uint256 claimId) internal view returns (bytes32) {
        return keccak256(abi.encode(claimId, PT, SALT));
    }
    function _commit(uint256 claimId) internal returns (uint256) {
        uint256 bond = m.bondFor(claimId);   // read before pranking: a prank is spent by the next external call
        bytes32 h = _hash(claimId);
        vm.prank(seller);
        return m.commit{value: bond}(claimId, h);
    }
    function _reveal(uint256 saleId) internal {
        vm.prank(seller);
        m.reveal(saleId, hex"deadbeef");
    }

    // ---- claim ----
    function test_postClaim_escrowsAndStores() public {
        uint256 id = _post();
        assertEq(id, 0);
        assertEq(address(m).balance, BOUNTY * MAX);
        RefutationMarket.Claim memory c = m.getClaim(0);
        assertEq(c.buyer, buyer);
        assertEq(c.bounty, BOUNTY);
        assertEq(c.maxHits, MAX);
        assertEq(c.hits, 0);
        assertEq(c.pending, 0);
        assertEq(c.buyerPubKey, PUB);
        assertEq(c.expiresAt, uint64(block.timestamp) + 1 hours);
        assertFalse(c.closed);
        assertEq(m.claimCount(), 1);
    }

    function test_postClaim_revertsOnWrongValue() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(RefutationMarket.WrongValue.selector, BOUNTY * MAX, BOUNTY));
        m.postClaim{value: BOUNTY}("m", "s", PUB, BOUNTY, MAX, 1 hours);
    }

    // ---- commit ----
    function test_commit_reservesSlotAndTakesBond() public {
        uint256 cid = _post();
        uint256 bond = m.bondFor(cid);
        assertEq(bond, BOUNTY * 2000 / 10_000);
        uint256 sid = _commit(cid);
        assertEq(sid, 0);
        RefutationMarket.Sale memory s = m.getSale(0);
        assertEq(s.seller, seller);
        assertEq(s.sellerBond, bond);
        assertEq(uint8(s.state), uint8(RefutationMarket.SaleState.Committed));
        assertEq(m.getClaim(cid).pending, 1);
        assertEq(address(m).balance, BOUNTY * MAX + bond);
    }

    function test_commit_revertsOnDuplicateHash() public {
        uint256 cid = _post();
        _commit(cid);
        uint256 bond = m.bondFor(cid);
        bytes32 h = _hash(cid);
        vm.prank(seller);
        vm.expectRevert(RefutationMarket.DuplicateCommit.selector);
        m.commit{value: bond}(cid, h);
    }

    function test_commit_revertsWhenFull() public {
        uint256 cid = _postMax(1);
        _commit(cid);
        uint256 bond = m.bondFor(cid);
        vm.prank(other);
        vm.expectRevert(RefutationMarket.ClaimFull.selector);
        m.commit{value: bond}(cid, keccak256("another"));
    }

    function test_commit_revertsOnWrongBond() public {
        uint256 cid = _post();
        uint256 bond = m.bondFor(cid);
        bytes32 h = _hash(cid);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(RefutationMarket.WrongValue.selector, bond, 1));
        m.commit{value: 1}(cid, h);
    }

    function test_commit_revertsAfterExpiry() public {
        uint256 cid = _post();
        vm.warp(block.timestamp + 1 hours);
        uint256 bond = m.bondFor(cid);
        bytes32 h = _hash(cid);
        vm.prank(seller);
        vm.expectRevert(RefutationMarket.ClaimNotOpen.selector);
        m.commit{value: bond}(cid, h);
    }

    // ---- reveal ----
    function test_reveal_setsStateAndStoresCiphertext() public {
        uint256 cid = _post();
        uint256 sid = _commit(cid);
        _reveal(sid);
        RefutationMarket.Sale memory s = m.getSale(sid);
        assertEq(uint8(s.state), uint8(RefutationMarket.SaleState.Revealed));
        assertEq(s.ciphertext, hex"deadbeef");
        assertEq(s.revealedAt, uint64(block.timestamp));
    }

    function test_reveal_revertsForNonSeller() public {
        uint256 cid = _post();
        uint256 sid = _commit(cid);
        vm.prank(other);
        vm.expectRevert(RefutationMarket.NotSeller.selector);
        m.reveal(sid, hex"01");
    }

    function test_reveal_revertsAfterWindow() public {
        uint256 cid = _post();
        uint256 sid = _commit(cid);
        vm.warp(block.timestamp + REVEAL + 1);
        vm.prank(seller);
        vm.expectRevert(RefutationMarket.WindowClosed.selector);
        m.reveal(sid, hex"01");
    }
}
```

- [ ] **Step 3: Run the tests and see them fail to compile**

Run: `cd ~/Documents/BlackBoxBazaar && export PATH="$HOME/.foundry/bin:$PATH" && forge test 2>&1 | tail -5`
Expected: compile error, `RefutationMarket` not found.

- [ ] **Step 4: Write the contract with claim, commit, reveal**

```solidity
// src/RefutationMarket.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RefutationMarket
/// @notice A claim-first market for counterexamples. A buyer escrows bounties
/// for counterexamples to a claim about a pinned model. Sellers commit a hash,
/// reveal an encrypted counterexample, and are paid once the buyer confirms,
/// the arbiter upholds them, or the buyer stays silent past the window.
/// Silence pays the seller but is recorded as unadjudicated, never confirmed.
contract RefutationMarket {
    enum SaleState { Committed, Revealed, Confirmed, Disputed, Refuted, Upheld, Unadjudicated, Withdrawn }

    struct Claim {
        address buyer;
        string modelId;
        string spec;
        bytes32 buyerPubKey;
        uint256 bounty;
        uint32 maxHits;
        uint32 hits;
        uint32 pending;
        uint64 expiresAt;
        bool closed;
    }

    struct Sale {
        uint256 claimId;
        address seller;
        bytes32 commitHash;
        uint256 sellerBond;
        bytes ciphertext;
        uint64 committedAt;
        uint64 revealedAt;
        uint64 disputedAt;
        uint256 buyerBond;
        bytes plaintext;
        SaleState state;
    }

    struct Rep {
        uint32 sellerConfirmed;
        uint32 sellerRefuted;
        uint32 sellerUnadjudicated;
        uint32 sellerWithdrawn;
        uint32 buyerAdjudicated;
        uint32 buyerSilent;
        uint32 buyerDisputesLost;
    }

    address public immutable arbiter;
    uint64 public immutable revealWindow;
    uint64 public immutable adjudicationWindow;
    uint64 public immutable disclosureWindow;
    uint256 public immutable bondBps;

    Claim[] private _claims;
    Sale[] private _sales;
    mapping(address => Rep) public rep;
    mapping(uint256 => mapping(bytes32 => bool)) public commitUsed;

    event ClaimPosted(uint256 indexed claimId, address indexed buyer, string modelId, string spec, bytes32 buyerPubKey, uint256 bounty, uint32 maxHits, uint64 expiresAt);
    event Committed(uint256 indexed saleId, uint256 indexed claimId, address indexed seller, bytes32 commitHash, uint256 bond);
    event Revealed(uint256 indexed saleId, uint256 indexed claimId, bytes ciphertext);
    event Confirmed(uint256 indexed saleId, uint256 indexed claimId);
    event Disputed(uint256 indexed saleId, uint256 indexed claimId, uint256 buyerBond);
    event Disclosed(uint256 indexed saleId, uint256 indexed claimId, bytes plaintext, bytes32 salt);
    event Ruled(uint256 indexed saleId, uint256 indexed claimId, bool sellerWasRight);
    event Settled(uint256 indexed saleId, uint256 indexed claimId);
    event Withdrawn(uint256 indexed saleId, uint256 indexed claimId, string reason);
    event ClaimClosed(uint256 indexed claimId, uint256 refunded);

    error WrongValue(uint256 expected, uint256 got);
    error NotBuyer();
    error NotSeller();
    error NotArbiter();
    error WrongState(SaleState expected, SaleState got);
    error ClaimNotOpen();
    error ClaimFull();
    error DuplicateCommit();
    error WindowClosed();
    error WindowOpen();
    error HashMismatch();
    error AlreadyDisclosed();
    error NotDisclosed();
    error ClaimHasPending();
    error ClaimNotExpired();
    error ZeroArgument();
    error TransferFailed();

    constructor(address _arbiter, uint64 _revealWindow, uint64 _adjudicationWindow, uint64 _disclosureWindow, uint256 _bondBps) {
        if (_arbiter == address(0) || _revealWindow == 0 || _adjudicationWindow == 0 || _disclosureWindow == 0) revert ZeroArgument();
        arbiter = _arbiter;
        revealWindow = _revealWindow;
        adjudicationWindow = _adjudicationWindow;
        disclosureWindow = _disclosureWindow;
        bondBps = _bondBps;
    }

    // ---------- views ----------
    function claimCount() external view returns (uint256) { return _claims.length; }
    function saleCount() external view returns (uint256) { return _sales.length; }
    function getClaim(uint256 claimId) external view returns (Claim memory) { return _claims[claimId]; }
    function getSale(uint256 saleId) external view returns (Sale memory) { return _sales[saleId]; }
    function bondFor(uint256 claimId) public view returns (uint256) { return _claims[claimId].bounty * bondBps / 10_000; }

    // ---------- claim ----------
    function postClaim(string calldata modelId, string calldata spec, bytes32 buyerPubKey, uint256 bounty, uint32 maxHits, uint64 duration)
        external payable returns (uint256 claimId)
    {
        if (bounty == 0 || maxHits == 0 || duration == 0) revert ZeroArgument();
        uint256 expected = bounty * maxHits;
        if (msg.value != expected) revert WrongValue(expected, msg.value);
        uint64 expiresAt = uint64(block.timestamp) + duration;
        claimId = _claims.length;
        _claims.push(Claim({
            buyer: msg.sender, modelId: modelId, spec: spec, buyerPubKey: buyerPubKey,
            bounty: bounty, maxHits: maxHits, hits: 0, pending: 0, expiresAt: expiresAt, closed: false
        }));
        emit ClaimPosted(claimId, msg.sender, modelId, spec, buyerPubKey, bounty, maxHits, expiresAt);
    }

    // ---------- commit / reveal ----------
    function commit(uint256 claimId, bytes32 commitHash) external payable returns (uint256 saleId) {
        Claim storage c = _claims[claimId];
        if (c.closed || block.timestamp >= c.expiresAt) revert ClaimNotOpen();
        if (c.hits + c.pending >= c.maxHits) revert ClaimFull();
        if (commitUsed[claimId][commitHash]) revert DuplicateCommit();
        uint256 bond = bondFor(claimId);
        if (msg.value != bond) revert WrongValue(bond, msg.value);
        commitUsed[claimId][commitHash] = true;
        c.pending += 1;
        saleId = _sales.length;
        _sales.push();
        Sale storage s = _sales[saleId];
        s.claimId = claimId;
        s.seller = msg.sender;
        s.commitHash = commitHash;
        s.sellerBond = bond;
        s.committedAt = uint64(block.timestamp);
        s.state = SaleState.Committed;
        emit Committed(saleId, claimId, msg.sender, commitHash, bond);
    }

    function reveal(uint256 saleId, bytes calldata ciphertext) external {
        Sale storage s = _sales[saleId];
        if (msg.sender != s.seller) revert NotSeller();
        _requireState(s, SaleState.Committed);
        if (block.timestamp > s.committedAt + revealWindow) revert WindowClosed();
        if (ciphertext.length == 0) revert ZeroArgument();
        s.ciphertext = ciphertext;
        s.revealedAt = uint64(block.timestamp);
        s.state = SaleState.Revealed;
        emit Revealed(saleId, s.claimId, ciphertext);
    }

    // ---------- internal ----------
    function _requireState(Sale storage s, SaleState expected) internal view {
        if (s.state != expected) revert WrongState(expected, s.state);
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `forge test 2>&1 | tail -15`
Expected: 10 tests pass.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/BlackBoxBazaar && git add -A && git commit -q -m "feat(market): claims, commitments and encrypted reveals, tested" && git log --oneline | head -1
```

---

### Task 2: Adjudication: confirm, dispute, disclose, rule

**Files:**
- Modify: `src/RefutationMarket.sol` (add four functions before `// ---------- internal ----------`)
- Modify: `test/RefutationMarket.t.sol` (add helpers and tests)

**Interfaces:**
- Consumes: Task 1 contract and test helpers.
- Produces: `confirm(uint256)`, `dispute(uint256) payable`, `disclose(uint256, bytes, bytes32)`, `rule(uint256, bool)`.

- [ ] **Step 1: Add helpers and failing tests**

Add inside the test contract, after `_reveal`:

```solidity
    function _dispute(uint256 saleId) internal {
        uint256 bond = m.bondFor(m.getSale(saleId).claimId);
        vm.prank(buyer);
        m.dispute{value: bond}(saleId);
    }
    function _disclose(uint256 saleId) internal {
        vm.prank(seller);
        m.disclose(saleId, PT, SALT);
    }
    function _revealedSale() internal returns (uint256 cid, uint256 sid) {
        cid = _post();
        sid = _commit(cid);
        _reveal(sid);
    }

    // ---- confirm ----
    function test_confirm_paysSellerAndBumpsRep() public {
        (uint256 cid, uint256 sid) = _revealedSale();
        uint256 before = seller.balance;
        vm.prank(buyer);
        m.confirm(sid);
        assertEq(seller.balance, before + BOUNTY + m.bondFor(cid));
        assertEq(uint8(m.getSale(sid).state), uint8(RefutationMarket.SaleState.Confirmed));
        assertEq(m.getClaim(cid).hits, 1);
        assertEq(m.getClaim(cid).pending, 0);
        (uint32 conf,,,, uint32 adj,,) = m.rep(seller);
        assertEq(conf, 1);
        (,,,, uint32 badj,,) = m.rep(buyer);
        assertEq(badj, 1);
        assertEq(adj, 0);
    }

    function test_confirm_revertsForNonBuyer() public {
        (, uint256 sid) = _revealedSale();
        vm.prank(other);
        vm.expectRevert(RefutationMarket.NotBuyer.selector);
        m.confirm(sid);
    }

    function test_confirm_revertsAfterWindow() public {
        (, uint256 sid) = _revealedSale();
        vm.warp(block.timestamp + ADJ + 1);
        vm.prank(buyer);
        vm.expectRevert(RefutationMarket.WindowClosed.selector);
        m.confirm(sid);
    }

    // ---- dispute / disclose ----
    function test_dispute_takesBondAndSetsState() public {
        (uint256 cid, uint256 sid) = _revealedSale();
        uint256 before = address(m).balance;
        _dispute(sid);
        RefutationMarket.Sale memory s = m.getSale(sid);
        assertEq(uint8(s.state), uint8(RefutationMarket.SaleState.Disputed));
        assertEq(s.buyerBond, m.bondFor(cid));
        assertEq(address(m).balance, before + m.bondFor(cid));
    }

    function test_disclose_revertsOnHashMismatch() public {
        (, uint256 sid) = _revealedSale();
        _dispute(sid);
        vm.prank(seller);
        vm.expectRevert(RefutationMarket.HashMismatch.selector);
        m.disclose(sid, bytes('{"a":1,"b":2}'), SALT);
    }

    function test_disclose_storesPlaintext() public {
        (, uint256 sid) = _revealedSale();
        _dispute(sid);
        _disclose(sid);
        assertEq(m.getSale(sid).plaintext, PT);
    }

    // ---- rule ----
    function test_rule_revertsBeforeDisclosure() public {
        (, uint256 sid) = _revealedSale();
        _dispute(sid);
        vm.prank(arbiter);
        vm.expectRevert(RefutationMarket.NotDisclosed.selector);
        m.rule(sid, true);
    }

    function test_rule_revertsForNonArbiter() public {
        (, uint256 sid) = _revealedSale();
        _dispute(sid);
        _disclose(sid);
        vm.prank(other);
        vm.expectRevert(RefutationMarket.NotArbiter.selector);
        m.rule(sid, true);
    }

    function test_rule_upheld_paysSellerEverything() public {
        (uint256 cid, uint256 sid) = _revealedSale();
        _dispute(sid);
        _disclose(sid);
        uint256 before = seller.balance;
        vm.prank(arbiter);
        m.rule(sid, true);
        assertEq(seller.balance, before + BOUNTY + 2 * m.bondFor(cid));
        assertEq(uint8(m.getSale(sid).state), uint8(RefutationMarket.SaleState.Upheld));
        assertEq(m.getClaim(cid).hits, 1);
        assertEq(m.getClaim(cid).pending, 0);
        (uint32 conf,,,,,, ) = m.rep(seller);
        assertEq(conf, 1);
        (,,,,,, uint32 lost) = m.rep(buyer);
        assertEq(lost, 1);
    }

    function test_rule_refuted_paysBuyerBothBonds() public {
        (uint256 cid, uint256 sid) = _revealedSale();
        _dispute(sid);
        _disclose(sid);
        uint256 before = buyer.balance;
        vm.prank(arbiter);
        m.rule(sid, false);
        assertEq(buyer.balance, before + 2 * m.bondFor(cid));
        assertEq(uint8(m.getSale(sid).state), uint8(RefutationMarket.SaleState.Refuted));
        assertEq(m.getClaim(cid).hits, 0);
        assertEq(m.getClaim(cid).pending, 0);
        (, uint32 refuted,,,,, ) = m.rep(seller);
        assertEq(refuted, 1);
        assertEq(address(m).balance, BOUNTY * MAX);
    }
```

- [ ] **Step 2: Run and see the new tests fail**

Run: `forge test 2>&1 | tail -5`
Expected: compile error, `confirm` is not a member.

- [ ] **Step 3: Add the four functions**

Insert before `// ---------- internal ----------`:

```solidity
    // ---------- adjudication ----------
    function confirm(uint256 saleId) external {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        if (msg.sender != c.buyer) revert NotBuyer();
        _requireState(s, SaleState.Revealed);
        if (block.timestamp > s.revealedAt + adjudicationWindow) revert WindowClosed();
        s.state = SaleState.Confirmed;
        c.hits += 1;
        c.pending -= 1;
        rep[s.seller].sellerConfirmed += 1;
        rep[c.buyer].buyerAdjudicated += 1;
        emit Confirmed(saleId, s.claimId);
        _pay(s.seller, c.bounty + s.sellerBond);
    }

    function dispute(uint256 saleId) external payable {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        if (msg.sender != c.buyer) revert NotBuyer();
        _requireState(s, SaleState.Revealed);
        if (block.timestamp > s.revealedAt + adjudicationWindow) revert WindowClosed();
        uint256 bond = bondFor(s.claimId);
        if (msg.value != bond) revert WrongValue(bond, msg.value);
        s.buyerBond = bond;
        s.disputedAt = uint64(block.timestamp);
        s.state = SaleState.Disputed;
        rep[c.buyer].buyerAdjudicated += 1;
        emit Disputed(saleId, s.claimId, bond);
    }

    function disclose(uint256 saleId, bytes calldata plaintext, bytes32 salt) external {
        Sale storage s = _sales[saleId];
        if (msg.sender != s.seller) revert NotSeller();
        _requireState(s, SaleState.Disputed);
        if (s.plaintext.length != 0) revert AlreadyDisclosed();
        if (block.timestamp > s.disputedAt + disclosureWindow) revert WindowClosed();
        if (keccak256(abi.encode(s.claimId, plaintext, salt)) != s.commitHash) revert HashMismatch();
        s.plaintext = plaintext;
        emit Disclosed(saleId, s.claimId, plaintext, salt);
    }

    function rule(uint256 saleId, bool sellerWasRight) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        _requireState(s, SaleState.Disputed);
        if (s.plaintext.length == 0) revert NotDisclosed();
        c.pending -= 1;
        emit Ruled(saleId, s.claimId, sellerWasRight);
        if (sellerWasRight) {
            s.state = SaleState.Upheld;
            c.hits += 1;
            rep[s.seller].sellerConfirmed += 1;
            rep[c.buyer].buyerDisputesLost += 1;
            _pay(s.seller, c.bounty + s.sellerBond + s.buyerBond);
        } else {
            s.state = SaleState.Refuted;
            rep[s.seller].sellerRefuted += 1;
            _pay(c.buyer, s.sellerBond + s.buyerBond);
        }
    }
```

- [ ] **Step 4: Run and see all tests pass**

Run: `forge test 2>&1 | tail -5`
Expected: 20 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -q -m "feat(market): confirm, dispute, disclose and rule, with bonds moving on every verdict" && git log --oneline | head -1
```

---

### Task 3: Windows: settle, expire, withdraw, close, and the cross-seam vector

**Files:**
- Modify: `src/RefutationMarket.sol`
- Modify: `test/RefutationMarket.t.sol`

**Interfaces:**
- Produces: `settle(uint256)`, `expireCommit(uint256)`, `withdrawSale(uint256)`, `closeClaim(uint256)`. The contract is complete after this task.

- [ ] **Step 1: Add failing tests**

```solidity
    // ---- windows ----
    function test_settle_revertsWhileWindowOpen() public {
        (, uint256 sid) = _revealedSale();
        vm.expectRevert(RefutationMarket.WindowOpen.selector);
        m.settle(sid);
    }

    function test_settle_paysSellerAndRecordsUnadjudicated() public {
        (uint256 cid, uint256 sid) = _revealedSale();
        vm.warp(block.timestamp + ADJ + 1);
        uint256 before = seller.balance;
        vm.prank(other);
        m.settle(sid);
        assertEq(seller.balance, before + BOUNTY + m.bondFor(cid));
        assertEq(uint8(m.getSale(sid).state), uint8(RefutationMarket.SaleState.Unadjudicated));
        assertEq(m.getClaim(cid).hits, 1);
        (uint32 conf,, uint32 unadj,,,, ) = m.rep(seller);
        assertEq(conf, 0);
        assertEq(unadj, 1);
        (,,,,, uint32 silent, ) = m.rep(buyer);
        assertEq(silent, 1);
    }

    function test_expireCommit_slashesUnrevealed() public {
        uint256 cid = _post();
        uint256 sid = _commit(cid);
        vm.warp(block.timestamp + REVEAL + 1);
        uint256 before = buyer.balance;
        vm.prank(other);
        m.expireCommit(sid);
        assertEq(buyer.balance, before + m.bondFor(cid));
        assertEq(uint8(m.getSale(sid).state), uint8(RefutationMarket.SaleState.Withdrawn));
        assertEq(m.getClaim(cid).pending, 0);
        (,,, uint32 wd,,, ) = m.rep(seller);
        assertEq(wd, 1);
    }

    function test_withdrawSale_slashesUndisclosed() public {
        (uint256 cid, uint256 sid) = _revealedSale();
        _dispute(sid);
        vm.warp(block.timestamp + DISC + 1);
        uint256 before = buyer.balance;
        vm.prank(other);
        m.withdrawSale(sid);
        assertEq(buyer.balance, before + 2 * m.bondFor(cid));
        assertEq(uint8(m.getSale(sid).state), uint8(RefutationMarket.SaleState.Withdrawn));
        assertEq(m.getClaim(cid).pending, 0);
    }

    function test_closeClaim_refundsRemainder() public {
        (uint256 cid, uint256 sid) = _revealedSale();
        vm.prank(buyer);
        m.confirm(sid);
        vm.warp(block.timestamp + 1 hours);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        m.closeClaim(cid);
        assertEq(buyer.balance, before + BOUNTY * (MAX - 1));
        assertTrue(m.getClaim(cid).closed);
        assertEq(address(m).balance, 0);
    }

    function test_closeClaim_revertsWithPending() public {
        (uint256 cid, ) = _revealedSale();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(buyer);
        vm.expectRevert(RefutationMarket.ClaimHasPending.selector);
        m.closeClaim(cid);
    }

    // ---- cross-seam vector: the TypeScript test asserts the same constant ----
    function test_commitHash_matchesTypeScriptVector() public pure {
        bytes memory pt = hex"7b2261223a3132332c2262223a3435367d";
        bytes32 salt = 0x1111111111111111111111111111111111111111111111111111111111111111;
        assertEq(keccak256(abi.encode(uint256(1), pt, salt)), 0xe42ef964f458bf6a7f29035d0d681389f65fe8e1462a4346c7ee63f087a9f67f);
    }
```

- [ ] **Step 2: Run and see the new tests fail**

Run: `forge test 2>&1 | tail -5`
Expected: compile error, `settle` is not a member.

- [ ] **Step 3: Add the four functions**

Insert before `// ---------- internal ----------`:

```solidity
    // ---------- windows ----------
    function withdrawSale(uint256 saleId) external {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        _requireState(s, SaleState.Disputed);
        if (s.plaintext.length != 0) revert AlreadyDisclosed();
        if (block.timestamp <= s.disputedAt + disclosureWindow) revert WindowOpen();
        s.state = SaleState.Withdrawn;
        c.pending -= 1;
        rep[s.seller].sellerWithdrawn += 1;
        emit Withdrawn(saleId, s.claimId, "undisclosed");
        _pay(c.buyer, s.sellerBond + s.buyerBond);
    }

    function expireCommit(uint256 saleId) external {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        _requireState(s, SaleState.Committed);
        if (block.timestamp <= s.committedAt + revealWindow) revert WindowOpen();
        s.state = SaleState.Withdrawn;
        c.pending -= 1;
        rep[s.seller].sellerWithdrawn += 1;
        emit Withdrawn(saleId, s.claimId, "unrevealed");
        _pay(c.buyer, s.sellerBond);
    }

    function settle(uint256 saleId) external {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        _requireState(s, SaleState.Revealed);
        if (block.timestamp <= s.revealedAt + adjudicationWindow) revert WindowOpen();
        s.state = SaleState.Unadjudicated;
        c.hits += 1;
        c.pending -= 1;
        rep[s.seller].sellerUnadjudicated += 1;
        rep[c.buyer].buyerSilent += 1;
        emit Settled(saleId, s.claimId);
        _pay(s.seller, c.bounty + s.sellerBond);
    }

    function closeClaim(uint256 claimId) external {
        Claim storage c = _claims[claimId];
        if (msg.sender != c.buyer) revert NotBuyer();
        if (c.closed) revert ClaimNotOpen();
        if (block.timestamp < c.expiresAt) revert ClaimNotExpired();
        if (c.pending != 0) revert ClaimHasPending();
        c.closed = true;
        uint256 refund = c.bounty * (c.maxHits - c.hits);
        emit ClaimClosed(claimId, refund);
        if (refund > 0) _pay(c.buyer, refund);
    }
```

- [ ] **Step 4: Run, all pass**

Run: `forge test 2>&1 | tail -5`
Expected: 27 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src test && git commit -q -m "feat(market): silence settles to the seller as unadjudicated; expiry, withdrawal and close" && git log --oneline | head -1
```

---

### Task 4: Deploy script, ABI export, anvil dry run

**Files:**
- Create: `script/Deploy.s.sol`
- Create: `scripts/export-abi.sh`

**Interfaces:**
- Consumes: the complete contract.
- Produces: `docs/abi.json`, `agents/src/abi.json`, `docs/deployment.json` with keys `chainId, address, rpc, explorer, deployedBlock`.

- [ ] **Step 1: Write the deploy script**

```solidity
// script/Deploy.s.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {RefutationMarket} from "../src/RefutationMarket.sol";

contract Deploy is Script {
    function run() external {
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        uint64 revealWindow = uint64(vm.envOr("REVEAL_WINDOW", uint256(90)));
        uint64 adjudicationWindow = uint64(vm.envOr("ADJUDICATION_WINDOW", uint256(90)));
        uint64 disclosureWindow = uint64(vm.envOr("DISCLOSURE_WINDOW", uint256(90)));
        uint256 bondBps = vm.envOr("BOND_BPS", uint256(2000));
        vm.startBroadcast();
        RefutationMarket m = new RefutationMarket(arbiter, revealWindow, adjudicationWindow, disclosureWindow, bondBps);
        vm.stopBroadcast();
        console.log("MARKET_ADDRESS=%s", address(m));
    }
}
```

- [ ] **Step 2: Write the ABI export script**

```bash
#!/usr/bin/env bash
# scripts/export-abi.sh <address> <chainId> <deployedBlock>
# Copies the ABI beside the agents and the page, and writes docs/deployment.json.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
ADDR="${1:?address}"; CHAIN="${2:?chainId}"; BLOCK="${3:?deployedBlock}"
forge build >/dev/null
mkdir -p agents/src docs
python3 - "$ADDR" "$CHAIN" "$BLOCK" <<'PY'
import json, sys
addr, chain, block = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
art = json.load(open("out/RefutationMarket.sol/RefutationMarket.json"))
abi = art["abi"]
json.dump(abi, open("agents/src/abi.json", "w"), indent=1)
json.dump(abi, open("docs/abi.json", "w"), indent=1)
rpc = "https://sepolia.base.org" if chain == 84532 else "http://127.0.0.1:8545"
explorer = "https://sepolia.basescan.org" if chain == 84532 else ""
json.dump({"chainId": chain, "address": addr, "rpc": rpc, "explorer": explorer, "deployedBlock": block},
          open("docs/deployment.json", "w"), indent=1)
print("wrote agents/src/abi.json docs/abi.json docs/deployment.json")
PY
```
Then `chmod +x scripts/export-abi.sh`.

- [ ] **Step 3: Dry run on anvil**

```bash
cd ~/Documents/BlackBoxBazaar && export PATH="$HOME/.foundry/bin:$PATH"
(anvil --silent --port 8545 > /tmp/anvil.log 2>&1 &) ; sleep 2
ARBITER_ADDRESS=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast 2>&1 | grep -E 'MARKET_ADDRESS|ONCHAIN|Error'
```
Expected: a line `MARKET_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3` (the first address anvil's account 0 deploys to). Then:

```bash
./scripts/export-abi.sh 0x5FbDB2315678afecb367f032d93F642f64180aa3 31337 1 && cat docs/deployment.json
cast call 0x5FbDB2315678afecb367f032d93F642f64180aa3 "arbiter()(address)" --rpc-url http://127.0.0.1:8545
```
Expected: the arbiter address above. Leave anvil running for Task 6 and 7.

- [ ] **Step 4: Commit**

```bash
git add script scripts docs/abi.json agents/src/abi.json && git commit -q -m "feat(deploy): deploy script and ABI export" && git log --oneline | head -1
```
`docs/deployment.json` is committed later, once it points at Base Sepolia.

---

### Task 5: Agents library: config, chain, log, crypto, model

**Files:**
- Create: `agents/package.json`, `agents/tsconfig.json`
- Create: `agents/src/config.ts`, `agents/src/chain.ts`, `agents/src/log.ts`, `agents/src/crypto.ts`, `agents/src/model.ts`
- Test: `agents/test/crypto.test.ts`, `agents/test/model.test.ts`

**Interfaces:**
- Produces:
  - `config.ts`: `CHAIN`, `RPC_URL`, `MARKET_ADDRESS`, `EXPLORER`, `MODEL_ID`, `PROMPT(a,b)`, `LO`, `HI`, `BOUNTY_ETH`, `MAX_HITS`, `CLAIM_DURATION`, `BUYER_RUNS`, `BUYER_THRESHOLD`, `ARBITER_RUNS`, `ARBITER_THRESHOLD`, `CLAIM_SPEC`, `POLL_MS`, `type Role`, `keyFor(role): Hex`.
  - `chain.ts`: `clients(role) → { role, account, publicClient, walletClient, market }`, `send(publicClient, hashPromise) → receipt`, `txLink(hash)`, `STATE_NAMES`, `S` (state numbers), `sleep(ms)`.
  - `log.ts`: `logger(role) → (event: string, fields?: object) => void`.
  - `crypto.ts`: `boxKeypairFromEthKey(ethKey): nacl.BoxKeyPair`, `seal(envelope: Uint8Array, recipientPub: Uint8Array): Hex`, `open(ciphertext: Hex, recipientSecret: Uint8Array): Uint8Array | null`, `canonicalPair(a, b): string`, `parsePair(plaintext: Uint8Array): {a, b} | null`, `commitHash(claimId: bigint, plaintext: Hex, salt: Hex): Hex`, `randomSalt(): Hex`, `envelope(plaintext: Uint8Array, salt: Hex): Uint8Array`, `splitEnvelope(env: Uint8Array): {plaintext: Uint8Array, salt: Hex}`, re-exported `stringToBytes`.
  - `model.ts`: `parseInteger(text): bigint | null`, `askProduct(a, b): Promise<{text, parsed}>`, `modelIsWrong(a, b, runs, threshold): Promise<{wrong, runs, verdict, answers, truth}>`.

- [ ] **Step 1: Package files**

```json
// agents/package.json
{
  "name": "bazaar-agents",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test 'test/*.test.ts'",
    "buyer": "node --env-file=../.env src/buyer.ts",
    "seller": "node --env-file=../.env src/seller.ts",
    "arbiter": "node --env-file=../.env src/arbiter.ts",
    "sweep": "node --env-file=../.env src/sweep.ts",
    "wallets": "node --env-file=../.env src/wallets.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.60.0",
    "tweetnacl": "^1.0.3",
    "viem": "^2.30.0"
  }
}
```

```json
// agents/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "allowImportingTsExtensions": true, "noEmit": true,
    "resolveJsonModule": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true
  },
  "include": ["src", "test"]
}
```
Run: `cd ~/Documents/BlackBoxBazaar/agents && npm install 2>&1 | tail -2`. If a pinned version does not resolve, install the latest of that package instead and record the version in package.json.

- [ ] **Step 2: Failing tests for crypto and the parser**

```ts
// agents/test/crypto.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, stringToBytes } from "viem";
import nacl from "tweetnacl";
import { boxKeypairFromEthKey, seal, open, canonicalPair, parsePair, commitHash, randomSalt, envelope, splitEnvelope } from "../src/crypto.ts";

test("canonical pair has no whitespace and fixed key order", () => {
  assert.equal(canonicalPair(123, 456), '{"a":123,"b":456}');
  assert.deepEqual(parsePair(stringToBytes('{"a":123,"b":456}')), { a: 123, b: 456 });
  assert.equal(parsePair(stringToBytes("nonsense")), null);
});

test("commit hash matches the Solidity test vector", () => {
  const pt = bytesToHex(stringToBytes('{"a":123,"b":456}'));
  assert.equal(pt, "0x7b2261223a3132332c2262223a3435367d");
  const salt = ("0x" + "11".repeat(32)) as `0x${string}`;
  assert.equal(commitHash(1n, pt, salt), "0xe42ef964f458bf6a7f29035d0d681389f65fe8e1462a4346c7ee63f087a9f67f");
});

test("seal and open roundtrip an envelope of plaintext plus salt", () => {
  const buyer = boxKeypairFromEthKey(("0x" + "ab".repeat(32)) as `0x${string}`);
  const salt = randomSalt();
  const env = envelope(stringToBytes(canonicalPair(590, 877)), salt);
  const ct = seal(env, buyer.publicKey);
  const opened = open(ct, buyer.secretKey);
  assert.ok(opened);
  const { plaintext, salt: gotSalt } = splitEnvelope(opened!);
  assert.deepEqual(parsePair(plaintext), { a: 590, b: 877 });
  assert.equal(gotSalt, salt);
});

test("a different recipient cannot open", () => {
  const buyer = boxKeypairFromEthKey(("0x" + "ab".repeat(32)) as `0x${string}`);
  const stranger = nacl.box.keyPair();
  const ct = seal(envelope(stringToBytes(canonicalPair(1, 2)), randomSalt()), buyer.publicKey);
  assert.equal(open(ct, stranger.secretKey), null);
});

test("keypair from eth key is deterministic", () => {
  const k = ("0x" + "cd".repeat(32)) as `0x${string}`;
  assert.deepEqual(boxKeypairFromEthKey(k).publicKey, boxKeypairFromEthKey(k).publicKey);
});
```

```ts
// agents/test/model.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInteger } from "../src/model.ts";

test("parser accepts bare, comma-grouped and sentence-wrapped integers", () => {
  assert.equal(parseInteger("517430"), 517430n);
  assert.equal(parseInteger("517,430"), 517430n);
  assert.equal(parseInteger("The answer is 517430."), 517430n);
  assert.equal(parseInteger("590 × 877 = 517430"), 517430n);
});

test("parser returns null when there is no integer", () => {
  assert.equal(parseInteger("I cannot help with that."), null);
});
```
The fourth parser case matters: when the model echoes the problem, the answer is the last integer, not the first.

Run: `npm test 2>&1 | tail -3`. Expected: fails, modules missing.

- [ ] **Step 3: Implement config, log, chain**

```ts
// agents/src/config.ts
import { baseSepolia, foundry } from "viem/chains";
import type { Hex } from "viem";

export const CHAIN = process.env.CHAIN === "base-sepolia" ? baseSepolia : foundry;
export const RPC_URL = process.env.RPC_URL ?? (CHAIN.id === 84532 ? "https://sepolia.base.org" : "http://127.0.0.1:8545");
export const EXPLORER = CHAIN.id === 84532 ? "https://sepolia.basescan.org" : "";
export const MARKET_ADDRESS = (process.env.MARKET_ADDRESS ?? "") as Hex;

export const MODEL_ID = "claude-haiku-4-5-20251001";
export const PROMPT = (a: number, b: number) => `What is ${a} × ${b}? Reply with only the integer.`;
export const LO = 100;
export const HI = 999;
export const BOUNTY_ETH = process.env.BOUNTY_ETH ?? "0.0005";
export const MAX_HITS = Number(process.env.MAX_HITS ?? 3);
export const CLAIM_DURATION = Number(process.env.CLAIM_DURATION ?? 3600);
export const BUYER_RUNS = 3;
export const BUYER_THRESHOLD = 2;
export const ARBITER_RUNS = 5;
export const ARBITER_THRESHOLD = 3;
export const POLL_MS = Number(process.env.POLL_MS ?? 3000);

export const CLAIM_SPEC =
  `Claim: ${MODEL_ID} at temperature 0 multiplies two three-digit integers (100..999) correctly. ` +
  `Test: prompt "What is {a} × {b}? Reply with only the integer." and parse the last integer in the reply. ` +
  `A counterexample is a pair {"a","b"} where the parsed integer differs from a*b in at least ${BUYER_THRESHOLD} of ${BUYER_RUNS} runs. ` +
  `Disputes are re-run ${ARBITER_RUNS} times and upheld at ${ARBITER_THRESHOLD}.`;

export type Role = "deployer" | "buyer" | "seller" | "rogue" | "newcomer" | "arbiter";

const ANVIL_KEYS: Record<Role, Hex> = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  buyer:    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller:   "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  rogue:    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  newcomer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  arbiter:  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};

export function keyFor(role: Role): Hex {
  const env = process.env[`${role.toUpperCase()}_KEY`];
  if (env) return env as Hex;
  if (CHAIN.id === foundry.id) return ANVIL_KEYS[role];
  throw new Error(`${role.toUpperCase()}_KEY is not set and chain is not anvil`);
}
```

```ts
// agents/src/log.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(here, "..", "..", "demo", "logs");

export function logger(role: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  const file = join(LOG_DIR, `${role}.log`);
  return (event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), role, event, ...fields },
      (_, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(line);
    appendFileSync(file, line + "\n");
  };
}
```

```ts
// agents/src/chain.ts
import { createPublicClient, createWalletClient, getContract, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import abi from "./abi.json" with { type: "json" };
import { CHAIN, EXPLORER, MARKET_ADDRESS, RPC_URL, keyFor, type Role } from "./config.ts";

export const STATE_NAMES = ["Committed", "Revealed", "Confirmed", "Disputed", "Refuted", "Upheld", "Unadjudicated", "Withdrawn"] as const;
export const S = { Committed: 0, Revealed: 1, Confirmed: 2, Disputed: 3, Refuted: 4, Upheld: 5, Unadjudicated: 6, Withdrawn: 7 } as const;

export function clients(role: Role) {
  if (!MARKET_ADDRESS) throw new Error("MARKET_ADDRESS is not set");
  const account = privateKeyToAccount(keyFor(role));
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) });
  const market = getContract({ address: MARKET_ADDRESS, abi, client: { public: publicClient, wallet: walletClient } });
  return { role, account, publicClient, walletClient, market };
}

export async function send(publicClient: PublicClient, hashPromise: Promise<Hex>) {
  const hash = await hashPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
  return receipt;
}

export function txLink(hash: Hex) {
  return EXPLORER ? `${EXPLORER}/tx/${hash}` : hash;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

- [ ] **Step 4: Implement crypto and model**

```ts
// agents/src/crypto.ts
import nacl from "tweetnacl";
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, sha256, stringToBytes, type Hex } from "viem";

export function boxKeypairFromEthKey(ethKey: Hex): nacl.BoxKeyPair {
  return nacl.box.keyPair.fromSecretKey(hexToBytes(sha256(ethKey)));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function seal(env: Uint8Array, recipientPub: Uint8Array): Hex {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(env, nonce, recipientPub, eph.secretKey);
  return bytesToHex(concatBytes(eph.publicKey, nonce, boxed));
}

export function open(ciphertext: Hex, recipientSecret: Uint8Array): Uint8Array | null {
  const b = hexToBytes(ciphertext);
  if (b.length < 32 + 24 + 16) return null;
  const ephPub = b.slice(0, 32);
  const nonce = b.slice(32, 56);
  const boxed = b.slice(56);
  return nacl.box.open(boxed, nonce, ephPub, recipientSecret);
}

export function canonicalPair(a: number, b: number): string {
  return JSON.stringify({ a, b });
}

export function parsePair(plaintext: Uint8Array): { a: number; b: number } | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(plaintext));
    if (Number.isInteger(o.a) && Number.isInteger(o.b)) return { a: o.a, b: o.b };
    return null;
  } catch { return null; }
}

export function commitHash(claimId: bigint, plaintext: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }, { type: "bytes32" }],
    [claimId, plaintext, salt],
  ));
}

export function randomSalt(): Hex {
  return bytesToHex(nacl.randomBytes(32));
}

export function envelope(plaintext: Uint8Array, salt: Hex): Uint8Array {
  return concatBytes(plaintext, hexToBytes(salt));
}

export function splitEnvelope(env: Uint8Array): { plaintext: Uint8Array; salt: Hex } {
  return { plaintext: env.slice(0, env.length - 32), salt: bytesToHex(env.slice(env.length - 32)) };
}

export { stringToBytes };
```

```ts
// agents/src/model.ts
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_ID, PROMPT } from "./config.ts";

let client: Anthropic | null = null;
function api() { return (client ??= new Anthropic()); }

export function parseInteger(text: string): bigint | null {
  const matches = text.replace(/,/g, "").match(/-?\d+/g);
  if (!matches) return null;
  return BigInt(matches[matches.length - 1]);
}

export async function askProduct(a: number, b: number): Promise<{ text: string; parsed: bigint | null }> {
  const res = await api().messages.create({
    model: MODEL_ID, max_tokens: 32, temperature: 0,
    messages: [{ role: "user", content: PROMPT(a, b) }],
  });
  const block = res.content[0];
  const text = block && block.type === "text" ? block.text : "";
  return { text, parsed: parseInteger(text) };
}

export async function modelIsWrong(a: number, b: number, runs: number, threshold: number) {
  const truth = BigInt(a) * BigInt(b);
  const answers: string[] = [];
  let wrong = 0;
  for (let i = 0; i < runs; i++) {
    const { text, parsed } = await askProduct(a, b);
    answers.push(text.trim());
    if (parsed === null || parsed !== truth) wrong++;
  }
  return { wrong, runs, verdict: wrong >= threshold, answers, truth: truth.toString() };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/Documents/BlackBoxBazaar/agents && npm test 2>&1 | tail -6`
Expected: 7 tests pass. If Node refuses `.ts` imports, add `--experimental-strip-types` to the `test` script and every `node` script.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/BlackBoxBazaar && git add agents/package.json agents/package-lock.json agents/tsconfig.json agents/src agents/test && git commit -q -m "feat(agents): chain clients, sealed envelopes, commit hash across the seam, model verdicts" && git log --oneline | head -1
```

---

### Task 6: Agent roles: buyer, seller, arbiter, sweep, and a local three-scene run

**Files:**
- Create: `agents/src/buyer.ts`, `agents/src/seller.ts`, `agents/src/arbiter.ts`, `agents/src/sweep.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: CLI entry points used by `demo/scenes.sh`:
  - `buyer.ts post` prints `CLAIM_ID=<n>`; `buyer.ts watch [--silent] [--claim N] [--seconds S]`
  - `seller.ts hunt --claim N [--max K] [--rogue] [--role seller|rogue|newcomer] [--seconds S]`
  - `arbiter.ts watch [--seconds S]`
  - `sweep.ts [--seconds S]`
  All watchers exit after `--seconds` (default 600).

- [ ] **Step 1: A tiny argument helper, shared by inlining**

Each script includes this at the top rather than importing a fourth module:

```ts
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
```

- [ ] **Step 2: Buyer**

```ts
// agents/src/buyer.ts
import { bytesToHex, decodeEventLog, parseEther, type Hex } from "viem";
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { BOUNTY_ETH, BUYER_RUNS, BUYER_THRESHOLD, CLAIM_DURATION, CLAIM_SPEC, MAX_HITS, MODEL_ID, POLL_MS, keyFor } from "./config.ts";
import { boxKeypairFromEthKey, commitHash, open, parsePair, splitEnvelope } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";
import abi from "./abi.json" with { type: "json" };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

const log = logger("buyer");
const { account, publicClient, market } = clients("buyer");
const box = boxKeypairFromEthKey(keyFor("buyer"));

async function post() {
  const bounty = parseEther(BOUNTY_ETH);
  const value = bounty * BigInt(MAX_HITS);
  log("posting claim", { model: MODEL_ID, bounty: BOUNTY_ETH, maxHits: MAX_HITS });
  const receipt = await send(publicClient, market.write.postClaim(
    [MODEL_ID, CLAIM_SPEC, bytesToHex(box.publicKey), bounty, MAX_HITS, BigInt(CLAIM_DURATION)], { value }));
  let claimId = -1n;
  for (const l of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
      if (ev.eventName === "ClaimPosted") claimId = (ev.args as any).claimId;
    } catch {}
  }
  log("claim posted", { claimId, tx: txLink(receipt.transactionHash) });
  console.log(`CLAIM_ID=${claimId}`);
}

async function adjudicate(saleId: bigint, claimId: bigint, ciphertext: Hex, commit: Hex) {
  const env = open(ciphertext, box.secretKey);
  if (!env) { log("cannot decrypt, disputing", { saleId }); return dispute(saleId, claimId); }
  const { plaintext, salt } = splitEnvelope(env);
  const pair = parsePair(plaintext);
  const ok = commitHash(claimId, bytesToHex(plaintext), salt) === commit;
  if (!pair || !ok) { log("envelope fails commit check, disputing", { saleId, pair, ok }); return dispute(saleId, claimId); }
  log("re-running", { saleId, a: pair.a, b: pair.b, runs: BUYER_RUNS });
  const r = await modelIsWrong(pair.a, pair.b, BUYER_RUNS, BUYER_THRESHOLD);
  log("re-run result", { saleId, wrong: r.wrong, runs: r.runs, truth: r.truth, answers: r.answers });
  if (r.verdict) {
    const receipt = await send(publicClient, market.write.confirm([saleId]));
    log("confirmed", { saleId, tx: txLink(receipt.transactionHash) });
  } else {
    await dispute(saleId, claimId);
  }
}

async function dispute(saleId: bigint, claimId: bigint) {
  const bond = await market.read.bondFor([claimId]) as bigint;
  const receipt = await send(publicClient, market.write.dispute([saleId], { value: bond }));
  log("disputed", { saleId, bond, tx: txLink(receipt.transactionHash) });
}

async function watch() {
  const silent = flag("silent");
  const only = opt("claim", "");
  const seconds = Number(opt("seconds", "600"));
  const seen = new Set<string>();
  const until = Date.now() + seconds * 1000;
  log("watching", { silent, only: only || "all", seconds });
  while (Date.now() < until) {
    const n = Number(await market.read.saleCount());
    for (let i = 0; i < n; i++) {
      const s = await market.read.getSale([BigInt(i)]) as any;
      const c = await market.read.getClaim([s.claimId]) as any;
      if (c.buyer.toLowerCase() !== account.address.toLowerCase()) continue;
      if (only && s.claimId.toString() !== only) continue;
      if (s.state !== S.Revealed || seen.has(String(i))) continue;
      seen.add(String(i));
      if (silent) { log("reveal seen, staying silent on purpose", { saleId: i }); continue; }
      await adjudicate(BigInt(i), s.claimId, s.ciphertext, s.commitHash);
    }
    await sleep(POLL_MS);
  }
  log("watch ended");
}

const cmd = args[0];
if (cmd === "post") await post();
else if (cmd === "watch") await watch();
else { console.error("usage: buyer.ts post | watch [--silent] [--claim N] [--seconds S]"); process.exit(2); }
```

- [ ] **Step 3: Seller**

```ts
// agents/src/seller.ts
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { BUYER_RUNS, BUYER_THRESHOLD, HI, LO, POLL_MS, type Role } from "./config.ts";
import { canonicalPair, commitHash, envelope, randomSalt, seal, stringToBytes } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

const role = opt("role", flag("rogue") ? "rogue" : "seller") as Role;
const log = logger(role);
const { publicClient, market } = clients(role);
const rogue = flag("rogue");
const rnd = () => LO + Math.floor(Math.random() * (HI - LO + 1));

// plaintext and salt per sale, so a dispute can be answered
const memory = new Map<string, { plaintext: Hex; salt: Hex }>();

async function findPair() {
  for (let tries = 1; ; tries++) {
    const a = rnd(), b = rnd();
    const r = await modelIsWrong(a, b, BUYER_RUNS, BUYER_THRESHOLD);
    log("probe", { a, b, wrong: r.wrong, runs: r.runs, truth: r.truth, answers: r.answers, tries });
    if (rogue && r.wrong === 0) { log("rogue: planting a pair the model gets right", { a, b }); return { a, b }; }
    if (!rogue && r.verdict) { log("counterexample found", { a, b, tries }); return { a, b }; }
  }
}

async function sellOne(claimId: bigint) {
  const claim = await market.read.getClaim([claimId]) as any;
  const { a, b } = await findPair();
  const plaintext = bytesToHex(stringToBytes(canonicalPair(a, b)));
  const salt = randomSalt();
  const hash = commitHash(claimId, plaintext, salt);
  const bond = await market.read.bondFor([claimId]) as bigint;
  const rc = await send(publicClient, market.write.commit([claimId, hash], { value: bond }));
  const saleId = BigInt(Number(await market.read.saleCount()) - 1);
  memory.set(saleId.toString(), { plaintext, salt });
  log("committed", { saleId, claimId, hash, bond, tx: txLink(rc.transactionHash) });
  const ct = seal(envelope(hexToBytes(plaintext), salt), hexToBytes(claim.buyerPubKey));
  const rr = await send(publicClient, market.write.reveal([saleId, ct]));
  log("revealed", { saleId, bytes: hexToBytes(ct).length, tx: txLink(rr.transactionHash) });
  return saleId;
}

async function answerDisputes() {
  const n = Number(await market.read.saleCount());
  for (let i = 0; i < n; i++) {
    const m = memory.get(String(i));
    if (!m) continue;
    const s = await market.read.getSale([BigInt(i)]) as any;
    if (s.state === S.Disputed && (s.plaintext as string) === "0x") {
      const rc = await send(publicClient, market.write.disclose([BigInt(i), m.plaintext, m.salt]));
      log("disputed by buyer, disclosed plaintext on-chain", { saleId: i, tx: txLink(rc.transactionHash) });
    }
  }
}

async function hunt() {
  const claimId = BigInt(opt("claim", "0"));
  const max = Number(opt("max", "1"));
  const seconds = Number(opt("seconds", "600"));
  log("hunting", { claimId, max, rogue });
  let sold = 0;
  while (sold < max) {
    const c = await market.read.getClaim([claimId]) as any;
    if (c.closed || c.hits + c.pending >= c.maxHits) { log("claim has no open slot", { claimId }); break; }
    await sellOne(claimId);
    sold++;
  }
  const until = Date.now() + seconds * 1000;
  log("watching for disputes", { seconds });
  while (Date.now() < until) { await answerDisputes(); await sleep(POLL_MS); }
  log("done");
}

if (args[0] === "hunt") await hunt();
else { console.error("usage: seller.ts hunt --claim N [--max K] [--rogue] [--role r] [--seconds S]"); process.exit(2); }
```

- [ ] **Step 4: Arbiter and sweep**

```ts
// agents/src/arbiter.ts
import { hexToBytes } from "viem";
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { ARBITER_RUNS, ARBITER_THRESHOLD, POLL_MS } from "./config.ts";
import { parsePair } from "./crypto.ts";
import { logger } from "./log.ts";
import { modelIsWrong } from "./model.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = logger("arbiter");
const { publicClient, market } = clients("arbiter");

async function watch() {
  const seconds = Number(opt("seconds", "600"));
  const until = Date.now() + seconds * 1000;
  const seen = new Set<number>();
  log("watching for disclosed disputes", { seconds });
  while (Date.now() < until) {
    const n = Number(await market.read.saleCount());
    for (let i = 0; i < n; i++) {
      if (seen.has(i)) continue;
      const s = await market.read.getSale([BigInt(i)]) as any;
      if (s.state !== S.Disputed || (s.plaintext as string) === "0x") continue;
      seen.add(i);
      const pair = parsePair(hexToBytes(s.plaintext));
      if (!pair) {
        const rc = await send(publicClient, market.write.rule([BigInt(i), false]));
        log("ruled: plaintext is not a pair, seller refuted", { saleId: i, tx: txLink(rc.transactionHash) });
        continue;
      }
      log("re-running disputed pair", { saleId: i, a: pair.a, b: pair.b, runs: ARBITER_RUNS });
      const r = await modelIsWrong(pair.a, pair.b, ARBITER_RUNS, ARBITER_THRESHOLD);
      const rc = await send(publicClient, market.write.rule([BigInt(i), r.verdict]));
      log(r.verdict ? "ruled: model is wrong, seller upheld" : "ruled: model is right, seller refuted",
        { saleId: i, wrong: r.wrong, runs: r.runs, truth: r.truth, answers: r.answers, tx: txLink(rc.transactionHash) });
    }
    await sleep(POLL_MS);
  }
  log("watch ended");
}

if (args[0] === "watch") await watch();
else { console.error("usage: arbiter.ts watch [--seconds S]"); process.exit(2); }
```

```ts
// agents/src/sweep.ts
// Anyone may call these. The demo runs it from the arbiter wallet for convenience.
import { S, clients, send, sleep, txLink } from "./chain.ts";
import { POLL_MS } from "./config.ts";
import { logger } from "./log.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const log = logger("sweep");
const { publicClient, market } = clients("arbiter");

async function once() {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [rw, aw, dw] = await Promise.all([market.read.revealWindow(), market.read.adjudicationWindow(), market.read.disclosureWindow()]) as bigint[];
  const n = Number(await market.read.saleCount());
  for (let i = 0; i < n; i++) {
    const s = await market.read.getSale([BigInt(i)]) as any;
    try {
      if (s.state === S.Revealed && now > BigInt(s.revealedAt) + aw) {
        const rc = await send(publicClient, market.write.settle([BigInt(i)]));
        log("settled: buyer silent past the window, seller paid, recorded unadjudicated", { saleId: i, tx: txLink(rc.transactionHash) });
      } else if (s.state === S.Committed && now > BigInt(s.committedAt) + rw) {
        const rc = await send(publicClient, market.write.expireCommit([BigInt(i)]));
        log("expired: commit never revealed, bond to buyer", { saleId: i, tx: txLink(rc.transactionHash) });
      } else if (s.state === S.Disputed && (s.plaintext as string) === "0x" && now > BigInt(s.disputedAt) + dw) {
        const rc = await send(publicClient, market.write.withdrawSale([BigInt(i)]));
        log("withdrawn: seller never disclosed, bond to buyer", { saleId: i, tx: txLink(rc.transactionHash) });
      }
    } catch (e) { log("sweep call failed", { saleId: i, error: String(e).slice(0, 200) }); }
  }
}

const seconds = Number(opt("seconds", "0"));
const until = Date.now() + seconds * 1000;
do { await once(); if (seconds) await sleep(POLL_MS); } while (Date.now() < until);
```

- [ ] **Step 5: Local three-scene run on anvil**

With anvil from Task 4 still running and `MARKET_ADDRESS` exported from its deploy output:

```bash
cd ~/Documents/BlackBoxBazaar/agents && export MARKET_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3 CHAIN=anvil
rm -rf ../demo/logs
# scene 1: honest
npm run -s buyer -- post                    # prints CLAIM_ID=0
npm run -s seller -- hunt --claim 0 --max 1 --seconds 5
npm run -s buyer -- watch --claim 0 --seconds 15
# scene 2: rogue
npm run -s seller -- hunt --claim 0 --max 1 --rogue --seconds 40 &
sleep 25; npm run -s buyer -- watch --claim 0 --seconds 15
npm run -s arbiter -- watch --seconds 20
wait
# scene 3: silent buyer, newcomer seller
npm run -s buyer -- post                    # prints CLAIM_ID=1
npm run -s seller -- hunt --claim 1 --max 1 --role newcomer --seconds 5
npm run -s buyer -- watch --claim 1 --silent --seconds 5
cast rpc evm_increaseTime 100 --rpc-url http://127.0.0.1:8545 >/dev/null && cast rpc evm_mine --rpc-url http://127.0.0.1:8545 >/dev/null
npm run -s sweep
```
Expected in the logs: `confirmed` for sale 0; `disputed` then `disclosed` then `ruled: model is right, seller refuted` for sale 1; `settled` for sale 2. Check counters:

```bash
cast call $MARKET_ADDRESS "rep(address)(uint32,uint32,uint32,uint32,uint32,uint32,uint32)" 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --rpc-url http://127.0.0.1:8545   # seller: 1 0 0 0 ...
cast call $MARKET_ADDRESS "rep(address)(uint32,uint32,uint32,uint32,uint32,uint32,uint32)" 0x90F79bf6EB2c4f870365E785982E1f101E93b906 --rpc-url http://127.0.0.1:8545   # rogue: 0 1 0 0 ...
cast call $MARKET_ADDRESS "rep(address)(uint32,uint32,uint32,uint32,uint32,uint32,uint32)" 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 --rpc-url http://127.0.0.1:8545   # newcomer: 0 0 1 0 ...
```
If the rogue scene rules "seller upheld", the planted pair was one the model gets wrong in the arbiter's 5 runs but right in the seller's 3; rerun scene 2. Note this in README as the nondeterminism limitation if it happens more than once in ten.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/BlackBoxBazaar && git add agents/src && git commit -q -m "feat(agents): buyer, seller, arbiter and sweep, three scenes pass on anvil" && git log --oneline | head -1
```

---

### Task 7: The page

**Files:**
- Create: `docs/index.html`, `docs/app.js`

**Interfaces:**
- Consumes: `docs/deployment.json` and `docs/abi.json` from Task 4 (shape fixed there).
- Produces: a static page that renders claims, sales and reputation from chain state alone.

- [ ] **Step 1: index.html**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Black Box Bazaar</title>
<style>
  :root { --bg:#0b0d10; --panel:#12161b; --line:#232a32; --text:#e6e9ec; --muted:#8a94a0; --ok:#3ddc97; --bad:#ff6b6b; --warn:#ffc857; --unk:#8a94a0; --link:#7ab8ff; }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }
  header { padding:22px 28px 10px; border-bottom:1px solid var(--line) }
  h1 { margin:0; font-size:20px; letter-spacing:.2px }
  h1 small { color:var(--muted); font-weight:400; margin-left:10px }
  .thesis { color:var(--muted); margin:6px 0 0 }
  main { display:grid; grid-template-columns: 1.1fr 1.6fr .9fr; gap:16px; padding:16px 28px 40px }
  section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; min-height:120px }
  h2 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.8px; color:var(--muted) }
  .card { border:1px solid var(--line); border-radius:6px; padding:10px 12px; margin-bottom:10px }
  .row { display:flex; justify-content:space-between; gap:10px; align-items:baseline }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px }
  .muted { color:var(--muted) }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; letter-spacing:.3px; border:1px solid var(--line) }
  .Committed { color:var(--warn) } .Revealed { color:var(--link) } .Confirmed { color:var(--ok) } .Upheld { color:var(--ok) }
  .Disputed { color:var(--warn) } .Refuted { color:var(--bad) } .Withdrawn { color:var(--bad) } .Unadjudicated { color:var(--unk) }
  .head { font-size:22px; font-weight:700 }
  .head.ok { color:var(--ok) } .head.bad { color:var(--bad) } .head.unk { color:var(--unk) }
  .triple { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-top:6px }
  .triple div { background:var(--bg); border-radius:4px; padding:6px 8px }
  .triple b { display:block; font-size:16px }
  a { color:var(--link); text-decoration:none } a:hover { text-decoration:underline }
  .ct { word-break:break-all; color:var(--muted); font-size:11px; max-height:38px; overflow:hidden }
  footer { padding:0 28px 30px; color:var(--muted); font-size:12px }
  @media (max-width: 1100px) { main { grid-template-columns:1fr } }
</style>
</head>
<body>
<header>
  <h1>Black Box Bazaar <small>a market of refutations</small></h1>
  <p class="thesis">Buyers escrow bounties for counterexamples to a claim about a pinned model. Sellers reveal them encrypted. A sale counts only once it is adjudicated. <b>Silence is not evidence.</b></p>
  <p class="mono muted" id="meta">loading deployment…</p>
</header>
<main>
  <section><h2>Claims</h2><div id="claims"></div></section>
  <section><h2>Sales</h2><div id="sales"></div></section>
  <section><h2>Reputation</h2><div id="rep"></div></section>
</main>
<footer id="foot"></footer>
<script type="module" src="./app.js"></script>
</body>
</html>
```

- [ ] **Step 2: app.js**

```js
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
```

- [ ] **Step 3: Serve locally against anvil and check by eye**

```bash
cd ~/Documents/BlackBoxBazaar/docs && python3 -m http.server 8080 >/dev/null 2>&1 &
```
Open `http://localhost:8080` in the Browser pane. Expected: two claims, three sales with states Confirmed, Refuted, Unadjudicated; the honest seller reads "1 confirmed", the rogue reads "unknown" with 1 refuted, the newcomer reads "unknown" with 1 unadjudicated; the buyer shows 2 adjudicated, 1 silent. Take a screenshot for the record.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/BlackBoxBazaar && git add docs/index.html docs/app.js && git commit -q -m "feat(page): claims, sales and three-number reputation with the unknown rule" && git log --oneline | head -1
```

---

### Task 8: Wallets, Base Sepolia deploy, GitHub Pages

**Files:**
- Create: `agents/src/wallets.ts`
- Modify: `.env` (never committed)
- Create: `docs/deployment.json` (committed now, pointing at Base Sepolia)

**Interfaces:**
- Consumes: a deployer wallet funded by the human from a faucet, given as `DEPLOYER_KEY` in `.env`.
- Produces: `BUYER_KEY, SELLER_KEY, ROGUE_KEY, NEWCOMER_KEY, ARBITER_KEY, ARBITER_ADDRESS, MARKET_ADDRESS, CHAIN=base-sepolia` in `.env`; the contract on Base Sepolia; the page live.

- [ ] **Step 1: wallets.ts**

```ts
// agents/src/wallets.ts
// `gen` appends new role keys to .env. `fund` sends each role ETH from the deployer. `balances` prints balances.
import { appendFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN, RPC_URL, keyFor } from "./config.ts";

const roles = ["buyer", "seller", "rogue", "newcomer", "arbiter"] as const;
const cmd = process.argv[2];

if (cmd === "gen") {
  const keys = roles.map(r => [r, generatePrivateKey()] as const);
  const lines = keys.map(([r, k]) => `${r.toUpperCase()}_KEY=${k}`);
  lines.push(`ARBITER_ADDRESS=${privateKeyToAccount(keys[4][1]).address}`);
  appendFileSync(new URL("../../.env", import.meta.url), lines.join("\n") + "\n");
  console.log("appended 6 lines to .env; addresses:");
  for (const [r, k] of keys) console.log(r, privateKeyToAccount(k).address);
} else if (cmd === "fund") {
  const amount = parseEther(process.argv[3] ?? "0.01");
  const account = privateKeyToAccount(keyFor("deployer"));
  const pub = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) });
  for (const r of roles) {
    const to = privateKeyToAccount(keyFor(r)).address;
    const hash = await wallet.sendTransaction({ to, value: amount });
    await pub.waitForTransactionReceipt({ hash });
    console.log(r, to, "funded", hash);
  }
} else if (cmd === "balances") {
  const pub = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
  for (const r of ["deployer", ...roles] as const) {
    const a = privateKeyToAccount(keyFor(r)).address;
    console.log(r, a, (Number(await pub.getBalance({ address: a })) / 1e18).toFixed(5), "ETH");
  }
} else { console.error("usage: wallets.ts gen | fund [eth] | balances"); process.exit(2); }
```
Note: `keyFor` reads `.env` only because the npm scripts pass `--env-file=../.env`; run `gen` once, then the file has the keys.

- [ ] **Step 2: The human step, and funding**

`.env` must contain `DEPLOYER_KEY=0x…` for a wallet holding Base Sepolia ETH (0.1 ETH is plenty). Then:

```bash
cd ~/Documents/BlackBoxBazaar/agents
printf 'CHAIN=base-sepolia\n' >> ../.env
npm run -s wallets -- gen
npm run -s wallets -- fund 0.01
npm run -s wallets -- balances
```
Expected: six addresses each holding 0.01 ETH, deployer holding the remainder.

- [ ] **Step 3: Deploy to Base Sepolia**

```bash
cd ~/Documents/BlackBoxBazaar && export PATH="$HOME/.foundry/bin:$PATH" && set -a && . ./.env && set +a
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --private-key "$DEPLOYER_KEY" --broadcast 2>&1 | grep -E 'MARKET_ADDRESS|Error|hash'
```
Take `MARKET_ADDRESS` and the deploy block from `broadcast/Deploy.s.sol/84532/run-latest.json` (`.receipts[0].blockNumber`). Then:

```bash
printf 'MARKET_ADDRESS=%s\n' 0xTHEADDRESS >> .env
./scripts/export-abi.sh 0xTHEADDRESS 84532 THEBLOCK
cast call 0xTHEADDRESS "arbiter()(address)" --rpc-url https://sepolia.base.org
```
Expected: the arbiter address from `.env`. Optional verification, only if an Etherscan key exists: `forge verify-contract 0xTHEADDRESS src/RefutationMarket.sol:RefutationMarket --chain base-sepolia --constructor-args $(cast abi-encode "c(address,uint64,uint64,uint64,uint256)" $ARBITER_ADDRESS 90 90 90 2000)`. Otherwise try Sourcify: add `--verifier sourcify`. Not a blocker.

- [ ] **Step 4: Enable GitHub Pages from docs/ and publish**

```bash
cd ~/Documents/BlackBoxBazaar && git add agents/src/wallets.ts docs/deployment.json && git commit -q -m "feat(deploy): RefutationMarket on Base Sepolia, page points at it" && git push -q
gh api -X POST repos/LeavesJ/black-box-bazaar/pages -f 'source[branch]=main' -f 'source[path]=/docs' 2>&1 | grep -oE '"html_url":"[^"]+"' || gh api repos/LeavesJ/black-box-bazaar/pages | grep -oE '"html_url":"[^"]+"'
```
Expected: `https://leavesj.github.io/black-box-bazaar/`. Poll it until it serves the page (a minute or two). Open it in the Browser pane and confirm it shows the contract address and "No claims yet."

---

### Task 9: Orchestrator and the three scenes on Base Sepolia

**Files:**
- Create: `demo/scenes.sh`

**Interfaces:**
- Produces: `demo/scene.txt` (current caption, one line, `END` when finished) and `demo/timeline.json` (array of `{scene, caption, t}` with epoch seconds), consumed by `demo/record.mjs` and `demo/narrate.sh`.

- [ ] **Step 1: scenes.sh**

```bash
#!/usr/bin/env bash
# demo/scenes.sh — runs the three scenes against whatever .env points at.
set -euo pipefail
cd "$(dirname "$0")/.."
A=agents
rm -rf demo/logs; mkdir -p demo/logs
: > demo/timeline.json; echo "[" >> demo/timeline.json
first=1
scene() { # scene <n> <caption>
  local n="$1"; shift; local cap="$*"
  echo "$cap" > demo/scene.txt
  [ $first -eq 1 ] || echo "," >> demo/timeline.json; first=0
  printf '{"scene":%d,"caption":%s,"t":%d}' "$n" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$cap")" "$(date +%s)" >> demo/timeline.json
  echo "== scene $n: $cap"
}
run() { (cd $A && npm run -s "$@"); }
claim_id() { grep -oE 'CLAIM_ID=[0-9]+' | cut -d= -f2; }

scene 1 "Scene 1 · An honest sale. The buyer posts a claim about Haiku 4.5 and escrows three bounties."
C0=$(run buyer -- post | tee /dev/stderr | claim_id)
scene 1 "Scene 1 · The seller hunts for a pair the model multiplies wrong, commits a hash, then reveals it encrypted to the buyer."
run seller -- hunt --claim "$C0" --max 1 --seconds 1
scene 1 "Scene 1 · The buyer decrypts, checks the commitment, re-runs the model three times, and confirms. Seller paid."
run buyer -- watch --claim "$C0" --seconds 45

scene 2 "Scene 2 · A rogue seller plants a pair the model gets RIGHT and sells it as a counterexample."
run seller -- hunt --claim "$C0" --max 1 --rogue --seconds 200 &
ROGUE=$!
sleep 20
scene 2 "Scene 2 · The buyer re-runs, sees the model is right, and disputes with a bond. The rogue must disclose the plaintext on-chain."
run buyer -- watch --claim "$C0" --seconds 60
scene 2 "Scene 2 · The arbiter re-runs five times and rules. The rogue is refuted: bond slashed, counterexample now public."
run arbiter -- watch --seconds 90
wait $ROGUE || true

scene 3 "Scene 3 · A silent buyer. A second claim, a newcomer seller with no history, and a buyer that never adjudicates."
C1=$(run buyer -- post | tee /dev/stderr | claim_id)
run seller -- hunt --claim "$C1" --max 1 --role newcomer --seconds 1
run buyer -- watch --claim "$C1" --silent --seconds 5
scene 3 "Scene 3 · Ninety seconds pass. Anyone may settle: the seller is paid, but the sale is recorded as UNADJUDICATED and the buyer as silent."
sleep 95
run sweep
scene 3 "Scene 3 · The newcomer's headline reads UNKNOWN. Money followed the default; reputation did not. Silence is not evidence."
sleep 12
echo "]" >> demo/timeline.json
echo "END" > demo/scene.txt
echo "done: claims $C0 $C1"
```
`chmod +x demo/scenes.sh`.

- [ ] **Step 2: Run it once on Base Sepolia without recording**

```bash
cd ~/Documents/BlackBoxBazaar && ./demo/scenes.sh 2>&1 | tee demo/logs/scenes.out | grep -E '^==|CLAIM_ID|confirmed|disputed|disclosed|ruled|settled|error'
```
Expected: the same three outcomes as on anvil, each with a Basescan link in the logs. Open the Pages URL and confirm the page reflects them. If the public RPC rate-limits, set `POLL_MS=6000` in `.env` and rerun.

- [ ] **Step 3: Commit**

```bash
git add demo/scenes.sh && git commit -q -m "feat(demo): three scenes, orchestrated" && git push -q
```

---

### Task 10: Recorder, cut, and the narrated variant

**Files:**
- Create: `demo/record.mjs`, `demo/narrate.sh`, `demo/package.json`

**Interfaces:**
- Consumes: `demo/scene.txt`, `demo/logs/*.log`, `demo/timeline.json`, the Pages URL.
- Produces: `demo/out/bazaar-demo.mp4` (captioned, silent) and `demo/out/bazaar-demo-narrated.mp4`.

- [ ] **Step 1: Recorder**

```json
// demo/package.json
{ "name": "bazaar-demo", "private": true, "type": "module", "dependencies": { "playwright": "^1.50.0" } }
```
Run: `cd ~/Documents/BlackBoxBazaar/demo && npm install 2>&1 | tail -1 && npx playwright install chromium 2>&1 | tail -1`.

```js
// demo/record.mjs — records the page while scenes.sh runs; overlays the caption and agent logs.
import { chromium } from "playwright";
import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const URL = process.argv[2] ?? "https://leavesj.github.io/black-box-bazaar/";
const here = new URL(".", import.meta.url).pathname;
const OUT = join(here, "out"); mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.addStyleTag({ content: `
  #cap { position:fixed; left:0; right:0; bottom:0; padding:14px 28px; background:rgba(8,10,13,.94); color:#fff; font:600 18px/1.4 ui-sans-serif,system-ui; border-top:1px solid #333; z-index:99999 }
  #logs { position:fixed; right:0; top:0; width:520px; height:calc(100% - 70px); overflow:hidden; background:rgba(8,10,13,.92); color:#cfd6dd; font:12px/1.35 ui-monospace,Menlo,monospace; padding:10px 12px; border-left:1px solid #333; z-index:99998; white-space:pre-wrap }
  #logs b { color:#7ab8ff } main { padding-right:540px !important }` });
await page.evaluate(() => { for (const id of ["cap", "logs"]) { const d = document.createElement("div"); d.id = id; document.body.appendChild(d); } });

const tail = (file, n) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").slice(-n) : [];
function fmt(line) {
  try { const o = JSON.parse(line); const { t, role, event, ...rest } = o;
    const short = Object.entries(rest).filter(([k]) => !["answers"].includes(k)).map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("http") ? v.split("/").pop().slice(0, 10) + "…" : String(v).slice(0, 40)}`).join(" ");
    return `<b>${role}</b> ${event}  ${short}`; } catch { return line; }
}
let last = "";
while (true) {
  const cap = existsSync(join(here, "scene.txt")) ? readFileSync(join(here, "scene.txt"), "utf8").trim() : "";
  if (cap === "END") break;
  const dir = join(here, "logs");
  const lines = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".log")).flatMap(f => tail(join(dir, f), 40)) : [];
  lines.sort();
  const html = lines.slice(-28).map(fmt).join("\n");
  if (cap + html !== last) { await page.evaluate(([c, h]) => { document.getElementById("cap").textContent = c; document.getElementById("logs").innerHTML = h; }, [cap, html]); last = cap + html; }
  await page.waitForTimeout(700);
}
await page.waitForTimeout(2500);
await ctx.close(); await browser.close();
const webm = readdirSync(OUT).find(f => f.endsWith(".webm"));
renameSync(join(OUT, webm), join(OUT, "raw.webm"));
console.log("recorded demo/out/raw.webm");
```

- [ ] **Step 2: Record a full run and cut it**

Two terminals, or one with a background job:

```bash
cd ~/Documents/BlackBoxBazaar && rm -f demo/scene.txt && (cd demo && node record.mjs https://leavesj.github.io/black-box-bazaar/ > out/record.log 2>&1 &) ; sleep 6 ; ./demo/scenes.sh 2>&1 | tee demo/logs/scenes.out | grep -E '^==|error' ; sleep 8
ffmpeg -y -i demo/out/raw.webm -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -movflags +faststart demo/out/bazaar-demo.mp4 2>&1 | tail -1
ffprobe -v error -show_entries format=duration -of csv=p=0 demo/out/bazaar-demo.mp4
```
Expected: duration under 300 seconds. If over, the longest waits are the two 90-second windows; cut them with `ffmpeg -ss/-to` segments and `concat`, keeping the settle moment. Extract three frames and look at them: `ffmpeg -y -i demo/out/bazaar-demo.mp4 -vf "select='not(mod(n\,900))'" -vsync vfr demo/out/frame_%02d.png`.

- [ ] **Step 3: Narrated variant**

```bash
#!/usr/bin/env bash
# demo/narrate.sh — synthesise one clip per caption change, place each at its scene offset, mux over the silent cut.
set -euo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
import json, subprocess, os
tl = json.load(open("timeline.json")); t0 = tl[0]["t"]
os.makedirs("out/narr", exist_ok=True)
inputs, filters, tags = [], [], []
for i, e in enumerate(tl):
    aiff = f"out/narr/{i}.aiff"
    subprocess.run(["say", "-v", "Samantha", "-r", "185", "-o", aiff, e["caption"].split("·",1)[-1].strip()], check=True)
    inputs += ["-i", aiff]
    filters.append(f"[{i+1}:a]adelay={(e['t']-t0)*1000}|{(e['t']-t0)*1000}[a{i}]"); tags.append(f"[a{i}]")
n = len(tl)
fc = ";".join(filters) + ";" + "".join(tags) + f"amix=inputs={n}:normalize=0[mix]"
cmd = ["ffmpeg", "-y", "-i", "out/bazaar-demo.mp4", *inputs, "-filter_complex", fc, "-map", "0:v", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-shortest", "out/bazaar-demo-narrated.mp4"]
subprocess.run(cmd, check=True)
print("wrote out/bazaar-demo-narrated.mp4")
PY
```
`chmod +x demo/narrate.sh && ./demo/narrate.sh`. The offsets assume the recording started at the first scene's timestamp minus the six-second head start in Step 2; if speech lands early, add 6000 ms to every `adelay`.

- [ ] **Step 4: Commit tooling, not videos**

```bash
cd ~/Documents/BlackBoxBazaar && printf 'demo/out/\ndemo/logs/\ndemo/scene.txt\ndemo/timeline.json\ndemo/node_modules/\n' >> .gitignore && git add .gitignore demo/record.mjs demo/narrate.sh demo/package.json demo/package-lock.json && git commit -q -m "feat(demo): recorder with captions and agent logs, narrated variant" && git push -q
```

---

### Task 11: README and submission

**Files:**
- Create: `README.md`, `.env.example`

- [ ] **Step 1: Write the README with the four required answers first**

```markdown
# Black Box Bazaar: a market of refutations

Autonomous agents buy and sell counterexamples to claims about an AI model, on Base Sepolia, and the buyer cannot see the counterexample before paying.

- Live page: https://leavesj.github.io/black-box-bazaar/
- Contract: `0xTHEADDRESS` on Base Sepolia — https://sepolia.basescan.org/address/0xTHEADDRESS
- Video: (link)

## Vertical

Model-evaluation red-teaming. A buyer agent acts for whoever maintains a model or an eval suite and wants to know where a stated property fails. Seller agents hunt for inputs that break the stated property and sell them. The demo claim: `claude-haiku-4-5-20251001` at temperature 0 multiplies two three-digit integers correctly. Measured before building: it fails about 1 in 10 (three-digit) and 3 in 4 (four-digit), so three-digit is a claim a buyer would actually post.

The good is a counterexample. Its value is that the buyer does not have it yet, and once revealed it can be checked in one deterministic re-run. That is why this vertical fits a market where the buyer cannot inspect before paying: the good verifies itself after reveal, so no language model has to interpret it and none touches the contract.

## Trust assumptions

- The pinned model API is the shared ground truth, and buyer, seller and arbiter all reach the same model at the same settings.
- The arbiter address is honest. There is one.
- Temperature 0 is not deterministic, so "the model is wrong on this input" means wrong in a majority of fixed runs (buyer 2 of 3, arbiter 3 of 5), stated in the claim itself.

## Biggest design decision

**Unadjudicated is a third state that never rounds to confirmed.** If a buyer reads a reveal and goes silent past the window, anyone can settle: the seller is paid, because the buyer had its chance, but the sale is recorded as unadjudicated, the buyer's record shows it went silent, and the seller's confirmed count does not move. A seller with zero confirmed sales displays as *unknown* no matter how many silent sales it was paid for. Money follows the default; reputation does not. Most marketplaces read "no dispute" as "satisfied"; in a black-box market that measures apathy, not quality.

## One important limitation

A single arbiter. The dispute path is one address that re-runs the test and rules; the interface is one address so it can be replaced by a quorum, but today a dishonest arbiter or a colluding buyer and arbiter cannot be caught by the contract.

## How it works

1. **Claim.** Buyer posts model, test text, bounty per counterexample, max count, expiry, and an x25519 key. The whole bounty pool is escrowed.
2. **Commit.** Seller posts `keccak256(claimId, plaintext, salt)` and a bond. Duplicate hashes are rejected and each commitment reserves a bounty slot, so escrow is never over-committed.
3. **Reveal.** Seller posts the counterexample and salt encrypted to the buyer's key, on-chain.
4. **Adjudicate.** Buyer decrypts, checks the commitment, re-runs, and confirms or disputes with a bond.
5. **Dispute.** Seller must disclose the plaintext on-chain and the contract checks it against the commitment. The arbiter re-runs and rules. A losing buyer forfeits its bond and the finding is now public; a losing seller is slashed.
6. **Silence.** Window closes, anyone settles, seller paid, sale unadjudicated.

## Failure modes designed against

nondeterminism (majority of runs, stated in claim) · version drift (version pinned in claim) · garbage reveals (plaintext must match commitment or the seller is slashed) · frivolous disputes (bond, and publicity of the finding) · silent buyers (settle rule) · commit-and-vanish spam (reveal window, bond forfeited) · reputation from unchecked sales (unknown rule). Not caught: a dishonest arbiter; resale of the same pair with a different salt (the pair space is small enough that an unsalted commitment would be brute-forceable, so dedup would need the buyer to open a prior commitment on-chain; designed, not built).

## Run it

Foundry and Node 26. `forge test` runs 27 contract tests. `cd agents && npm install && npm test`. Copy `.env.example` to `.env`, fund a deployer on Base Sepolia, then `npm run wallets -- gen`, `npm run wallets -- fund`, deploy with `forge script script/Deploy.s.sol --broadcast`, `./scripts/export-abi.sh <addr> 84532 <block>`, and `./demo/scenes.sh`.

## Where the ideas came from

Three earlier projects each found that a check which never ran reads exactly like a check that found nothing: a mining verifier that reported zero false positives from a shield that had skipped every template; a reasoning tutor that reports zero rejections in 64 pushes as "at most 4.7%"; a build harness whose first invariant is that a gate which cannot fail is not a gate. This market is that lesson applied to reputation.
```
Also write `.env.example` with the variable names and no values:

```
ANTHROPIC_API_KEY=
CHAIN=base-sepolia
DEPLOYER_KEY=
BUYER_KEY=
SELLER_KEY=
ROGUE_KEY=
NEWCOMER_KEY=
ARBITER_KEY=
ARBITER_ADDRESS=
MARKET_ADDRESS=
```

- [ ] **Step 2: Fill the address, the block explorer link, and the video link; publish**

```bash
cd ~/Documents/BlackBoxBazaar && sed -i '' "s/0xTHEADDRESS/$(grep MARKET_ADDRESS .env | cut -d= -f2)/g" README.md && git add README.md .env.example && git commit -q -m "docs: README with vertical, trust assumptions, the design decision and the limitation" && git push -q
```
The video is uploaded by the human (unlisted YouTube or Drive) and the link pasted into README; commit and publish again.

---

### Task 12 (optional, after everything above is published): Felix governs the take-home

Only if there is time. `felix new bazaar` in the Felix home creates `projects/bazaar/` and a `.felix` marker in the repo; set its gate to `forge test && (cd agents && npm test)`; run `felix gate` and see it green, then break one assertion and see it red, then restore. It touches the main Felix checkout, so do it on a branch there and leave it uncommitted if the session ends.

---

## Self-review

**Spec coverage.** §3 mechanism: Tasks 1–3. §4 contract incl. table and counters: Tasks 1–3; stretch duplicate-proof: deliberately not scheduled, documented in README (Task 11). §5 agents and step zero: Task 5–6, measurement recorded in the spec. §6 delivery: Task 5 crypto with envelope `plaintext||salt`. §7 page and unknown rule: Task 7. §8 failure modes: README Task 11 and code paths in Tasks 2–3, 6. §9 testing: every Foundry test shown failing first in Tasks 1–3, agents dry-run on anvil in Task 6 step 5. §10 demo scenes and windows: Task 9, recorder Task 10. §11 deliverables: Tasks 8, 10, 11. §13 parameters: Global Constraints and config.ts.

**Placeholders.** `0xTHEADDRESS`, `THEBLOCK` and `(link)` are values that only exist after deploy and are filled by the sed in Task 11 step 2 and the human's upload; they are not plan gaps.

**Type consistency.** `getSale`/`getClaim` return structs consumed as objects with the field names from the Solidity structs in every agent; `rep()` is consumed positionally (7 uint32) in both the tests and the page; `S` state numbers match the enum order; `commitHash` argument order `(claimId, plaintext, salt)` matches `abi.encode` in `disclose`; `keyFor` roles match `wallets.ts` roles plus `deployer`.
