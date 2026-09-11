#!/usr/bin/env bash
# demo/scenes.sh — runs the four demo scenes against a deployed RefutationMarket.
# Participants run concurrently; on-chain state, read with cast, drives the captions.
# Captions go to demo/scene.txt (record.mjs overlays them) and demo/timeline.json (cut.sh compresses the waits).
# Usage: MARKET_ADDRESS=0x… CHAIN=anvil|base-sepolia demo/scenes.sh   (both default from docs/deployment.json)
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AGENTS="$ROOT/agents"
LOGS="$HERE/logs"
SCENE="$HERE/scene.txt"
TIMELINE="$HERE/timeline.json"
DEPLOYMENT="$ROOT/docs/deployment.json"

dep_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$DEPLOYMENT" "$1"; }
if [ -z "${MARKET_ADDRESS:-}" ] && [ -f "$DEPLOYMENT" ]; then MARKET_ADDRESS="$(dep_field address)"; fi
if [ -z "${CHAIN:-}" ]; then
  if [ -f "$DEPLOYMENT" ] && [ "$(dep_field chainId)" = "84532" ]; then CHAIN=base-sepolia; else CHAIN=anvil; fi
fi
: "${MARKET_ADDRESS:?MARKET_ADDRESS is unset and docs/deployment.json has no address}"
if [ -z "${RPC_URL:-}" ]; then
  case "$CHAIN" in base-sepolia) RPC_URL=https://sepolia.base.org ;; *) RPC_URL=http://127.0.0.1:8545 ;; esac
fi
export MARKET_ADDRESS CHAIN RPC_URL

SALE_SIG='getSale(uint256)((uint256,address,bytes32,uint256,bytes,uint64,uint64,uint64,uint256,bytes,uint64,bytes32,bytes32,uint8,uint8))'
# SaleState indices, from the contract enum.
ST_REVEALED=1; ST_CONFIRMED=2; ST_DISPUTED=3; ST_REFUTED=4; ST_UNADJUDICATED=6
# Sale tuple indices.
F_DISCLOSED_AT=10; F_REASON=13; F_STATE=14
# DisputeReason indices.
R_CANNOT_DECRYPT=0; R_NOT_REPRODUCED=2

PIDS=()
cleanup() {
  local rc=$?
  echo END > "$SCENE"
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; }; done
  # npm wraps node; make sure no agent outlives the script.
  pkill -f -- '--env-file=../.env src/(buyer|seller|arbiter|sweep).ts' 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

log() { printf '%s  %s\n' "$(date +%T)" "$*" >&2; }   # stderr: stdout of some callers is captured
die() { log "FAILED: $*"; caption fail "Demo failed: $*"; exit 1; }

# caption <scene> <text>: the moment a state is reached, show it and record when.
caption() {
  local scene="$1" text="$2"
  printf '%s\n' "$text" > "$SCENE"
  python3 - "$TIMELINE" "$scene" "$text" <<'PY'
import json, os, sys, time
path, scene, text = sys.argv[1:4]
entries = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) > 0 else []
entries.append({"scene": scene, "caption": text, "t": int(time.time())})
json.dump(entries, open(path, "w"), indent=1)
PY
  log "[scene $scene] $text"
}

# ---------- chain reads (cast, jq-free) ----------
ccall() { cast call "$MARKET_ADDRESS" "$@" --rpc-url "$RPC_URL"; }
sale_count() { ccall 'saleCount()(uint256)' | awk '{print $1}'; }
window() { ccall "$1()(uint64)" | awk '{print $1}'; }
sale_field() { # <saleId> <tupleIndex>
  ccall "$SALE_SIG" "$1" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0][int(sys.argv[1])])' "$2"
}
sale_state() { sale_field "$1" "$F_STATE"; }
sale_reason() { sale_field "$1" "$F_REASON"; }

