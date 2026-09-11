// agents/src/chain.ts
import { createPublicClient, createWalletClient, getContract, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import abi from "./abi.json" with { type: "json" };
import { CHAIN, EXPLORER, MARKET_ADDRESS, RPC_URL, keyFor, type Role } from "./config.ts";

export const STATE_NAMES = ["Committed", "Revealed", "Confirmed", "Disputed", "Refuted", "Upheld", "Unadjudicated", "Withdrawn"] as const;
export const S = { Committed: 0, Revealed: 1, Confirmed: 2, Disputed: 3, Refuted: 4, Upheld: 5, Unadjudicated: 6, Withdrawn: 7 } as const;

export function clients(role: Role) {
  if (!MARKET_ADDRESS) throw new Error("MARKET_ADDRESS is not set");
  const account = privateKeyToAccount(keyFor(role));
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) });
  const market = getContract({ address: MARKET_ADDRESS, abi, client: { public: publicClient, wallet: walletClient } });
  return { role, account, publicClient, walletClient, market };
}

export async function send(publicClient: PublicClient, hashPromise: Promise<Hex>) {
  const hash = await hashPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
  return receipt;
}

export function txLink(hash: Hex) {
  return EXPLORER ? `${EXPLORER}/tx/${hash}` : hash;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
