// agents/src/crypto.ts
import nacl from "tweetnacl";
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, sha256, stringToBytes, type Hex } from "viem";
import { HI, LO } from "./config.ts";

export function boxKeypairFromEthKey(ethKey: Hex): nacl.BoxKeyPair {
  return nacl.box.keyPair.fromSecretKey(hexToBytes(sha256(ethKey)));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const PUB = nacl.box.publicKeyLength;   // 32
const NONCE = nacl.box.nonceLength;     // 24
const OVERHEAD = nacl.box.overheadLength; // 16

/// ephemeralPub(32) || nonce(24) || box. The seller keeps ephemeralSecret so a dispute can
/// prove that the posted ciphertext really was this envelope sealed to the buyer's key.
export function seal(env: Uint8Array, recipientPub: Uint8Array): { ciphertext: Hex; ephemeralSecret: Hex } {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(NONCE);
  const boxed = nacl.box(env, nonce, recipientPub, eph.secretKey);
  return { ciphertext: bytesToHex(concatBytes(eph.publicKey, nonce, boxed)), ephemeralSecret: bytesToHex(eph.secretKey) };
}

export function open(ciphertext: Hex, recipientSecret: Uint8Array): Uint8Array | null {
  const b = hexToBytes(ciphertext);
  if (b.length < PUB + NONCE + OVERHEAD) return null;
  const ephPub = b.slice(0, PUB);
  const nonce = b.slice(PUB, PUB + NONCE);
  const boxed = b.slice(PUB + NONCE);
  return nacl.box.open(boxed, nonce, ephPub, recipientSecret);
}

/// Delivery check. Rebuilds the ciphertext the seller should have posted from what it disclosed
/// (plaintext, salt, ephemeral secret) and the claim's buyer key, reusing the nonce from the posted
/// bytes, and compares every byte including the ephemeral public key prefix. Anything malformed is a
/// mismatch. This is the trusted arbiter's check, not on-chain cryptography.
export function verifyDelivery(ciphertext: Hex, plaintext: Hex, salt: Hex, ephemeralSecret: Hex, recipientPub: Hex): boolean {
  try {
    const posted = hexToBytes(ciphertext);
    if (posted.length < PUB + NONCE + OVERHEAD) return false;
    const secret = hexToBytes(ephemeralSecret);
    const pub = hexToBytes(recipientPub);
    if (secret.length !== nacl.box.secretKeyLength || pub.length !== PUB) return false;
    const eph = nacl.box.keyPair.fromSecretKey(secret);
    const nonce = posted.slice(PUB, PUB + NONCE);
    const boxed = nacl.box(envelope(hexToBytes(plaintext), salt), nonce, pub, eph.secretKey);
    const expected = concatBytes(eph.publicKey, nonce, boxed);
    if (expected.length !== posted.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ posted[i]!;
    return diff === 0;
  } catch { return false; }
}

export function canonicalPair(a: number, b: number): string {
  return JSON.stringify({ a, b });
}

/// A pair is only a pair when both sides are integers inside the claim's digit range.
export function parsePair(plaintext: Uint8Array): { a: number; b: number } | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(plaintext));
    if (!o || typeof o !== "object") return null;
    const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= LO && (n as number) <= HI;
    if (ok(o.a) && ok(o.b)) return { a: o.a, b: o.b };
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

export function randomBytesHex(n: number): Hex {
  return bytesToHex(nacl.randomBytes(n));
}

export function envelope(plaintext: Uint8Array, salt: Hex): Uint8Array {
  return concatBytes(plaintext, hexToBytes(salt));
}

export function splitEnvelope(env: Uint8Array): { plaintext: Uint8Array; salt: Hex } {
  return { plaintext: env.slice(0, env.length - 32), salt: bytesToHex(env.slice(env.length - 32)) };
}

export { stringToBytes };
