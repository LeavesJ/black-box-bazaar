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
