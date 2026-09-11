#!/usr/bin/env bash
# scripts/export-abi.sh <address> <chainId> <deployedBlock>
# Copies the ABI beside the agents and the page, and writes docs/deployment.json.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
ADDR="${1:?address}"; CHAIN="${2:?chainId}"; BLOCK="${3:?deployedBlock}"
forge build >/dev/null 2>&1
mkdir -p agents/src docs
python3 - "$ADDR" "$CHAIN" "$BLOCK" <<'PY'
import json, sys
addr, chain, block = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
art = json.load(open("out/RefutationMarket.sol/RefutationMarket.json"))
abi = art["abi"]
json.dump(abi, open("agents/src/abi.json", "w"), indent=1)
json.dump(abi, open("docs/abi.json", "w"), indent=1)
rpc = "https://sepolia.base.org" if chain == 84532 else "http://127.0.0.1:8545"
explorer = "https://sepolia.basescan.org" if chain == 84532 else ""
json.dump({"chainId": chain, "address": addr, "rpc": rpc, "explorer": explorer, "deployedBlock": block},
          open("docs/deployment.json", "w"), indent=1)
print("wrote agents/src/abi.json docs/abi.json docs/deployment.json")
PY
