#!/usr/bin/env bash
# demo/scenes.sh — runs the four demo scenes against a deployed RefutationMarket.
# Six roles: buyer, seller, rogue, newcomer, quiet and arbiter. The sweep runs on the deployer wallet.
# Participants run concurrently; on-chain state, read with cast, drives the captions, and every count or
# headline a caption quotes is read from the chain (or the agents' own logs) at that moment, never written here.
# Each scene line goes to demo/scene.txt as one JSON object,
#   {"caption","note","focus","label","color","step","scene","title","subtitle","goto","card_s"}
# and to demo/timeline.json with its write time "t" (cut.sh compresses the waits). record.mjs overlays the caption
# and note, a scene badge, a step tracker, a title card for a line with "title", and a callout on the card "focus"
# names (sale:N, claim:N or addr:0x…) tagged with "label" in "color". A caption stays up MIN_DWELL seconds before
# the next line may replace it (a title card covers the page TITLE_S seconds first, or "card_s" seconds when that
# is set, and the caption under it gets its dwell after the card ends); a pure title card holds only for its own
# length. The agents are paced by DEMO_STEP_MS (a wait before every state-changing send) so the chain does not run
# ahead of the captions. A claim is posted, and a hunt started, before the scene card that introduces it, so the
# card lifts onto a caption that already has its card on the page to point at.
# The captions narrate an empty market, so the script refuses a chain that already holds claims or sales.
# Usage: MARKET_ADDRESS=0x… CHAIN=anvil|base-sepolia [EPILOGUE=1] demo/scenes.sh [--allow-existing]
#   (address and chain default from docs/deployment.json; --allow-existing skips the empty-market check;
#    EPILOGUE=1 visits the live page named by LIVE_PAGE before the final card, with the sales counted from the
#    deployment named by docs/deployment.json)
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
# Every agent waits this long before a state-changing send (agents/src/config.ts DEMO_STEP_MS), so each step lands
# about one caption dwell after the last. Overridable; 0 is the agents' own pace.
export DEMO_STEP_MS="${DEMO_STEP_MS:-8000}"

ALLOW_EXISTING=0
for arg in "$@"; do
  case "$arg" in
    --allow-existing) ALLOW_EXISTING=1 ;;
    *) echo "usage: [MARKET_ADDRESS=0x…] [CHAIN=anvil|base-sepolia] [EPILOGUE=1] $0 [--allow-existing]" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AGENTS="$ROOT/agents"
LOGS="${LOGS_DIR:-$HERE/logs}"; export LOG_DIR="$LOGS"   # the agents write logs/<role>.log here (agents/src/log.ts)
SCENE="${SCENE_FILE:-$HERE/scene.txt}"
TIMELINE="${TIMELINE_FILE:-$HERE/timeline.json}"
# The presenter (demo/console.mjs): with PRESENT=1 the run holds before each scene until go.<n> appears under
# PRESENT_DIR, and status.json there says which scene is waiting, running, and done.
PRESENT="${PRESENT:-0}"
PRESENT_DIR="${PRESENT_DIR:-$HERE/out/present}"
PRESENT_DONE=""
DEPLOYMENT="$ROOT/docs/deployment.json"
MIN_DWELL="${MIN_DWELL:-7}"   # seconds a caption stays up before the next line may replace it
TITLE_S="${TITLE_S:-3.5}"     # seconds a title card covers the page (record.mjs TITLE_MS; keep them equal)
CARD_PAD="${CARD_PAD:-0.5}"   # a pure title card holds TITLE_S + CARD_PAD, so the next caption lands as it lifts
NAV_ALLOW="${NAV_ALLOW:-5}"   # seconds added to an epilogue hold for the recorder's page load
FINAL_S="${FINAL_S:-5}"       # seconds the final card holds before END
LIVE_PAGE="${LIVE_PAGE:-https://leavesj.github.io/black-box-bazaar/}"   # the epilogue's first stop
EPILOGUE="${EPILOGUE:-0}"
NEXT_AT=0                     # unix time before which no scene line may be written; emit() maintains it

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
# Claim tuple indices.
CF_BUYER=0; CF_MAX_HITS=5

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
  # END stops the recorder. After a scene line it goes through emit(), so the last one keeps its dwell and the
  # timeline records it; before any line (a refused start) it is written bare, so cut.sh sees no timeline.
  if [ "$NEXT_AT" != 0 ]; then emit 0 END "" "" "" "" "" "" "" "" 0 || printf '%s\n' '{"caption": "END", "focus": ""}' > "$SCENE"
  else printf '%s\n' '{"caption": "END", "focus": ""}' > "$SCENE"; fi
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill_tree "$p"; done
  wait 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

