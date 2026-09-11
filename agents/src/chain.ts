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

/// The saleId of the Committed log carrying `commitHash`, or null. A seller that persisted its
/// material before sending and then lost the receipt recovers its sale id this way: the hash is
/// unique per claim (the contract refuses a duplicate), so one match is the sale.
export function saleIdFromCommittedLogs(logs: ReadonlyArray<{ args: { saleId?: bigint; commitHash?: Hex } }>, hash: Hex): bigint | null {
  for (const l of logs) {
    if (l.args.commitHash?.toLowerCase() === hash.toLowerCase() && l.args.saleId !== undefined) return l.args.saleId;
  }
  return null;
}

export type Windows = { reveal: bigint; adjudication: bigint; disclosure: bigint; arbitration: bigint };
export type SweepAction = "settle" | "expireCommit" | "withdrawSale" | "resolveUnarbitrated";

/// The four windows are immutable on the contract, so one read serves a whole run.
export async function readWindows(market: { read: Record<string, (...a: any[]) => Promise<unknown>> }): Promise<Windows> {
  const [reveal, adjudication, disclosure, arbitration] = await Promise.all([
    market.read.revealWindow!(), market.read.adjudicationWindow!(), market.read.disclosureWindow!(), market.read.arbitrationWindow!(),
  ]) as bigint[];
  return { reveal: reveal!, adjudication: adjudication!, disclosure: disclosure!, arbitration: arbitration! };
}

/// The disclosure sentinel is the timestamp, as in the contract: `disclose` refuses an empty
/// plaintext, so a length check would agree today, but the contract's own tests key on disclosedAt.
export const isDisclosed = (s: { disclosedAt: bigint }) => s.disclosedAt !== 0n;

/// Whether a watcher that failed to act on this sale should try again. The answer is the sale's own
/// window on the chain clock, never a strike count: a buyer may confirm or dispute until
/// revealedAt + adjudication, an arbiter may rule until disclosedAt + arbitration, and both windows
/// close strictly after the boundary, as the contract's `WindowClosed` check does. Any other state
/// is nothing a watcher can act on.
export function keepTrying(s: { state: number; revealedAt: bigint; disclosedAt: bigint }, now: bigint, w: Windows): boolean {
  if (s.state === S.Revealed) return now <= s.revealedAt + w.adjudication;
  if (s.state === S.Disputed) return isDisclosed(s) && now <= s.disclosedAt + w.arbitration;
  return false;
}

/// Reverts that settle the question for good. WrongState: someone else moved the sale. WindowClosed:
/// the chain clock passed the window between the read and the send. NotBuyer / NotArbiter: this
/// wallet was never the one to act. Anything else (RPC down, nonce, gas) is worth another send.
const FINAL_REVERTS = ["WrongState", "WindowClosed", "NotBuyer", "NotArbiter"] as const;
export function isTerminalRevert(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 8) return false;
  const o = e as Record<string, unknown>;
  for (const field of ["message", "shortMessage", "details", "data"]) {
    const v = o[field];
    if (typeof v === "string" && FINAL_REVERTS.some((name) => v.includes(name))) return true;
  }
  return isTerminalRevert(o.cause, depth + 1);
}

/// The sweep's whole decision, kept pure so every branch can be tested without a chain. `now` is
/// the chain clock: the contract judges each window by block.timestamp, never wall-clock.
export function sweepAction(
  s: { state: number; committedAt: bigint; revealedAt: bigint; disputedAt: bigint; disclosedAt: bigint },
  now: bigint, w: Windows,
): SweepAction | null {
  const disclosed = isDisclosed(s);
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
