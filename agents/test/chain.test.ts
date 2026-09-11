// agents/test/chain.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import abi from "../src/abi.json" with { type: "json" };
import { S, STATE_NAMES, committedSaleIdFromReceipt, eventFromReceipt, isDisclosed, isTerminal, isTerminalRevert, keepTrying, saleIdFromCommittedLogs } from "../src/chain.ts";

const MARKET = ("0x" + "e7".repeat(20)) as Hex;
const SELLER = ("0x" + "3c".repeat(20)) as Hex;

function committedLog(saleId: bigint, claimId: bigint, address: Hex = MARKET) {
  const topics = encodeEventTopics({ abi, eventName: "Committed", args: { saleId, claimId, seller: SELLER } });
  const data = encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [("0x" + "aa".repeat(32)) as Hex, 100n]);
  return { address, topics, data };
}

function revealedLog(saleId: bigint, claimId: bigint) {
  const topics = encodeEventTopics({ abi, eventName: "Revealed", args: { saleId, claimId } });
  const data = encodeAbiParameters([{ type: "bytes" }], ["0x0102"]);
  return { address: MARKET, topics, data };
}

const receipt = (logs: any[]) => ({ logs, transactionHash: ("0x" + "01".repeat(32)) as Hex }) as any;

test("state tables carry Unarbitrated = 8 and agree with each other", () => {
  assert.equal(S.Unarbitrated, 8);
  assert.equal(STATE_NAMES[8], "Unarbitrated");
  assert.equal(STATE_NAMES.length, 9);
  for (const [name, n] of Object.entries(S)) assert.equal(STATE_NAMES[n], name);
});

test("terminal states are everything but Committed, Revealed and Disputed", () => {
  assert.deepEqual(STATE_NAMES.map((_, i) => isTerminal(i)), [false, false, true, false, true, true, true, true, true]);
});

test("committedSaleIdFromReceipt reads the sale id from the seller's own Committed event", () => {
  const r = receipt([revealedLog(3n, 0n), committedLog(7n, 2n)]);
  assert.equal(committedSaleIdFromReceipt(r, MARKET), 7n);
});

test("committedSaleIdFromReceipt ignores a Committed event from another contract and throws with none", () => {
  const stranger = ("0x" + "99".repeat(20)) as Hex;
  assert.throws(() => committedSaleIdFromReceipt(receipt([committedLog(7n, 2n, stranger)]), MARKET), /no Committed event/);
  assert.throws(() => committedSaleIdFromReceipt(receipt([revealedLog(1n, 0n)]), MARKET), /no Committed event/);
  assert.throws(() => committedSaleIdFromReceipt(receipt([]), MARKET), /no Committed event/);
});

test("eventFromReceipt decodes the named event's arguments", () => {
  const args = eventFromReceipt<{ saleId: bigint; claimId: bigint; seller: Hex }>(receipt([committedLog(4n, 1n)]), "Committed", MARKET);
  assert.ok(args);
  assert.equal(args!.saleId, 4n);
  assert.equal(args!.claimId, 1n);
  assert.equal(args!.seller.toLowerCase(), SELLER);
  assert.equal(eventFromReceipt(receipt([committedLog(4n, 1n)]), "Revealed", MARKET), null);
});

// ---- the sweep's decision table, one row per window

import { sweepAction, type Windows } from "../src/chain.ts";
const W: Windows = { reveal: 60n, adjudication: 60n, disclosure: 60n, arbitration: 60n };
const sale = (over: Partial<Parameters<typeof sweepAction>[0]>) =>
  ({ state: S.Committed, committedAt: 1000n, revealedAt: 0n, disputedAt: 0n, disclosedAt: 0n, ...over });

test("sweepAction: each window is judged strictly after its close on the chain clock", () => {
  assert.equal(sweepAction(sale({ state: S.Committed, committedAt: 1000n }), 1060n, W), null, "reveal window still open at the boundary");
  assert.equal(sweepAction(sale({ state: S.Committed, committedAt: 1000n }), 1061n, W), "expireCommit");
  assert.equal(sweepAction(sale({ state: S.Revealed, revealedAt: 1000n }), 1060n, W), null);
  assert.equal(sweepAction(sale({ state: S.Revealed, revealedAt: 1000n }), 1061n, W), "settle");
  assert.equal(sweepAction(sale({ state: S.Disputed, disputedAt: 1000n }), 1060n, W), null);
  assert.equal(sweepAction(sale({ state: S.Disputed, disputedAt: 1000n }), 1061n, W), "withdrawSale");
});

test("sweepAction: a disclosed dispute the arbiter never ruled resolves as unarbitrated, and only that", () => {
  const disclosed = sale({ state: S.Disputed, disputedAt: 1000n, disclosedAt: 1030n });
  assert.equal(sweepAction(disclosed, 1061n, W), null, "disclosure window passed but arbitration window still open: never withdraw a disclosed sale");
  assert.equal(sweepAction(disclosed, 1090n, W), null, "arbitration boundary");
  assert.equal(sweepAction(disclosed, 1091n, W), "resolveUnarbitrated");
});