# wait_state <saleId> <state> <timeoutSeconds>
wait_state() {
  local id="$1" want="$2" limit="$3" start=$SECONDS st
  while :; do
    st="$(sale_state "$id")"
    [ "$st" = "$want" ] && return 0
    [ $((SECONDS - start)) -ge "$limit" ] && die "sale #$id is in state $st, wanted $want after ${limit}s"
    sleep 2
  done
}
# wait_disclosed <saleId> <timeoutSeconds>
wait_disclosed() {
  local id="$1" limit="$2" start=$SECONDS
  while [ "$(sale_field "$id" "$F_DISCLOSED_AT")" = "0" ]; do
    [ $((SECONDS - start)) -ge "$limit" ] && die "sale #$id was never disclosed within ${limit}s"
    sleep 2
  done
}
# wait_new_sale <countBefore> <role> <timeoutSeconds> -> prints the sale id.
# The id comes from the seller's own receipt (its "committed" log line); saleCount is only the trigger.
wait_new_sale() {
  local before="$1" role="$2" limit="$3" start=$SECONDS n id
  while :; do
    n="$(sale_count)"
    [ "$n" -gt "$before" ] && break
    [ $((SECONDS - start)) -ge "$limit" ] && die "$role made no sale within ${limit}s"
    sleep 2
  done
  id="$(python3 - "$LOGS/$role.log" "$before" <<'PY'
import json, sys
path, before = sys.argv[1], int(sys.argv[2])
found = ""
try:
    for line in open(path):
        try: o = json.loads(line)
        except ValueError: continue
        if o.get("event") == "committed" and int(o.get("saleId", -1)) >= before: found = str(o["saleId"])
except FileNotFoundError:
    pass
print(found)
PY
)"
  [ -n "$id" ] || id=$((n - 1))
  echo "$id"
}
reason_name() { case "$1" in 0) echo "cannot decrypt" ;; 1) echo "commit mismatch" ;; 2) echo "not reproduced" ;; *) echo "reason $1" ;; esac; }

# ---------- participants ----------
run_bg() { # <name> <npm args…>: background agent, stdout to logs/<name>.out (the JSON log goes to logs/<role>.log by itself)
  local name="$1"; shift
  ( cd "$AGENTS" && npm run -s "$@" ) > "$LOGS/$name.out" 2>&1 &
  PIDS+=("$!")
  log "started $name (pid $!)"
}
post_claim() {
  local out
  out="$(cd "$AGENTS" && npm run -s buyer -- post 2>&1)" || die "buyer post failed: $(echo "$out" | tail -3)"
  echo "$out" | grep -o 'CLAIM_ID=[0-9]*' | tail -1 | cut -d= -f2
}

