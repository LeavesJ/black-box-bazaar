// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RefutationMarket
/// @notice A claim-first market for counterexamples. A buyer escrows bounties
/// for counterexamples to a claim about a pinned model. Sellers commit a hash,
/// reveal an encrypted counterexample, and are paid once the buyer confirms,
/// the arbiter upholds them, or the buyer stays silent past the window.
/// Silence pays the seller but is recorded as unadjudicated, never confirmed.
contract RefutationMarket {
    enum SaleState { Committed, Revealed, Confirmed, Disputed, Refuted, Upheld, Unadjudicated, Withdrawn, Unarbitrated }

    /// @dev Why the buyer disputed. Recorded so the arbiter checks delivery before running the model.
    enum DisputeReason { CannotDecrypt, CommitMismatch, NotReproduced }

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
        uint64 disclosedAt;
        bytes32 salt;
        bytes32 ephemeralSecret;
        DisputeReason disputeReason;
        SaleState state;
    }

    struct Rep {
        uint32 sellerConfirmed;
        uint32 sellerRefuted;
        uint32 sellerUnadjudicated;
        uint32 sellerWithdrawn;
        uint32 sellerUnarbitrated;
        uint32 buyerAdjudicated;
        uint32 buyerSilent;
        uint32 buyerDisputesLost;
    }

    address public immutable arbiter;
    uint64 public immutable revealWindow;
    uint64 public immutable adjudicationWindow;
    uint64 public immutable disclosureWindow;
    uint64 public immutable arbitrationWindow;
    uint256 public immutable bondBps;

    Claim[] private _claims;
    Sale[] private _sales;
    mapping(address => Rep) public rep;
    mapping(uint256 => mapping(bytes32 => bool)) public commitUsed;
    /// @notice Payments a recipient refused at transition time. A transition never
    /// reverts because of who is being paid; the money waits here for `withdraw`.
    mapping(address => uint256) public owed;

    event ClaimPosted(uint256 indexed claimId, address indexed buyer, string modelId, string spec, bytes32 buyerPubKey, uint256 bounty, uint32 maxHits, uint64 expiresAt);
    event Committed(uint256 indexed saleId, uint256 indexed claimId, address indexed seller, bytes32 commitHash, uint256 bond);
    event Revealed(uint256 indexed saleId, uint256 indexed claimId, bytes ciphertext);
    event Confirmed(uint256 indexed saleId, uint256 indexed claimId);
    event Disputed(uint256 indexed saleId, uint256 indexed claimId, uint256 buyerBond, DisputeReason reason);
    event Disclosed(uint256 indexed saleId, uint256 indexed claimId, bytes plaintext, bytes32 salt, bytes32 ephemeralSecret);
    event Unarbitrated(uint256 indexed saleId, uint256 indexed claimId);
    event Ruled(uint256 indexed saleId, uint256 indexed claimId, bool sellerWasRight);
    event Settled(uint256 indexed saleId, uint256 indexed claimId);
    event Withdrawn(uint256 indexed saleId, uint256 indexed claimId, string reason);
    event ClaimClosed(uint256 indexed claimId, uint256 refunded);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Paid(address indexed to, uint256 amount);

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
    error NothingOwed();

    constructor(address _arbiter, uint64 _revealWindow, uint64 _adjudicationWindow, uint64 _disclosureWindow, uint64 _arbitrationWindow, uint256 _bondBps) {
        if (_arbiter == address(0) || _revealWindow == 0 || _adjudicationWindow == 0 || _disclosureWindow == 0 || _arbitrationWindow == 0) revert ZeroArgument();
        arbiter = _arbiter;
        revealWindow = _revealWindow;
        adjudicationWindow = _adjudicationWindow;
        disclosureWindow = _disclosureWindow;
        arbitrationWindow = _arbitrationWindow;
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

    function dispute(uint256 saleId, DisputeReason reason) external payable {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        if (msg.sender != c.buyer) revert NotBuyer();
        _requireState(s, SaleState.Revealed);
        if (block.timestamp > s.revealedAt + adjudicationWindow) revert WindowClosed();
        uint256 bond = bondFor(s.claimId);
        if (msg.value != bond) revert WrongValue(bond, msg.value);
        s.buyerBond = bond;
        s.disputedAt = uint64(block.timestamp);
        s.disputeReason = reason;
        s.state = SaleState.Disputed;
        rep[c.buyer].buyerAdjudicated += 1;
        emit Disputed(saleId, s.claimId, bond, reason);
    }

    /// @notice Answer a dispute. The ephemeral secret lets the arbiter re-derive the posted
    /// ciphertext and check that delivery actually happened before it runs the model.
    function disclose(uint256 saleId, bytes calldata plaintext, bytes32 salt, bytes32 ephemeralSecret) external {
        Sale storage s = _sales[saleId];
        if (msg.sender != s.seller) revert NotSeller();
        _requireState(s, SaleState.Disputed);
        if (s.disclosedAt != 0) revert AlreadyDisclosed();
        if (plaintext.length == 0) revert ZeroArgument();
        if (block.timestamp > s.disputedAt + disclosureWindow) revert WindowClosed();
        if (keccak256(abi.encode(s.claimId, plaintext, salt)) != s.commitHash) revert HashMismatch();
        s.plaintext = plaintext;
        s.salt = salt;
        s.ephemeralSecret = ephemeralSecret;
        s.disclosedAt = uint64(block.timestamp);
        emit Disclosed(saleId, s.claimId, plaintext, salt, ephemeralSecret);
    }

    function rule(uint256 saleId, bool sellerWasRight) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        _requireState(s, SaleState.Disputed);
        if (s.disclosedAt == 0) revert NotDisclosed();
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

    /// @notice The arbiter never ruled. Each party takes back its own bond, the reserved bounty
    /// returns to the claim, and the seller is neither credited nor refuted. The buyer keeps the
    /// disclosed information without paying; that is the stated tradeoff of a vanished arbiter.
    function resolveUnarbitrated(uint256 saleId) external {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        _requireState(s, SaleState.Disputed);
        if (s.disclosedAt == 0) revert NotDisclosed();
        if (block.timestamp <= s.disclosedAt + arbitrationWindow) revert WindowOpen();
        s.state = SaleState.Unarbitrated;
        c.pending -= 1;
        rep[s.seller].sellerUnarbitrated += 1;
        emit Unarbitrated(saleId, s.claimId);
        _pay(s.seller, s.sellerBond);
        _pay(c.buyer, s.buyerBond);
    }

    // ---------- windows ----------
    function withdrawSale(uint256 saleId) external {
        Sale storage s = _sales[saleId];
        Claim storage c = _claims[s.claimId];
        _requireState(s, SaleState.Disputed);
        if (s.disclosedAt != 0) revert AlreadyDisclosed();
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

    // ---------- internal ----------
    function _requireState(Sale storage s, SaleState expected) internal view {
        if (s.state != expected) revert WrongState(expected, s.state);
    }

    /// @notice Take money a transition could not deliver to you at the time.
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Paid(msg.sender, amount);
    }

    /// @dev Push with a bounded stipend; a recipient that refuses is credited, never
    /// allowed to revert the transition that pays it. State is final before this runs.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount, gas: 50_000}("");
        if (!ok) {
            owed[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }
}
