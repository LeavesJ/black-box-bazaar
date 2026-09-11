// agents/src/config.ts
import { baseSepolia, foundry } from "viem/chains";
import type { Hex } from "viem";

export const CHAIN = process.env.CHAIN === "base-sepolia" ? baseSepolia : foundry;
export const RPC_URL = process.env.RPC_URL ?? (CHAIN.id === 84532 ? "https://sepolia.base.org" : "http://127.0.0.1:8545");
export const EXPLORER = CHAIN.id === 84532 ? "https://sepolia.basescan.org" : "";
export const MARKET_ADDRESS = (process.env.MARKET_ADDRESS ?? "") as Hex;

export const MODEL_ID = "claude-haiku-4-5-20251001";
export const MAX_TOKENS = 32;
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

/// The one specification every agent in this tree can evaluate. It states the parser rule so a
/// reply's classification is part of the claim, not a private convention of one agent.
export const CLAIM_SPEC =
  `Claim: ${MODEL_ID} at temperature 0 with max_tokens ${MAX_TOKENS} multiplies two three-digit integers correctly. ` +
  `Domain: a and b are integers in ${LO}..${HI}; a counterexample is the canonical JSON {"a":A,"b":B} with no whitespace. ` +
  `Test: prompt "What is {a} × {b}? Reply with only the integer." ` +
  `Parse rule: trim the reply, strip one trailing period, remove commas; the remainder must match ^-?[0-9]+$ in full, ` +
  `otherwise the reply is malformed; a reply cut off at max_tokens is malformed. ` +
  `Only a well-formed integer different from a*b counts as wrong; malformed replies never count. ` +
  `A counterexample is a pair where the model is wrong in at least ${BUYER_THRESHOLD} of ${BUYER_RUNS} runs. ` +
  `Disputes are re-run ${ARBITER_RUNS} times and upheld at ${ARBITER_THRESHOLD}.`;

export const SUPPORTED_SPEC = { modelId: MODEL_ID, spec: CLAIM_SPEC } as const;

/// Exact match on both fields. A claim this tree cannot evaluate is never traded against.
export function claimIsSupported(claim: { modelId: string; spec: string }): boolean {
  return claim.modelId === SUPPORTED_SPEC.modelId && claim.spec === SUPPORTED_SPEC.spec;
}

export type Role = "deployer" | "buyer" | "seller" | "rogue" | "newcomer" | "quiet" | "arbiter";
export const ROLES: readonly Role[] = ["deployer", "buyer", "seller", "rogue", "newcomer", "quiet", "arbiter"];
/// The wallets `wallets gen` creates and `wallets fund` tops up: every role but the deployer, which a
/// human funds. `quiet` is a seller wallet with no history, kept for the silent-buyer scene so that
/// scene never dirties the honest seller's record.
export const ROLE_WALLETS: readonly Exclude<Role, "deployer">[] = ["buyer", "seller", "rogue", "newcomer", "quiet", "arbiter"];

const ANVIL_KEYS: Record<Role, Hex> = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  buyer:    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller:   "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  rogue:    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  newcomer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  arbiter:  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  quiet:    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // anvil account 6
};

/// The addresses anvil prints for accounts 0..6, in the order ANVIL_KEYS assigns them to roles.
/// Checked against `cast rpc eth_accounts` on 2026-09-10; a key that stops matching is a typo.
export const ANVIL_ADDRESSES: Record<Role, Hex> = {
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  buyer:    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  seller:   "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  rogue:    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  newcomer: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  arbiter:  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  quiet:    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
};

/// On anvil the roles are the well-known accounts by definition, and .env is ignored: it holds the
/// testnet keys (a DEPLOYER_KEY funded from a faucet), and any of those on anvil is a wallet with no
/// ETH, which the sweep found out the first time it ran from the deployer. Off anvil the env key is
/// the only source.
export function keyFor(role: Role): Hex {
  if (CHAIN.id === foundry.id) return ANVIL_KEYS[role];
  const env = process.env[`${role.toUpperCase()}_KEY`];
  if (env) return env as Hex;
  throw new Error(`${role.toUpperCase()}_KEY is not set and chain is not anvil`);
}
