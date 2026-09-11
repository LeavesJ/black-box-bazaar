// agents/test/chain.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import abi from "../src/abi.json" with { type: "json" };
import { S, STATE_NAMES, committedSaleIdFromReceipt, eventFromReceipt, isTerminal } from "../src/chain.ts";

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
  ({ state: S.Committed, committedAt: 1000n, revealedAt: 0n, disputedAt: 0n, disclosedAt: 0n, plaintext: "0x", ...over });

test("sweepAction: each window is judged strictly after its close on the chain clock", () => {
  assert.equal(sweepAction(sale({ state: S.Committed, committedAt: 1000n }), 1060n, W), null, "reveal window still open at the boundary");
  assert.equal(sweepAction(sale({ state: S.Committed, committedAt: 1000n }), 1061n, W), "expireCommit");
  assert.equal(sweepAction(sale({ state: S.Revealed, revealedAt: 1000n }), 1060n, W), null);
  assert.equal(sweepAction(sale({ state: S.Revealed, revealedAt: 1000n }), 1061n, W), "settle");
  assert.equal(sweepAction(sale({ state: S.Disputed, disputedAt: 1000n }), 1060n, W), null);
  assert.equal(sweepAction(sale({ state: S.Disputed, disputedAt: 1000n }), 1061n, W), "withdrawSale");
});

test("sweepAction: a disclosed dispute the arbiter never ruled resolves as unarbitrated, and only that", () => {
  const disclosed = sale({ state: S.Disputed, disputedAt: 1000n, disclosedAt: 1030n, plaintext: "0x7b7d" });
  assert.equal(sweepAction(disclosed, 1061n, W), null, "disclosure window passed but arbitration window still open: never withdraw a disclosed sale");
  assert.equal(sweepAction(disclosed, 1090n, W), null, "arbitration boundary");
  assert.equal(sweepAction(disclosed, 1091n, W), "resolveUnarbitrated");
});

test("sweepAction: terminal states are never touched however old they are", () => {
  for (const state of [S.Confirmed, S.Refuted, S.Upheld, S.Unadjudicated, S.Withdrawn, S.Unarbitrated]) {
    assert.equal(sweepAction(sale({ state, committedAt: 0n, revealedAt: 0n, disputedAt: 0n, disclosedAt: 0n, plaintext: "0x7b7d" }), 10n ** 12n, W), null, STATE_NAMES[state]);
  }
});
