#!/usr/bin/env bash
# One checked sequence for Base Sepolia: role wallets, funding, deploy, ABI export,
# and the page's deployment.json pointing at the new address. Refuses to start
# unless the deployer holds test ETH. Idempotent enough to rerun after a failure.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC=https://sepolia.base.org
set -a; . ./.env; set +a
: "${DEPLOYER_KEY:?DEPLOYER_KEY missing from .env}" "${DEPLOYER_ADDRESS:?DEPLOYER_ADDRESS missing from .env}"
bal="$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC")"
if [ "$bal" = "0" ]; then echo "deployer $DEPLOYER_ADDRESS holds no Base Sepolia ETH. Fund it from a faucet, then rerun." >&2; exit 1; fi
echo "deployer $DEPLOYER_ADDRESS balance $(cast from-wei "$bal") ETH"
grep -q '^CHAIN=base-sepolia' .env || printf 'CHAIN=base-sepolia\n' >> .env
if ! grep -q '^BUYER_KEY=' .env; then (cd agents && npm run -s wallets -- gen); fi
set -a; . ./.env; set +a
(cd agents && npm run -s wallets -- fund "${FUND_EACH:-0.01}")
W="${WINDOW:-60}"
ARBITER_ADDRESS="$ARBITER_ADDRESS" REVEAL_WINDOW="$W" ADJUDICATION_WINDOW="$W" DISCLOSURE_WINDOW="$W" ARBITRATION_WINDOW="$W" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast 2>&1 | grep -E 'MARKET_ADDRESS|ONCHAIN|Error' || true
J=broadcast/Deploy.s.sol/84532/run-latest.json
ADDR="$(python3 -c "import json;print(json.load(open('$J'))['receipts'][0]['contractAddress'])")"
BLK="$(python3 -c "import json;print(int(json.load(open('$J'))['receipts'][0]['blockNumber'],16))")"
sed -i '' '/^MARKET_ADDRESS=/d' .env; printf 'MARKET_ADDRESS=%s\n' "$ADDR" >> .env
./scripts/export-abi.sh "$ADDR" 84532 "$BLK"
echo "arbiter on chain: $(cast call "$ADDR" 'arbiter()(address)' --rpc-url "$RPC")"
echo "windows: $(cast call "$ADDR" 'adjudicationWindow()(uint64)' --rpc-url "$RPC") s"
ARGS="$(cast abi-encode 'c(address,uint64,uint64,uint64,uint64,uint256)' "$ARBITER_ADDRESS" "$W" "$W" "$W" "$W" 2000)"
forge verify-contract "$ADDR" src/RefutationMarket.sol:RefutationMarket --chain 84532 --verifier sourcify --constructor-args "$ARGS" 2>&1 | tail -2 || true
(cd agents && npm run -s wallets -- balances)
echo "deployed $ADDR at block $BLK"
echo "explorer: https://sepolia.basescan.org/address/$ADDR"
