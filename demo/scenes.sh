#!/usr/bin/env bash
# demo/scenes.sh — runs the four demo scenes against a deployed RefutationMarket.
# Six roles: buyer, seller, rogue, newcomer, quiet and arbiter. The sweep runs on the deployer wallet.
# Participants run concurrently; on-chain state, read with cast, drives the captions, and every count or
# headline a caption quotes is read from the chain at that moment, never written into this file.
# Captions go to demo/scene.txt as one JSON line {"caption","focus"} (record.mjs overlays the caption and
# scrolls the focused card into view) and to demo/timeline.json (cut.sh compresses the waits). A caption
# stays up at least MIN_DWELL seconds before the next may replace it, so none is written and never seen.
# The captions narrate an empty market, so the script refuses a chain that already holds claims or sales.
# Usage: MARKET_ADDRESS=0x… CHAIN=anvil|base-sepolia demo/scenes.sh [--allow-existing]
#   (address and chain default from docs/deployment.json; --allow-existing skips the empty-market check)
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

ALLOW_EXISTING=0
for arg in "$@"; do
  case "$arg" in
    --allow-existing) ALLOW_EXISTING=1 ;;
    *) echo "usage: [MARKET_ADDRESS=0x…] [CHAIN=anvil|base-sepolia] $0 [--allow-existing]" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AGENTS="$ROOT/agents"
LOGS="$HERE/logs"
SCENE="$HERE/scene.txt"
TIMELINE="$HERE/timeline.json"
DEPLOYMENT="$ROOT/docs/deployment.json"
MIN_DWELL="${MIN_DWELL:-4}"   # seconds a caption stays up before the next may replace it
LAST_CAPTION_AT=0             # unix time of the last caption write, fractional; caption() maintains it

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
REP_SIG='rep(address)(uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32)'
CLAIM_SIG='getClaim(uint256)((address,string,string,bytes32,uint256,uint32,uint32,uint32,uint64,bool))'
# SaleState indices, from the contract enum.
ST_CONFIRMED=2; ST_DISPUTED=3; ST_REFUTED=4; ST_UNADJUDICATED=6
# Sale tuple indices. The timestamps are persistent; the state is not, so waits key on timestamps where one exists.
F_SELLER=1; F_REVEALED_AT=6; F_DISPUTED_AT=7; F_DISCLOSED_AT=10; F_REASON=13; F_STATE=14

PIDS=()
# kill_tree <pid>: the leaves first, then the process; every pid here descends from one this script started.
kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done
  kill "$p" 2>/dev/null || true
}
cleanup() {
  local rc=$?
  trap - EXIT
  # END stops the recorder. After a caption it goes through caption(), so the last one keeps its dwell and the
  # timeline records it; before any caption (a refused start) it is written bare, so cut.sh sees no timeline.
  if [ "$LAST_CAPTION_AT" != 0 ]; then caption end END "" || printf '%s\n' '{"caption": "END", "focus": ""}' > "$SCENE"
  else printf '%s\n' '{"caption": "END", "focus": ""}' > "$SCENE"; fi
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill_tree "$p"; done
  wait 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

log() { printf '%s  %s\n' "$(date +%T)" "$*" >&2; }   # stderr: stdout of some callers is captured
die() { log "FAILED: $*"; caption fail "Demo failed: $*"; exit 1; }

# caption <scene> <text> [focus]: the moment a state is reached, show it and record when. focus names the card
# the caption is about, "sale:N", "claim:N" or "addr:0x…" (empty for none), and record.mjs scrolls to it.
# Waits until MIN_DWELL seconds have passed since the previous caption, so no caption is replaced unseen;
# the timeline entry carries the time of the actual write.
caption() {
  local scene="$1" text="$2" focus="${3:-}"
  LAST_CAPTION_AT="$(python3 - "$SCENE" "$TIMELINE" "$scene" "$text" "$focus" "$LAST_CAPTION_AT" "$MIN_DWELL" <<'PY'
import json, os, sys, time
scene_path, timeline, scene, text, focus, last, dwell = sys.argv[1:8]
wait = float(last) + float(dwell) - time.time()
if wait > 0:
    time.sleep(wait)
if focus.startswith("addr:"):
    focus = focus.lower()
now = time.time()
tmp = scene_path + ".tmp"
with open(tmp, "w") as f:
    f.write(json.dumps({"caption": text, "focus": focus}) + "\n")
os.replace(tmp, scene_path)   # one rename, so the recorder never reads a half-written line
entries = json.load(open(timeline)) if os.path.exists(timeline) and os.path.getsize(timeline) > 0 else []
entries.append({"scene": scene, "caption": text, "focus": focus, "t": now})
json.dump(entries, open(timeline, "w"), indent=1)
print(now)
PY
)"
  log "[scene $scene] $text"
}