log() { printf '%s  %s\n' "$(date +%T)" "$*" >&2; }   # stderr: stdout of some callers is captured
die() { log "FAILED: $*"; caption 0 "" red "" "" "Demo failed: $*"; exit 1; }

# emit <scene> <caption> <note> <focus> <label> <color> <step> <title> <subtitle> <goto> <hold> [card_s]: the moment
# a state is reached, write one scene line and record when. Waits until the previous line's hold has passed, so no
# caption is replaced unseen, then holds this one for <hold> seconds (a line with a title and a caption adds
# TITLE_S, since its caption is only seen once the card lifts). <card_s> is how long the recorder keeps a title card
# up, 0 for its default. The timeline entry carries the time of the actual write.
emit() {
  NEXT_AT="$(python3 - "$SCENE" "$TIMELINE" "$NEXT_AT" "$TITLE_S" "$@" <<'PY'
import json, os, sys, time
scene_path, timeline, next_at, title_s = sys.argv[1:5]
scene, caption, note, focus, label, color, step, title, subtitle, goto, hold = sys.argv[5:16]
card_s = float(sys.argv[16]) if len(sys.argv) > 16 and sys.argv[16] else 0.0
wait = float(next_at) - time.time()
if wait > 0:
    time.sleep(wait)
if focus.startswith("addr:"):
    focus = focus.lower()
try:
    scene = int(scene)
except ValueError:
    scene = 0
line = {"caption": caption, "note": note, "focus": focus, "label": label, "color": color, "step": step,
        "scene": scene, "title": title, "subtitle": subtitle, "goto": goto, "card_s": card_s}
now = time.time()
tmp = scene_path + ".tmp"
with open(tmp, "w") as f:
    f.write(json.dumps(line) + "\n")
os.replace(tmp, scene_path)   # one rename, so the recorder never reads a half-written line
entries = json.load(open(timeline)) if os.path.exists(timeline) and os.path.getsize(timeline) > 0 else []
entries.append({**line, "t": now})
json.dump(entries, open(timeline, "w"), indent=1)
hold = float(hold) + (float(title_s) if title and caption else 0.0)
print(now + hold)
PY
)"
}
# present_status <waiting> <running>: the presenter's view of this run; a no-op unless PRESENT=1.
present_status() {
  [ "$PRESENT" = 1 ] || return 0
  printf '{"waiting": %s, "running": %s, "done": [%s]}\n' "${1:-null}" "${2:-null}" "$PRESENT_DONE" > "$PRESENT_DIR/status.json"
}
# gate <scene>: with PRESENT=1, hold here until the presenter's Run button for this scene is pressed.
gate() {
  [ "$PRESENT" = 1 ] || return 0
  present_status "$1" null
  log "[present] holding before scene $1 until $PRESENT_DIR/go.$1 appears"
  until [ -f "$PRESENT_DIR/go.$1" ]; do sleep 0.5; done
  present_status null "$1"
}
# scene_done <scene>: the scene is over; the presenter may offer the next.
scene_done() {
  [ "$PRESENT" = 1 ] || return 0
  PRESENT_DONE="${PRESENT_DONE:+$PRESENT_DONE, }$1"
  present_status null null
}
# caption <scene> <step> <color> <focus> <label> <text> [note]: one narrated step, held MIN_DWELL.
caption() {
  local scene="$1" step="$2" color="$3" focus="$4" label="$5" text="$6" note="${7:-}"
  emit "$scene" "$text" "$note" "$focus" "$label" "$color" "$step" "" "" "" "$MIN_DWELL"
  log "[scene $scene] $text"
}
# card <scene> <title> <subtitle> [hold] [card_s]: a title card and nothing under it, held for its own length
# (TITLE_S + CARD_PAD, so the next caption lands as the recorder lifts it) unless <hold> says otherwise; <card_s>
# keeps the recorder's card up that long instead of TITLE_S.
card() {
  local hold="${4:-$(python3 -c 'import sys; print(float(sys.argv[1]) + float(sys.argv[2]))' "$TITLE_S" "$CARD_PAD")}"
  emit "$1" "" "" "" "" "" "" "$2" "$3" "" "$hold" "${5:-0}"
  log "[scene $1] ── $2 — $3"
}
# goto_caption <url> <text> <seconds>: the epilogue; the recorder loads the URL, then shows the caption <seconds>.
goto_caption() {
  emit 0 "$2" "" "" "" grey "" "" "" "$1" "$(( $3 + NAV_ALLOW ))"
  log "[epilogue] $1 · $2"
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
chain_name() { case "$1" in 84532) echo "Base Sepolia" ;; 31337) echo "anvil" ;; *) echo "chain $1" ;; esac; }
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

