// agents/src/chain.ts
import { createPublicClient, createWalletClient, decodeEventLog, getContract, http, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import abi from "./abi.json" with { type: "json" };
import { CHAIN, EXPLORER, MARKET_ADDRESS, RPC_URL, keyFor, type Role } from "./config.ts";

export const STATE_NAMES = ["Committed", "Revealed", "Confirmed", "Disputed", "Refuted", "Upheld", "Unadjudicated", "Withdrawn", "Unarbitrated"] as const;
export const S = { Committed: 0, Revealed: 1, Confirmed: 2, Disputed: 3, Refuted: 4, Upheld: 5, Unadjudicated: 6, Withdrawn: 7, Unarbitrated: 8 } as const;
/// A sale is settled for good once it leaves Committed, Revealed and Disputed.
export const isTerminal = (state: number) => state !== S.Committed && state !== S.Revealed && state !== S.Disputed;
export const REASON_NAMES = ["CannotDecrypt", "CommitMismatch", "NotReproduced"] as const;
export const REASON = { CannotDecrypt: 0, CommitMismatch: 1, NotReproduced: 2 } as const;

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

type ReceiptLike = Pick<TransactionReceipt, "logs" | "transactionHash">;

/// The first log in the receipt, emitted by `address`, that decodes as `eventName`. A receipt is the
/// only place a sender can learn which sale or claim its own transaction created; a counter read
/// afterwards may already belong to someone else's transaction.
export function eventFromReceipt<T = Record<string, unknown>>(receipt: ReceiptLike, eventName: string, address: Hex = MARKET_ADDRESS): T | null {
  for (const l of receipt.logs) {
    if (address && l.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
      if (ev.eventName === eventName) return ev.args as T;
    } catch { /* not one of ours */ }
  }
  return null;
}

export function committedSaleIdFromReceipt(receipt: ReceiptLike, address: Hex = MARKET_ADDRESS): bigint {
  const args = eventFromReceipt<{ saleId: bigint }>(receipt, "Committed", address);
  if (!args) throw new Error(`no Committed event in receipt ${receipt.transactionHash}`);
  return args.saleId;
}

export type Windows = { reveal: bigint; adjudication: bigint; disclosure: bigint; arbitration: bigint };
export type SweepAction = "settle" | "expireCommit" | "withdrawSale" | "resolveUnarbitrated";

/// The sweep's whole decision, kept pure so every branch can be tested without a chain. `now` is
/// the chain clock: the contract judges each window by block.timestamp, never wall-clock.
export function sweepAction(
  s: { state: number; committedAt: bigint; revealedAt: bigint; disputedAt: bigint; disclosedAt: bigint; plaintext: string },
  now: bigint, w: Windows,
): SweepAction | null {
  const disclosed = s.plaintext !== "0x";
  if (s.state === S.Revealed && now > s.revealedAt + w.adjudication) return "settle";
  if (s.state === S.Committed && now > s.committedAt + w.reveal) return "expireCommit";
  if (s.state === S.Disputed && !disclosed && now > s.disputedAt + w.disclosure) return "withdrawSale";
  if (s.state === S.Disputed && disclosed && now > s.disclosedAt + w.arbitration) return "resolveUnarbitrated";
  return null;
}

export function txLink(hash: Hex) {
  return EXPLORER ? `${EXPLORER}/tx/${hash}` : hash;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