# ---------- chain reads (cast, jq-free) ----------
ccall() { cast call "$MARKET_ADDRESS" "$@" --rpc-url "$RPC_URL"; }
sale_count() { ccall 'saleCount()(uint256)' | awk '{print $1}'; }
claim_count() { ccall 'claimCount()(uint256)' | awk '{print $1}'; }
window() { ccall "$1()(uint64)" | awk '{print $1}'; }
sale_field() { # <saleId> <tupleIndex>
  ccall "$SALE_SIG" "$1" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0][int(sys.argv[1])])' "$2"
}
sale_state() { sale_field "$1" "$F_STATE"; }
sale_reason() { sale_field "$1" "$F_REASON"; }
sale_seller() { sale_field "$1" "$F_SELLER"; }
claim_buyer() { ccall "$CLAIM_SIG" "$1" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0][0])'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
state_name() { case "$1" in 0) echo Committed ;; 1) echo Revealed ;; 2) echo Confirmed ;; 3) echo Disputed ;; 4) echo Refuted ;; 5) echo Upheld ;; 6) echo Unadjudicated ;; 7) echo Withdrawn ;; 8) echo Unarbitrated ;; *) echo "state $1" ;; esac; }
reason_name() { case "$1" in 0) echo "cannot decrypt" ;; 1) echo "commit mismatch" ;; 2) echo "not reproduced" ;; *) echo "reason $1" ;; esac; }
plural() { if [ "$1" = 1 ]; then echo "$1 $2"; else echo "$1 ${2}s"; fi; }
# onchain_phrase <claims> <sales> and sales_phrase <sales>: what the chain holds, in words, from counts just read.
onchain_phrase() { if [ "$1" = 0 ] && [ "$2" = 0 ]; then echo "nothing is on-chain yet"; else echo "$(plural "$1" claim) and $(plural "$2" sale) are already on-chain"; fi; }
sales_phrase() { if [ "$1" = 0 ]; then echo "No sale is on-chain yet."; else echo "$(plural "$1" sale) on-chain already."; fi; }
# sale_status <saleId>: one line for a failure message; survives a sale that cannot be read.
sale_status() {
  local id="$1" st r
  if st="$(sale_state "$id" 2>/dev/null)" && r="$(sale_reason "$id" 2>/dev/null)"; then
    echo "state $(state_name "$st") ($st), reason $(reason_name "$r"), revealedAt $(sale_field "$id" "$F_REVEALED_AT"), disputedAt $(sale_field "$id" "$F_DISPUTED_AT"), disclosedAt $(sale_field "$id" "$F_DISCLOSED_AT")"
  else
    echo "sale #$id cannot be read (saleCount $(sale_count 2>/dev/null || echo '?'))"
  fi
}
# rep_all <address>: the eight rep() counters on one line:
#   sellerConfirmed sellerRefuted sellerUnadjudicated sellerWithdrawn sellerUnarbitrated buyerAdjudicated buyerSilent buyerDisputesLost
rep_all() { ccall "$REP_SIG" "$1" --json | python3 -c 'import json,sys; print(" ".join(str(int(x)) for x in json.load(sys.stdin)))'; }
seller_confirmed() { rep_all "$1" | awk '{print $1}'; }
seller_unadjudicated() { rep_all "$1" | awk '{print $3}'; }
buyer_silent() { rep_all "$1" | awk '{print $7}'; }
# headline_for <address>: the settlement headline the page derives from rep(address), rule for rule.
headline_for() {
  local c r u w n rest
  read -r c r u w n rest <<< "$(rep_all "$1")"
  if [ "$c" -gt 0 ]; then echo "$c confirmed"
  elif [ "$r" -gt 0 ]; then echo "refuted history"
  elif [ "$w" -gt 0 ]; then echo "withdrawn history"
  elif [ "$n" -gt 0 ]; then echo "unarbitrated history"
  elif [ "$u" -gt 0 ]; then echo "unverified"
  else echo "no history"; fi
}
# role_address <role>: the address the agents resolve for a role, from their own wallet table (anvil accounts on
# anvil, .env keys elsewhere), so a wallet can be read before it has done anything on-chain. Prints addresses only.
role_address() { (cd "$AGENTS" && npm run -s wallets -- balances 2>/dev/null) | awk -v r="$1" '$1 == r { print $2 }'; }