test("sweepAction: terminal states are never touched however old they are", () => {
  for (const state of [S.Confirmed, S.Refuted, S.Upheld, S.Unadjudicated, S.Withdrawn, S.Unarbitrated]) {
    assert.equal(sweepAction(sale({ state, committedAt: 0n, revealedAt: 0n, disputedAt: 0n, disclosedAt: 1n }), 10n ** 12n, W), null, STATE_NAMES[state]);
  }
});

test("the disclosure sentinel is disclosedAt, as in the contract, never the plaintext length", () => {
  assert.equal(isDisclosed({ disclosedAt: 0n }), false);
  assert.equal(isDisclosed({ disclosedAt: 1030n }), true);
  // A sale the sweep reads with disclosedAt set is disclosed whatever else it carries: it is never withdrawn.
  const s = { ...sale({ state: S.Disputed, disputedAt: 1000n, disclosedAt: 1030n }), plaintext: "0x" };
  assert.equal(sweepAction(s, 1061n, W), null);
  assert.equal(sweepAction(s, 1091n, W), "resolveUnarbitrated");
});

// ---- keepTrying: a watcher retries until the sale's own window closes on the chain clock

test("keepTrying: a buyer keeps a Revealed sale until revealedAt + adjudication, inclusive", () => {
  const s = { state: S.Revealed, revealedAt: 1000n, disclosedAt: 0n };
  assert.equal(keepTrying(s, 1000n, W), true);
  assert.equal(keepTrying(s, 1060n, W), true, "the boundary is still inside the window, as the contract's > check says");
  assert.equal(keepTrying(s, 1061n, W), false);
});

test("keepTrying: an arbiter keeps a disclosed dispute until disclosedAt + arbitration, and never an undisclosed one", () => {
  const disclosed = { state: S.Disputed, revealedAt: 900n, disclosedAt: 1000n };
  assert.equal(keepTrying(disclosed, 1060n, W), true);
  assert.equal(keepTrying(disclosed, 1061n, W), false);
  assert.equal(keepTrying({ state: S.Disputed, revealedAt: 900n, disclosedAt: 0n }, 901n, W), false, "nothing to rule on yet");
});

test("keepTrying: Committed and every terminal state are nothing a watcher retries", () => {
  for (const state of [S.Committed, S.Confirmed, S.Refuted, S.Upheld, S.Unadjudicated, S.Withdrawn, S.Unarbitrated]) {
    assert.equal(keepTrying({ state, revealedAt: 1000n, disclosedAt: 1000n }, 1000n, W), false, STATE_NAMES[state]);
  }
});

test("keepTrying is not a strike count: the same sale is kept on any number of asks inside the window", () => {
  const s = { state: S.Revealed, revealedAt: 1000n, disclosedAt: 0n };
  for (let i = 0; i < 10; i++) assert.equal(keepTrying(s, 1000n + BigInt(i), W), true);
});

// ---- isTerminalRevert: which reverts end the retry for a sale

test("isTerminalRevert: WrongState, WindowClosed, NotBuyer and NotArbiter end the sale, wherever they sit in the cause chain", () => {
  for (const name of ["WrongState", "WindowClosed", "NotBuyer", "NotArbiter"]) {
    assert.equal(isTerminalRevert(new Error(`The contract function "confirm" reverted.\nError: ${name}(uint8 expected, uint8 got)`)), true, name);
    assert.equal(isTerminalRevert(new Error("request failed", { cause: new Error(`execution reverted: ${name}()`) })), true, `${name} as cause`);
    assert.equal(isTerminalRevert({ shortMessage: `${name}()` }), true, `${name} in shortMessage`);
  }
});

test("isTerminalRevert: anything else is worth another send", () => {
  assert.equal(isTerminalRevert(new Error("nonce too low")), false);
  assert.equal(isTerminalRevert(new Error("fetch failed", { cause: new Error("ECONNREFUSED") })), false);
  assert.equal(isTerminalRevert(new Error("WrongValue(1, 2)")), false, "WrongValue is a bond mistake, not a settled sale");
  assert.equal(isTerminalRevert(null), false);
  assert.equal(isTerminalRevert("WrongState"), false, "a bare string carries no error shape");
  const loop: any = new Error("x"); loop.cause = loop;
  assert.equal(isTerminalRevert(loop), false, "a cyclic cause chain terminates");
});

// ---- saleIdFromCommittedLogs: a seller recovers a lost receipt by its commit hash

test("saleIdFromCommittedLogs matches the hash exactly and case-insensitively, or returns null", () => {
  const H = ("0x" + "ab".repeat(32)) as Hex;
  const logs = [
    { args: { saleId: 4n, commitHash: ("0x" + "cd".repeat(32)) as Hex } },
    { args: { saleId: 9n, commitHash: H.toUpperCase().replace("0X", "0x") as Hex } },
  ];
  assert.equal(saleIdFromCommittedLogs(logs, H), 9n);
  assert.equal(saleIdFromCommittedLogs(logs, ("0x" + "ef".repeat(32)) as Hex), null);
  assert.equal(saleIdFromCommittedLogs([], H), null);
  assert.equal(saleIdFromCommittedLogs([{ args: { commitHash: H } }], H), null, "a log with no saleId is not a match");
});
