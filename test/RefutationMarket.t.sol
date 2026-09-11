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
        uint256 bond = m.bondFor(claimId);
        bytes32 h = _hash(claimId);
        vm.prank(seller);
        return m.commit{value: bond}(claimId, h);
    }
    function _reveal(uint256 saleId) internal {
        vm.prank(seller);
        m.reveal(saleId, hex"deadbeef");
    }
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
}
