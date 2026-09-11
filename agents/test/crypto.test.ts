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