# ---------- counts the captions quote: chain fields, agent logs, words ----------
claim_field() { ccall "$CLAIM_SIG" "$1" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0][int(sys.argv[1])])' "$2"; }   # <claimId> <tupleIndex>
# word <n>: a small count in words, as a caption reads it; larger counts stay digits.
word() { case "$1" in 0) echo zero ;; 1) echo one ;; 2) echo two ;; 3) echo three ;; 4) echo four ;; 5) echo five ;; 6) echo six ;; 7) echo seven ;; 8) echo eight ;; 9) echo nine ;; 10) echo ten ;; *) echo "$1" ;; esac; }
# log_field <role> <saleId> <event-regex> <field>: that field from the latest matching line of logs/<role>.log, or "".
# The buyer's "re-run result" and the arbiter's "ruled: …" lines carry runs and wrong, the counts a re-run caption quotes.
log_field() {
  python3 - "$LOGS/$1.log" "$2" "$3" "$4" <<'PY'
import json, re, sys
path, sale, pattern, field = sys.argv[1:5]
found = ""
try:
    for line in open(path):
        try: o = json.loads(line)
        except ValueError: continue
        if str(o.get("saleId", "")) == sale and re.search(pattern, str(o.get("event", ""))) and field in o:
            found = str(o[field])
except FileNotFoundError:
    pass
print(found)
PY
}
# wait_log <role> <saleId> <event-regex> <field> <seconds>: waits up to <seconds> for that log line. A line that
# reports a transaction lands once its receipt is in, a moment after the chain state a wait keyed on; the arbiter's
# "ruled: …" is one. Never fails: the caller falls back to a count read from the agents' source.
wait_log() {
  local start=$SECONDS
  until [ -n "$(log_field "$1" "$2" "$3" "$4")" ]; do
    [ $((SECONDS - start)) -ge "$5" ] && return 0
    sleep 0.5
  done
}
# config_const <NAME>: an integer constant from agents/src/config.ts, so a caption never carries a typed count.
config_const() { grep -oE "^export const $1 = [0-9]+;" "$AGENTS/src/config.ts" | grep -oE '[0-9]+' | tail -1; }
# runs_phrase <role> <saleId> <event-regex> <subject> [fallback]: "re-runs <subject> N times" with N from the log,
# else from <fallback> (a count read from the agents' config, never typed here), else without N.
runs_phrase() {
  local n; n="$(log_field "$1" "$2" "$3" runs)"
  [ -n "$n" ] || n="${5:-}"
  if [ -n "$n" ]; then echo "re-runs $4 $(word "$n") times"; else echo "re-runs $4"; fi
}
# live_sales_phrase: the deployed market's sales, counted and named from that chain, for the epilogue; "" if unreadable.
live_sales_phrase() {
  local addr rpc n i states=() st
  addr="$(dep_field address)"; rpc="$(dep_field rpc)"
  [ -n "$addr" ] && [ -n "$rpc" ] || return 0
  n="$(cast call "$addr" 'saleCount()(uint256)' --rpc-url "$rpc" --chain "$(dep_field chainId)" 2>/dev/null | awk '{print $1}')" || return 0
  [ -n "$n" ] && [ "$n" -gt 0 ] 2>/dev/null || return 0
  for ((i = 0; i < n; i++)); do
    st="$(cast call "$addr" "$SALE_SIG" "$i" --rpc-url "$rpc" --chain "$(dep_field chainId)" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)[0][int(sys.argv[1])])' "$F_STATE")" || return 0
    states+=("$(lower "$(state_name "$st")")")
  done
  python3 - "$(word "$n")" "${states[@]}" <<'PY'
import sys
n, *st = sys.argv[1:]
print(f"{n.capitalize()} real {'sale' if len(st) == 1 else 'sales'}: {', '.join(st)}.")
PY
}