# ---------- waits: every one times out, and a timeout prints the sale's state and reason before failing ----------
# wait_for <saleId> <timeoutSeconds> <what> <test…>: polls <test…> every 2 s until it passes.
wait_for() {
  local id="$1" limit="$2" what="$3" start=$SECONDS; shift 3
  until "$@"; do
    [ $((SECONDS - start)) -ge "$limit" ] && die "sale #$id: $what not reached in ${limit}s; $(sale_status "$id")"
    sleep 2
  done
}
is_state() { [ "$(sale_state "$1")" = "$2" ]; }
is_set() { [ "$(sale_field "$1" "$2")" != "0" ]; }
# A dispute is on record once disputedAt is set, or once the state has moved past Revealed into a disputed
# or settled state; the transient Disputed state itself is never required, since the arbiter may rule fast.
is_disputed() { [ "$(sale_field "$1" "$F_DISPUTED_AT")" != "0" ] || [ "$(sale_state "$1")" -ge "$ST_DISPUTED" ]; }
wait_state() { wait_for "$1" "$3" "state $(state_name "$2")" is_state "$1" "$2"; }           # terminal states only
wait_revealed() { wait_for "$1" "$2" "reveal (revealedAt set)" is_set "$1" "$F_REVEALED_AT"; }
wait_disputed() { wait_for "$1" "$2" "dispute (disputedAt set or state past Revealed)" is_disputed "$1"; }
wait_disclosed() { wait_for "$1" "$2" "disclosure (disclosedAt set)" is_set "$1" "$F_DISCLOSED_AT"; }
# wait_new_sale <countBefore> <role> <timeoutSeconds> -> prints the sale id.
# The id comes from the seller's own receipt (its "committed" log line); saleCount is only the trigger.
wait_new_sale() {
  local before="$1" role="$2" limit="$3" start=$SECONDS n id
  while :; do
    n="$(sale_count)"
    [ "$n" -gt "$before" ] && break
    [ $((SECONDS - start)) -ge "$limit" ] && die "$role made no sale within ${limit}s; saleCount still $n, last log line: $(tail -1 "$LOGS/$role.log" 2>/dev/null || echo none)"
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
# The scenes narrate an empty market ("nothing is on-chain yet", a first claim, a seller with one sale), so a
# chain that already holds claims or sales makes the captions false. Read both counts and refuse unless told not to.
C0="$(claim_count)"; S0="$(sale_count)"
if [ "$C0" != 0 ] || [ "$S0" != 0 ]; then
  if [ "$ALLOW_EXISTING" = 1 ]; then
    log "the market at $MARKET_ADDRESS already holds $C0 claims and $S0 sales; continuing under --allow-existing"
  else
    log "refusing to start: the market at $MARKET_ADDRESS already holds $C0 claims and $S0 sales, and the captions narrate an empty one. Start a fresh chain and redeploy, or pass --allow-existing."
    exit 1
  fi
fi
ADJ_WINDOW="$(window adjudicationWindow)"
log "market $MARKET_ADDRESS on $CHAIN via $RPC_URL · $C0 claims, $S0 sales · adjudication window ${ADJ_WINDOW}s"

run_bg arbiter arbiter -- watch --seconds 900
run_bg sweep sweep -- --seconds 900
caption 0 "Black Box Bazaar on $CHAIN: $(onchain_phrase "$C0" "$S0"). The arbiter is watching the market and the sweep runs on the deployer wallet."

# Scene 1 — honest sale, on the seller wallet
sleep "$MIN_DWELL"   # let the opening caption be true for its whole dwell before anything lands on chain
CLAIM_A="$(post_claim)"; [ -n "$CLAIM_A" ] || die "no CLAIM_ID from buyer post"
caption 1 "Scene 1 · Claim #$CLAIM_A posted: the buyer escrowed bounties for counterexamples to its claim about the pinned model." "claim:$CLAIM_A"
run_bg buyer buyer -- watch --claim "$CLAIM_A" --seconds 900
N0="$(sale_count)"
run_bg seller seller -- hunt --claim "$CLAIM_A" --max 1 --role seller --seconds 600
caption 1 "Scene 1 · The seller is probing the model for a pair it multiplies wrong. $(sales_phrase "$N0")"
S1="$(wait_new_sale "$N0" seller 420)"
SELLER_ADDR="$(sale_seller "$S1")"
caption 1 "Scene 1 · Sale #$S1: the seller committed a hash of its counterexample and posted a bond." "sale:$S1"
wait_revealed "$S1" 120
caption 1 "Scene 1 · Sale #$S1 revealed, encrypted to the buyer's key. The buyer decrypts, checks the commit and re-runs the test." "sale:$S1"
wait_state "$S1" "$ST_CONFIRMED" 240
caption 1 "Scene 1 · Sale #$S1 confirmed: the buyer reproduced the failure. The seller is paid and its card reads $(headline_for "$SELLER_ADDR") with $(seller_unadjudicated "$SELLER_ADDR") unadjudicated." "addr:$SELLER_ADDR"

# Scene 2 — planted pair, on the rogue wallet
N0="$(sale_count)"
run_bg rogue seller -- hunt --claim "$CLAIM_A" --max 1 --role rogue --attack plant --seconds 600
caption 2 "Scene 2 · A rogue wallet plants a pair the model gets right and sells it as a counterexample."
S2="$(wait_new_sale "$N0" rogue 420)"
wait_revealed "$S2" 120
caption 2 "Scene 2 · Sale #$S2 revealed. The buyer re-runs the test on the planted pair." "sale:$S2"
wait_disputed "$S2" 240
caption 2 "Scene 2 · Buyer disputed sale #$S2 with a bond: $(reason_name "$(sale_reason "$S2")"). The seller must disclose on-chain." "sale:$S2"
wait_disclosed "$S2" 120
caption 2 "Scene 2 · Disclosed. The pair is public now; the arbiter re-runs it five times." "sale:$S2"
wait_state "$S2" "$ST_REFUTED" 240
ROGUE_ADDR="$(sale_seller "$S2")"
caption 2 "Scene 2 · Refuted: the model was right. The rogue's bond goes to the buyer, the buyer's bond comes back, and the rogue wallet reads $(headline_for "$ROGUE_ADDR")." "addr:$ROGUE_ADDR"

# Scene 3 — garbage reveal, on the newcomer wallet
N0="$(sale_count)"
run_bg newcomer seller -- hunt --claim "$CLAIM_A" --max 1 --role newcomer --attack garbage --seconds 600
caption 3 "Scene 3 · A newcomer wallet commits a real counterexample but reveals garbage ciphertext."
S3="$(wait_new_sale "$N0" newcomer 420)"
wait_revealed "$S3" 120
caption 3 "Scene 3 · Sale #$S3 revealed. The buyer tries to decrypt it." "sale:$S3"
wait_disputed "$S3" 240
caption 3 "Scene 3 · Buyer disputed sale #$S3: $(reason_name "$(sale_reason "$S3")"). The seller discloses the real pair and its ephemeral secret." "sale:$S3"
wait_disclosed "$S3" 120
caption 3 "Scene 3 · Disclosed. The arbiter checks delivery before the model: does the secret reproduce the posted ciphertext?" "sale:$S3"
wait_state "$S3" "$ST_REFUTED" 240
caption 3 "Scene 3 · Refuted: the arbiter checked delivery before the model. A real pair, never delivered, earns nothing." "sale:$S3"

# Scene 4 — silent buyer, sold by the quiet wallet. Its headline is read before the sale and must be "no history".
CLAIM_B="$(post_claim)"; [ -n "$CLAIM_B" ] || die "no CLAIM_ID from second buyer post"
caption 4 "Scene 4 · Claim #$CLAIM_B posted. The buyer process only watches claim #$CLAIM_A; nobody will adjudicate this one." "claim:$CLAIM_B"
C_SELLER_BEFORE="$(seller_confirmed "$SELLER_ADDR")"
QUIET_ADDR="$(role_address quiet)"; [ -n "$QUIET_ADDR" ] || die "the agents' wallet table names no quiet wallet (npm run -s wallets -- balances)"
QUIET_BEFORE="$(headline_for "$QUIET_ADDR")"
[ "$QUIET_BEFORE" = "no history" ] || die "the quiet wallet $QUIET_ADDR reads \"$QUIET_BEFORE\" before its sale; the silent-buyer scene needs a wallet with no history"
N0="$(sale_count)"
run_bg quiet seller -- hunt --claim "$CLAIM_B" --max 1 --role quiet --seconds 600
S4="$(wait_new_sale "$N0" quiet 420)"
S4_SELLER="$(sale_seller "$S4")"
[ "$(lower "$S4_SELLER")" = "$(lower "$QUIET_ADDR")" ] || die "sale #$S4 was made by $S4_SELLER, not the quiet wallet $QUIET_ADDR"
wait_revealed "$S4" 120
caption 4 "Scene 4 · Sale #$S4 revealed on claim #$CLAIM_B by the quiet wallet, whose card reads $QUIET_BEFORE. The buyer stays silent." "sale:$S4"
if [ "$CHAIN" = "anvil" ]; then
  caption 4 "Scene 4 · The ${ADJ_WINDOW}s adjudication window passes (chain clock advanced) with no buyer action." "sale:$S4"
  sleep 2
  cast rpc evm_increaseTime "$((ADJ_WINDOW + 10))" --rpc-url "$RPC_URL" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
else
  caption 4 "Scene 4 · Waiting out the ${ADJ_WINDOW}s adjudication window with no buyer action." "sale:$S4"
fi
wait_state "$S4" "$ST_UNADJUDICATED" $((ADJ_WINDOW + 240))
C_SELLER_AFTER="$(seller_confirmed "$SELLER_ADDR")"
[ "$C_SELLER_AFTER" = "$C_SELLER_BEFORE" ] || die "the honest seller's confirmed count moved from $C_SELLER_BEFORE to $C_SELLER_AFTER during a sale it never made"
BUYER_ADDR="$(claim_buyer "$CLAIM_B")"
caption 4 "Scene 4 · Settled as unadjudicated: the quiet wallet is paid and the buyer's silent count is $(buyer_silent "$BUYER_ADDR"). The quiet wallet reads $(headline_for "$QUIET_ADDR"), with $(seller_unadjudicated "$QUIET_ADDR") unadjudicated and $(seller_confirmed "$QUIET_ADDR") confirmed. The honest seller still reads $C_SELLER_AFTER confirmed, unchanged. Silence is not evidence." "addr:$QUIET_ADDR"
sleep 6
log "all four scenes done: sales #$S1 #$S2 #$S3 #$S4"
