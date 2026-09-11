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

export type Role = "deployer" | "buyer" | "seller" | "rogue" | "newcomer" | "arbiter";
export const ROLES: readonly Role[] = ["deployer", "buyer", "seller", "rogue", "newcomer", "arbiter"];

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
