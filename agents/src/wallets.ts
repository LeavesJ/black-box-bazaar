// agents/src/wallets.ts
// `gen` appends the six role keys (and the arbiter's address) to .env without ever rewriting a
// line that is already there and prints only addresses. `fund <eth>` sends each role that amount
// from the deployer and waits for every receipt. `balances` prints each role's address and balance.
// The env file is ../../.env relative to this module, or BAZAAR_ENV_FILE when set, which is how the
// unit test keeps its hands off the real one.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN, ROLES, ROLE_WALLETS, RPC_URL, keyFor, type Role } from "./config.ts";

export type Wallet = Exclude<Role, "deployer">;
export type RoleKeys = Record<Wallet, Hex>;

export function envFile(): string {
  return process.env.BAZAAR_ENV_FILE || fileURLToPath(new URL("../../.env", import.meta.url));
}

const keyName = (role: Wallet) => `${role.toUpperCase()}_KEY`;

/// The value a dotenv file assigns to `name`, or null when the line is absent or empty. The last
/// assignment wins, as it does for Node's --env-file.
export function valueOf(text: string, name: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === name) found = m[2]!.replace(/^(['"])(.*)\1$/, "$2") || null;
  }
  return found;
}

export type GenPlan = { lines: string[]; written: string[]; skipped: string[]; addresses: Record<Wallet, Hex> };

/// What gen appends, given the file's current text and a fresh key per role. Pure, so the
/// never-overwrite rule is tested without a file. A key already assigned a value is kept and its
/// address is still reported; an empty placeholder such as `BUYER_KEY=` (as .env.example ships) is
/// not rewritten either: the filled line goes after it and the later line wins under --env-file.
export function planGen(text: string, keys: RoleKeys): GenPlan {
  const lines: string[] = [], written: string[] = [], skipped: string[] = [];
  const addresses = {} as Record<Wallet, Hex>;
  for (const role of ROLE_WALLETS) {
    const name = keyName(role);
    const existing = valueOf(text, name);
    const key = (existing ?? keys[role]) as Hex;
    addresses[role] = privateKeyToAccount(key).address;
    if (existing !== null) { skipped.push(name); continue; }
    lines.push(`${name}=${key}`);
    written.push(name);
  }
  if (valueOf(text, "ARBITER_ADDRESS") !== null) skipped.push("ARBITER_ADDRESS");
  else { lines.push(`ARBITER_ADDRESS=${addresses.arbiter}`); written.push("ARBITER_ADDRESS"); }
  return { lines, written, skipped, addresses };
}

export function freshKeys(): RoleKeys {
  return Object.fromEntries(ROLE_WALLETS.map((r) => [r, generatePrivateKey()])) as RoleKeys;
}

export function gen(file = envFile(), keys = freshKeys()): GenPlan {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { /* a missing file is an empty one */ }
  const plan = planGen(text, keys);
  if (plan.lines.length) {
    const lead = text.length && !text.endsWith("\n") ? "\n" : "";
    appendFileSync(file, lead + plan.lines.join("\n") + "\n", { mode: 0o600 });
  }
  return plan;
}

const pub = () => createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

export async function fund(eth: string) {
  const amount = parseEther(eth);
  const account = privateKeyToAccount(keyFor("deployer"));
  const publicClient = pub();
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) });
  for (const role of ROLE_WALLETS) {
    const to = privateKeyToAccount(keyFor(role)).address;
    const hash = await wallet.sendTransaction({ to, value: amount });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`funding ${role} at ${to} reverted in ${hash}`);
    console.log(`${role} ${to} funded ${eth} ETH ${hash}`);
  }
}

export async function balances() {
  const publicClient = pub();
  for (const role of ROLES) {
    const address = privateKeyToAccount(keyFor(role)).address;
    console.log(`${role} ${address} ${formatEther(await publicClient.getBalance({ address }))} ETH`);
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "gen") {
    const plan = gen();
    for (const role of ROLE_WALLETS) console.log(`${role} ${plan.addresses[role]}`);
    console.log(`appended ${plan.lines.length} line(s) to ${envFile()}${plan.skipped.length ? `; kept ${plan.skipped.join(", ")}` : ""}`);
  } else if (cmd === "fund") await fund(process.argv[3] ?? "0.01");
  else if (cmd === "balances") await balances();
  else { console.error("usage: wallets.ts gen | fund [eth] | balances"); process.exit(2); }
}