# ---------- run ----------
mkdir -p "$LOGS"
rm -f "$LOGS"/*.log "$LOGS"/*.out "$TIMELINE"
: > "$SCENE"
ADJ_WINDOW="$(window adjudicationWindow)"
log "market $MARKET_ADDRESS on $CHAIN via $RPC_URL · adjudication window ${ADJ_WINDOW}s"

run_bg arbiter arbiter -- watch --seconds 900
run_bg sweep sweep -- --seconds 900
caption 0 "Black Box Bazaar on $CHAIN. The arbiter and the sweeper are watching the market."

# Scene 1 — honest sale
CLAIM_A="$(post_claim)"; [ -n "$CLAIM_A" ] || die "no CLAIM_ID from buyer post"
caption 1 "Scene 1 · Claim #$CLAIM_A posted: the buyer escrowed bounties for counterexamples to its claim about the pinned model."
run_bg buyer buyer -- watch --claim "$CLAIM_A" --seconds 900
N0="$(sale_count)"
run_bg seller seller -- hunt --claim "$CLAIM_A" --max 1 --role seller --seconds 600
caption 1 "Scene 1 · The seller is probing the model for a pair it multiplies wrong. Nothing is on-chain yet."
S1="$(wait_new_sale "$N0" seller 420)"
caption 1 "Scene 1 · Sale #$S1: the seller committed a hash of its counterexample and posted a bond."
wait_state "$S1" "$ST_REVEALED" 120
caption 1 "Scene 1 · Sale #$S1 revealed, encrypted to the buyer's key. The buyer decrypts, checks the commit and re-runs the test."
wait_state "$S1" "$ST_CONFIRMED" 240
caption 1 "Scene 1 · Sale #$S1 confirmed: the buyer reproduced the failure. Seller paid and now reads 1 confirmed."

# Scene 2 — planted pair
N0="$(sale_count)"
run_bg rogue seller -- hunt --claim "$CLAIM_A" --max 1 --role rogue --attack plant --seconds 600
caption 2 "Scene 2 · A rogue wallet plants a pair the model gets right and sells it as a counterexample."
S2="$(wait_new_sale "$N0" rogue 420)"
wait_state "$S2" "$ST_REVEALED" 120
caption 2 "Scene 2 · Sale #$S2 revealed. The buyer re-runs the test on the planted pair."
wait_state "$S2" "$ST_DISPUTED" 240
caption 2 "Scene 2 · Buyer disputed sale #$S2 with a bond: $(reason_name "$(sale_reason "$S2")"). The seller must disclose on-chain."
wait_disclosed "$S2" 120
caption 2 "Scene 2 · Disclosed. The pair is public now; the arbiter re-runs it five times."
wait_state "$S2" "$ST_REFUTED" 240
caption 2 "Scene 2 · Refuted: the model was right. The rogue's bond goes to the buyer, the buyer's bond comes back, and the record says refuted."

# Scene 3 — garbage reveal by a newcomer
N0="$(sale_count)"
run_bg newcomer seller -- hunt --claim "$CLAIM_A" --max 1 --role newcomer --attack garbage --seconds 600
caption 3 "Scene 3 · A newcomer wallet commits a real counterexample but reveals garbage ciphertext."
S3="$(wait_new_sale "$N0" newcomer 420)"
wait_state "$S3" "$ST_REVEALED" 120
caption 3 "Scene 3 · Sale #$S3 revealed. The buyer tries to decrypt it."
wait_state "$S3" "$ST_DISPUTED" 240
caption 3 "Scene 3 · Buyer disputed sale #$S3: $(reason_name "$(sale_reason "$S3")"). The seller discloses the real pair and its ephemeral secret."
wait_disclosed "$S3" 120
caption 3 "Scene 3 · Disclosed. The arbiter checks delivery before the model: does the secret reproduce the posted ciphertext?"
wait_state "$S3" "$ST_REFUTED" 240
caption 3 "Scene 3 · Refuted: the arbiter checked delivery before the model. A real pair, never delivered, earns nothing."

# Scene 4 — silent buyer
CLAIM_B="$(post_claim)"; [ -n "$CLAIM_B" ] || die "no CLAIM_ID from second buyer post"
caption 4 "Scene 4 · Claim #$CLAIM_B posted. The buyer process only watches claim #$CLAIM_A; nobody will adjudicate this one."
N0="$(sale_count)"
run_bg seller2 seller -- hunt --claim "$CLAIM_B" --max 1 --role seller --seconds 600
S4="$(wait_new_sale "$N0" seller 420)"
wait_state "$S4" "$ST_REVEALED" 120
caption 4 "Scene 4 · Sale #$S4 revealed on claim #$CLAIM_B by the seller from scene 1. The buyer stays silent."
if [ "$CHAIN" = "anvil" ]; then
  cast rpc evm_increaseTime "$((ADJ_WINDOW + 10))" --rpc-url "$RPC_URL" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
  caption 4 "Scene 4 · The ${ADJ_WINDOW}s adjudication window passes (chain clock advanced) with no buyer action."
else
  caption 4 "Scene 4 · Waiting out the ${ADJ_WINDOW}s adjudication window with no buyer action."
fi
wait_state "$S4" "$ST_UNADJUDICATED" $((ADJ_WINDOW + 240))
caption 4 "Scene 4 · Settled as unadjudicated: the seller is paid, the buyer's silent count rises, and the seller still reads 1 confirmed. The unadjudicated sale did not move its confirmed count. Silence is not evidence."
sleep 6
caption end "END"
log "all four scenes done: sales #$S1 #$S2 #$S3 #$S4"
