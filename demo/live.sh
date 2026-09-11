#!/usr/bin/env bash
# demo/live.sh — the four scenes, live, on a fresh local chain, with the page open in your browser.
# For a live walkthrough in front of people: no recorder, no cut, about three minutes with real
# model calls. Every run starts a fresh chain, so the opening "the market is empty" is always true.
#
# Needs: Foundry (anvil, cast, forge), Node 26, and .env with ANTHROPIC_API_KEY. The roles are anvil's
# own accounts, so no wallets or funding are needed. Nothing here touches the testnet or any committed file.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
PORT="${LIVE_PORT:-8546}"; SITE_PORT="${LIVE_SITE_PORT:-8082}"
set -a; . ./.env; set +a
export CHAIN=anvil RPC_URL="http://127.0.0.1:$PORT" BOUNTY_ETH="${BOUNTY_ETH:-0.0005}" EPILOGUE=0
: "${ANTHROPIC_API_KEY:?add ANTHROPIC_API_KEY to .env}"

mkdir -p demo/out/site-live
PIDFILE=demo/out/live-anvil.pid
# A fresh chain every run: stop the one this script started last time, then start another.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then kill "$(cat "$PIDFILE")"; sleep 1; fi
anvil --silent --port "$PORT" --block-time 1 > demo/out/live-anvil.log 2>&1 &
echo $! > "$PIDFILE"
for i in $(seq 1 30); do cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 1; done

# On a local chain the agents use anvil's own pre-funded accounts (agents/src/config.ts, keyFor):
# deployer = account 0, buyer 1, seller 2, rogue 3, newcomer 4, arbiter 5, quiet 6. So the contract's
# arbiter must be account 5, and nothing needs funding.
DEPLOYER0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ARBITER5=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
ARBITER_ADDRESS="$ARBITER5" REVEAL_WINDOW=60 ADJUDICATION_WINDOW=60 DISCLOSURE_WINDOW=60 ARBITRATION_WINDOW=60 \
  forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER0" --broadcast >/dev/null 2>&1
J=broadcast/Deploy.s.sol/31337/run-latest.json
export MARKET_ADDRESS="$(python3 -c "import json;print(json.load(open('$J'))['receipts'][0]['contractAddress'])")"
BLK="$(python3 -c "import json;print(int(json.load(open('$J'))['receipts'][0]['blockNumber'],16))")"

# The page, served from a scratch copy that points at this chain; docs/deployment.json stays the testnet one.
cp docs/index.html docs/app.js docs/abi.json demo/out/site-live/
printf '{"chainId": 31337, "address": "%s", "rpc": "%s", "explorer": "", "deployedBlock": %s}\n' "$MARKET_ADDRESS" "$RPC_URL" "$BLK" > demo/out/site-live/deployment.json
if ! curl -s -o /dev/null "http://localhost:$SITE_PORT/deployment.json"; then
  (cd demo/out/site-live && python3 -m http.server "$SITE_PORT" >/dev/null 2>&1 &); sleep 1
fi

echo
echo "market $MARKET_ADDRESS on a fresh local chain"
echo "page:   http://localhost:$SITE_PORT/"
command -v open >/dev/null 2>&1 && open "http://localhost:$SITE_PORT/" || true
echo
echo "arrange the windows, then press return to start the four scenes"
read -r _
./demo/scenes.sh