# ---------- run ----------
mkdir -p "$LOGS"
rm -f "$LOGS"/*.log "$LOGS"/*.out "$TIMELINE"
: > "$SCENE"
# The scenes narrate an empty market (a first claim, a seller with one sale), so a chain that already holds
# claims or sales makes the captions false. Read both counts and refuse unless told not to.
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
card 0 "Black Box Bazaar" "A market where agents sell counterexamples the buyer cannot see until it has paid."
caption 0 "" grey "" "" "The market is $( [ "$C0" = 0 ] && [ "$S0" = 0 ] && echo empty || echo "not empty: $(onchain_phrase "$C0" "$S0")" ). The arbiter is watching. The sweep runs on the deployer wallet." "Every count on screen is read from the chain as it happens."

# Scene 1 — honest sale, on the seller wallet. The claim is posted before the card, so the card lifts onto its caption.
gate 1
CLAIM_A="$(post_claim)"; [ -n "$CLAIM_A" ] || die "no CLAIM_ID from buyer post"
card 1 "Scene 1 · An honest sale" "The buyer posts a claim. The seller finds a counterexample. The buyer checks it and pays."
caption 1 claim blue "claim:$CLAIM_A" "THE CLAIM" "The buyer posts a claim: this model multiplies three-digit numbers correctly. It escrows $(word "$(claim_field "$CLAIM_A" "$CF_MAX_HITS")") bounties."
run_bg buyer buyer -- watch --claim "$CLAIM_A" --seconds 900
N0="$(sale_count)"
SELLER_ADDR="$(role_address seller)"; [ -n "$SELLER_ADDR" ] || die "the agents' wallet table names no seller wallet (npm run -s wallets -- balances)"
run_bg seller seller -- hunt --claim "$CLAIM_A" --max 1 --role seller --seconds 600
S1="$(wait_new_sale "$N0" seller 420)"
[ "$(lower "$(sale_seller "$S1")")" = "$(lower "$SELLER_ADDR")" ] || die "sale #$S1 was made by $(sale_seller "$S1"), not the seller wallet $SELLER_ADDR"
caption 1 commit green "sale:$S1" "SELLER" "The seller asks the model random pairs until it gets one wrong. It commits a hash of that pair and posts a bond."
wait_revealed "$S1" 120
caption 1 reveal green "sale:$S1" "SALE #$S1" "The seller reveals the pair, encrypted to the buyer's key. Only the buyer can read it."
wait_state "$S1" "$ST_CONFIRMED" 240
caption 1 adjudicate blue "sale:$S1" "SALE #$S1" "The buyer decrypts it, checks the hash, and $(runs_phrase buyer "$S1" '^re-run result$' "the model"). It fails every time. Confirmed."
caption 1 settle green "addr:$SELLER_ADDR" "SELLER'S CARD" "The seller is paid and its bond comes back. Its card reads $(headline_for "$SELLER_ADDR")." "Confirmed means the buyer checked. That is the only way this number moves."
scene_done 1

# Scene 2 — planted pair, on the rogue wallet. The hunt starts under scene 1's last caption, so its sale is usually
# on-chain when the card lifts, and the commit caption has a sale card to point at.
gate 2
N0="$(sale_count)"
ROGUE_ADDR="$(role_address rogue)"; [ -n "$ROGUE_ADDR" ] || die "the agents' wallet table names no rogue wallet (npm run -s wallets -- balances)"
run_bg rogue seller -- hunt --claim "$CLAIM_A" --max 1 --role rogue --attack plant --seconds 600
card 2 "Scene 2 · A planted pair" "A rogue seller sells a pair the model gets right."
S2="$(wait_new_sale "$N0" rogue 420)"
[ "$(lower "$(sale_seller "$S2")")" = "$(lower "$ROGUE_ADDR")" ] || die "sale #$S2 was made by $(sale_seller "$S2"), not the rogue wallet $ROGUE_ADDR"
caption 2 commit red "sale:$S2" "ROGUE" "The rogue picks a pair the model answers correctly and sells it anyway."
wait_revealed "$S2" 120
caption 2 reveal red "sale:$S2" "SALE #$S2" "Sale #$S2 is revealed. The buyer re-runs it."
wait_disputed "$S2" 240
caption 2 dispute blue "sale:$S2" "SALE #$S2" "The model is right every time. The buyer disputes and posts a bond: $(reason_name "$(sale_reason "$S2")")."
wait_disclosed "$S2" 120
caption 2 dispute red "sale:$S2" "SALE #$S2" "The rogue must disclose the pair on-chain. It is public now."
wait_state "$S2" "$ST_REFUTED" 240
wait_log arbiter "$S2" '^ruled:' runs 8
caption 2 rule purple "sale:$S2" "ARBITER" "The arbiter $(runs_phrase arbiter "$S2" '^ruled:' "it" "$(config_const ARBITER_RUNS)"). Right every time. $(state_name "$(sale_state "$S2")")."
caption 2 settle red "addr:$ROGUE_ADDR" "ROGUE'S CARD" "The rogue's bond goes to the buyer. Its card reads $(headline_for "$ROGUE_ADDR")." "A refutation stays on the record."
scene_done 2

# Scene 3 — garbage reveal, on the newcomer wallet. The hunt starts under scene 2's last caption, as in scene 2.
gate 3
N0="$(sale_count)"
NEWCOMER_ADDR="$(role_address newcomer)"; [ -n "$NEWCOMER_ADDR" ] || die "the agents' wallet table names no newcomer wallet (npm run -s wallets -- balances)"
run_bg newcomer seller -- hunt --claim "$CLAIM_A" --max 1 --role newcomer --attack garbage --seconds 600
card 3 "Scene 3 · A real pair, never delivered" "The seller commits to a real counterexample but reveals garbage."
S3="$(wait_new_sale "$N0" newcomer 420)"
[ "$(lower "$(sale_seller "$S3")")" = "$(lower "$NEWCOMER_ADDR")" ] || die "sale #$S3 was made by $(sale_seller "$S3"), not the newcomer wallet $NEWCOMER_ADDR"
caption 3 commit orange "sale:$S3" "NEWCOMER" "A newcomer finds a real counterexample and commits to it honestly."
wait_revealed "$S3" 120
caption 3 reveal orange "sale:$S3" "SALE #$S3" "But it reveals random bytes instead of the encrypted pair."
wait_disputed "$S3" 240
caption 3 dispute blue "sale:$S3" "SALE #$S3" "The buyer cannot decrypt it and disputes: $(reason_name "$(sale_reason "$S3")")."
wait_disclosed "$S3" 120
caption 3 dispute orange "sale:$S3" "SALE #$S3" "The newcomer discloses the real pair, the salt, and the key it used to encrypt."
wait_state "$S3" "$ST_REFUTED" 240
caption 3 rule purple "sale:$S3" "ARBITER" "The arbiter checks delivery first: does that key reproduce the posted reveal? No. $(state_name "$(sale_state "$S3")"), without running the model." "A real counterexample that was never delivered earns nothing."
caption 3 settle orange "addr:$NEWCOMER_ADDR" "NEWCOMER'S CARD" "The newcomer loses its bond. Its card reads $(headline_for "$NEWCOMER_ADDR")."
scene_done 3

# Scene 4 — silent buyer, sold by the quiet wallet. Its headline is read before the sale and must be "no history".
# The claim is posted before the card, as in scene 1.
gate 4
CLAIM_B="$(post_claim)"; [ -n "$CLAIM_B" ] || die "no CLAIM_ID from second buyer post"
card 4 "Scene 4 · The silent buyer" "A sale the buyer never checks."
caption 4 claim blue "claim:$CLAIM_B" "CLAIM #$CLAIM_B" "The buyer posts a second claim. This time nobody is watching it."
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
caption 4 reveal grey "sale:$S4" "QUIET WALLET" "A quiet wallet with $QUIET_BEFORE sells a counterexample and reveals it."
if [ "$CHAIN" = "anvil" ]; then
  # The local chain's clock is jumped past the window; the caption says so rather than pretending to wait.
  JUMP_S=$((ADJ_WINDOW + 10))
  caption 4 adjudicate grey "sale:$S4" "SALE #$S4" "The ${ADJ_WINDOW}-second window passes with no buyer action." "Local chain: the clock is advanced ${JUMP_S} s here. On the testnet the wait is real."
  sleep 2
  cast rpc evm_increaseTime "$JUMP_S" --rpc-url "$RPC_URL" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
else
  caption 4 adjudicate grey "sale:$S4" "SALE #$S4" "The ${ADJ_WINDOW}-second window passes. The buyer never confirms and never disputes."
fi
wait_state "$S4" "$ST_UNADJUDICATED" $((ADJ_WINDOW + 240))
C_SELLER_AFTER="$(seller_confirmed "$SELLER_ADDR")"
[ "$C_SELLER_AFTER" = "$C_SELLER_BEFORE" ] || die "the honest seller's confirmed count moved from $C_SELLER_BEFORE to $C_SELLER_AFTER during a sale it never made"
caption 4 settle amber "sale:$S4" "SALE #$S4" "Anyone can settle. The quiet wallet is paid. But the sale is recorded as $(lower "$(state_name "$(sale_state "$S4")")")."
caption 4 settle grey "addr:$QUIET_ADDR" "QUIET WALLET'S CARD" "The quiet wallet's card reads $(headline_for "$QUIET_ADDR"): $(seller_unadjudicated "$QUIET_ADDR") unadjudicated, $(seller_confirmed "$QUIET_ADDR") confirmed. Money followed the default. Reputation did not." "Silence is not evidence."
scene_done 4

# Epilogue: with EPILOGUE=1 the live page, its sales counted from the deployment docs/deployment.json names; then a
# final card that the recorder keeps up until END stops it (its card_s outlives its hold), so the video ends on it.
if [ "$EPILOGUE" = 1 ]; then
  LIVE="$(live_sales_phrase || true)"
  goto_caption "$LIVE_PAGE" "The same contract, live on Base Sepolia.${LIVE:+ $LIVE}" 10
fi
LIVE_HOST="${LIVE_PAGE#https://}"; LIVE_HOST="${LIVE_HOST#http://}"; LIVE_HOST="${LIVE_HOST%/}"
card 0 "Silence is not evidence." "$(dep_field address) on $(chain_name "$(dep_field chainId)") · $LIVE_HOST" "$FINAL_S" "$((FINAL_S + 60))"
log "all four scenes done: sales #$S1 #$S2 #$S3 #$S4"
