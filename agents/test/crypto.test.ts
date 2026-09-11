// agents/test/crypto.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes, stringToBytes } from "viem";
import nacl from "tweetnacl";
import {
  boxKeypairFromEthKey, seal, open, canonicalPair, parsePair, commitHash, randomSalt, randomBytesHex,
  envelope, splitEnvelope, verifyDelivery,
} from "../src/crypto.ts";

const hexKey = (byte: string) => ("0x" + byte.repeat(32)) as `0x${string}`;

test("canonical pair has no whitespace and fixed key order", () => {
  assert.equal(canonicalPair(123, 456), '{"a":123,"b":456}');
  assert.deepEqual(parsePair(stringToBytes('{"a":123,"b":456}')), { a: 123, b: 456 });
  assert.equal(parsePair(stringToBytes("nonsense")), null);
});

test("parsePair accepts only integers inside 100..999 on both sides", () => {
  assert.deepEqual(parsePair(stringToBytes('{"a":100,"b":999}')), { a: 100, b: 999 });
  assert.equal(parsePair(stringToBytes('{"a":99,"b":500}')), null, "a below range");
  assert.equal(parsePair(stringToBytes('{"a":500,"b":1000}')), null, "b above range");
  assert.equal(parsePair(stringToBytes('{"a":123.5,"b":456}')), null, "non-integer a");
  assert.equal(parsePair(stringToBytes('{"a":123,"b":"456"}')), null, "string b");
  assert.equal(parsePair(stringToBytes('{"a":-123,"b":456}')), null, "negative a");
  assert.equal(parsePair(stringToBytes('{"a":123}')), null, "missing b");
  assert.equal(parsePair(stringToBytes('[123,456]')), null, "not an object");
  assert.equal(parsePair(stringToBytes('null')), null, "null");
});

test("commit hash matches the Solidity test vector", () => {
  const pt = bytesToHex(stringToBytes('{"a":123,"b":456}'));
  assert.equal(pt, "0x7b2261223a3132332c2262223a3435367d");
  const salt = hexKey("11");
  assert.equal(commitHash(1n, pt, salt), "0xe42ef964f458bf6a7f29035d0d681389f65fe8e1462a4346c7ee63f087a9f67f");
});

test("seal and open roundtrip an envelope of plaintext plus salt", () => {
  const buyer = boxKeypairFromEthKey(hexKey("ab"));
  const salt = randomSalt();
  const env = envelope(stringToBytes(canonicalPair(590, 877)), salt);
  const { ciphertext, ephemeralSecret } = seal(env, buyer.publicKey);
  assert.equal(hexToBytes(ephemeralSecret).length, 32);
  const opened = open(ciphertext, buyer.secretKey);
  assert.ok(opened);
  const { plaintext, salt: gotSalt } = splitEnvelope(opened!);
  assert.deepEqual(parsePair(plaintext), { a: 590, b: 877 });
  assert.equal(gotSalt, salt);
});

test("a different recipient cannot open", () => {
  const buyer = boxKeypairFromEthKey(hexKey("ab"));
  const stranger = nacl.box.keyPair();
  const { ciphertext } = seal(envelope(stringToBytes(canonicalPair(1, 2)), randomSalt()), buyer.publicKey);
  assert.equal(open(ciphertext, stranger.secretKey), null);
});

test("keypair from eth key is deterministic", () => {
  const k = hexKey("cd");
  assert.deepEqual(boxKeypairFromEthKey(k).publicKey, boxKeypairFromEthKey(k).publicKey);
});

// ---- delivery check: what the arbiter runs before it touches the model

function delivered() {
  const buyer = boxKeypairFromEthKey(hexKey("ab"));
  const buyerPub = bytesToHex(buyer.publicKey);
  const plaintext = bytesToHex(stringToBytes(canonicalPair(590, 877)));
  const salt = randomSalt();
  const { ciphertext, ephemeralSecret } = seal(envelope(hexToBytes(plaintext), salt), buyer.publicKey);
  return { buyerPub, plaintext, salt, ciphertext, ephemeralSecret };
}

function flipByte(hex: `0x${string}`, index: number): `0x${string}` {
  const b = hexToBytes(hex);
  b[index] = b[index]! ^ 0x01;
  return bytesToHex(b);
}

test("verifyDelivery: an honest reveal reconstructs byte for byte", () => {
  const d = delivered();
  assert.equal(verifyDelivery(d.ciphertext, d.plaintext, d.salt, d.ephemeralSecret, d.buyerPub), true);
});

test("verifyDelivery: a tampered ciphertext fails, in the box and in the ephemeral key prefix", () => {
  const d = delivered();
  const len = hexToBytes(d.ciphertext).length;
  assert.equal(verifyDelivery(flipByte(d.ciphertext, len - 1), d.plaintext, d.salt, d.ephemeralSecret, d.buyerPub), false, "box byte");
  assert.equal(verifyDelivery(flipByte(d.ciphertext, 0), d.plaintext, d.salt, d.ephemeralSecret, d.buyerPub), false, "ephemeral pub byte");
  assert.equal(verifyDelivery(flipByte(d.ciphertext, 40), d.plaintext, d.salt, d.ephemeralSecret, d.buyerPub), false, "nonce byte");
});

test("verifyDelivery: the reviewer's attack, random bytes of the right length, fails", () => {
  const d = delivered();
  const garbage = randomBytesHex(hexToBytes(d.ciphertext).length);
  assert.equal(verifyDelivery(garbage, d.plaintext, d.salt, d.ephemeralSecret, d.buyerPub), false);
});

test("verifyDelivery: the wrong ephemeral secret fails", () => {
  const d = delivered();
  const other = bytesToHex(nacl.box.keyPair().secretKey);
  assert.equal(verifyDelivery(d.ciphertext, d.plaintext, d.salt, other, d.buyerPub), false);
  assert.equal(verifyDelivery(d.ciphertext, d.plaintext, d.salt, "0x1234", d.buyerPub), false, "malformed secret");
});

test("verifyDelivery: the wrong recipient key fails", () => {
  const d = delivered();
  const stranger = bytesToHex(nacl.box.keyPair().publicKey);
  assert.equal(verifyDelivery(d.ciphertext, d.plaintext, d.salt, d.ephemeralSecret, stranger), false);
});

test("verifyDelivery: a different plaintext or salt behind the same commitment fails", () => {
  const d = delivered();
  const otherPlaintext = bytesToHex(stringToBytes(canonicalPair(590, 878)));
  assert.equal(verifyDelivery(d.ciphertext, otherPlaintext, d.salt, d.ephemeralSecret, d.buyerPub), false);
  assert.equal(verifyDelivery(d.ciphertext, d.plaintext, randomSalt(), d.ephemeralSecret, d.buyerPub), false);
  assert.equal(verifyDelivery("0x00", d.plaintext, d.salt, d.ephemeralSecret, d.buyerPub), false, "too short");
});
