#!/usr/bin/env bash
# The whole Base Sepolia phase, in order, stopping at the first thing that fails:
#   1. deploy (scripts/deploy-testnet.sh): wallets, funding, contract, ABI, deployment.json
#   2. publish the page: commit docs/deployment.json and push so GitHub Pages serves it
#   3. record the four scenes against the testnet page served locally, then cut
#   4. fill the README placeholders, copy the video into media/, commit and push
# Rerunnable: each step checks its own precondition. Needs .env with a funded deployer.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC=https://sepolia.base.org
EXPLORER=https://sepolia.basescan.org
PAGE=https://leavesj.github.io/black-box-bazaar/
set -a; . ./.env; set +a
# A small bounty keeps the whole demo inside one faucet drip. The buyer escrows
# bounty x maxHits per claim; every bond is 20% of the bounty. Shell env wins over
# .env, so this reaches every agent scenes.sh starts.
export BOUNTY_ETH="${BOUNTY_ETH:-0.0001}"

step() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- 1. deploy
if ! grep -q '^MARKET_ADDRESS=0x' .env || [ "${CHAIN:-}" != "base-sepolia" ]; then
  step "deploy"
  ./scripts/deploy-testnet.sh
  set -a; . ./.env; set +a
else
  step "deploy: MARKET_ADDRESS already set, skipping"
fi
ADDR="$(grep '^MARKET_ADDRESS=' .env | cut -d= -f2)"
DEP_CHAIN="$(python3 -c "import json;print(json.load(open('docs/deployment.json'))['chainId'])")"
[ "$DEP_CHAIN" = "84532" ] || { echo "docs/deployment.json is not on Base Sepolia (chainId $DEP_CHAIN); run scripts/export-abi.sh $ADDR 84532 <block>" >&2; exit 1; }
grep -q '^POLL_MS=' .env || printf 'POLL_MS=5000\n' >> .env

# ---------------------------------------------------------------- 2. publish page
step "publish the page"
git add docs/deployment.json docs/abi.json
git diff --cached --quiet || git commit -q -m "deploy: RefutationMarket on Base Sepolia at $ADDR"
git push -q
for i in $(seq 1 24); do
  if curl -s "$PAGE/deployment.json" | grep -q "$(printf '%s' "$ADDR" | tr 'A-F' 'a-f')"; then echo "pages serves the testnet deployment"; break; fi
  sleep 10
done

# ---------------------------------------------------------------- 3. record
step "record"
: "${ANTHROPIC_API_KEY:?}"
if ! curl -s -o /dev/null http://localhost:8080/deployment.json; then
  (cd docs && python3 -m http.server 8080 >/dev/null 2>&1 &)
  sleep 2
fi
rm -f demo/out/raw.webm demo/out/bazaar-demo.mp4
(cd demo && node record.mjs "http://localhost:8080/?record=1" > out/record.log 2>&1 &)
for i in $(seq 1 30); do [ -f demo/out/record-start.json ] && break; sleep 1; done
./demo/scenes.sh > demo/out/scenes.log 2>&1
for i in $(seq 1 60); do [ -f demo/out/raw.webm ] && break; sleep 1; done
./demo/cut.sh
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 demo/out/bazaar-demo.mp4)"
echo "cut duration: $DUR s"

# ---------------------------------------------------------------- 4. README, media, publish
step "readme and media"
mkdir -p media
cp demo/out/bazaar-demo.mp4 media/bazaar-demo.mp4
sed -i '' "s|0xTHEADDRESS|$ADDR|g" README.md
sed -i '' "s|(video link)|[media/bazaar-demo.mp4](media/bazaar-demo.mp4) (recorded against Base Sepolia, $(printf '%.0f' "$DUR") s)|" README.md
git add README.md media/bazaar-demo.mp4
git diff --cached --quiet || git commit -q -m "docs: contract address, explorer link and the recorded demo"
git push -q
echo
echo "contract: $ADDR"
echo "explorer: $EXPLORER/address/$ADDR"
echo "page:     $PAGE"
echo "video:    media/bazaar-demo.mp4 ($DUR s)"
