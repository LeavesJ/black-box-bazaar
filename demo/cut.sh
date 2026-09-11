#!/usr/bin/env bash
# demo/cut.sh — demo/out/raw.webm + demo/out/record-start.json + demo/timeline.json -> demo/out/bazaar-demo.mp4
# record-start.json is stamped by record.mjs when the page is created, before it loads, which is when the video starts;
# timeline.json holds one entry per caption (scenes.sh writes about twenty, and any count from one up works).
# Every wait longer than GAP seconds between two captions keeps its first KEEP_HEAD s and last KEEP_TAIL s;
# the middle is replaced by a FREEZE-second still of the last kept frame labelled "… N s pass …".
# Segments are cut with ffmpeg and joined with the concat demuxer. Fails if the result exceeds LIMIT seconds.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"
RAW="${RAW:-$OUT/raw.webm}"
START="${START:-$OUT/record-start.json}"
TIMELINE="${TIMELINE:-$HERE/timeline.json}"
FINAL="${FINAL:-$OUT/bazaar-demo.mp4}"
WORK="${WORK:-$OUT/cut}"
GAP="${GAP:-25}"; KEEP_HEAD="${KEEP_HEAD:-10}"; KEEP_TAIL="${KEEP_TAIL:-5}"; FREEZE="${FREEZE:-2}"; LIMIT="${LIMIT:-295}"
FPS=30
ENC=(-c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p -r "$FPS" -an)

for f in "$RAW" "$START" "$TIMELINE"; do [ -f "$f" ] || { echo "cut.sh: missing input $f" >&2; exit 1; }; done
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "cut.sh: ffmpeg and ffprobe are required" >&2; exit 1; }
rm -rf "$WORK"; mkdir -p "$WORK"

duration() { ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1"; }
RAW_DUR="$(duration "$RAW")"
N_CAPS="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$TIMELINE")"
[ "$N_CAPS" -ge 1 ] || { echo "cut.sh: $TIMELINE has no captions" >&2; exit 1; }
echo "raw: ${RAW_DUR}s · captions: $N_CAPS · start: $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["t"])' "$START")"

# ---------- label rendering: drawtext when this ffmpeg has it, else a PNG rendered by chromium and overlaid ----------
FONTFILE=""
HAVE_DRAWTEXT=0
if ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' drawtext '; then
  HAVE_DRAWTEXT=1
  if ! ffmpeg -v error -f lavfi -i color=c=black:s=64x64:d=0.1 -vf "drawtext=text=x" -f null - >/dev/null 2>&1; then
    for cand in /System/Library/Fonts/Helvetica.ttc /System/Library/Fonts/Supplemental/Arial.ttf /System/Library/Fonts/SFNS.ttf; do
      [ -f "$cand" ] && { FONTFILE="$cand"; break; }
    done
    [ -n "$FONTFILE" ] || { echo "cut.sh: drawtext cannot find a font and no fontfile under /System/Library/Fonts" >&2; exit 1; }
  fi
fi
label_png() { # <text> <out.png>  — transparent PNG of the label, via the recorder's own chromium
  local text="$1" png="$2"
  cat > "$WORK/label.mjs" <<'JS'
import { createRequire } from "node:module";
const [demoDir, text, out] = process.argv.slice(2);
const { chromium } = createRequire(demoDir + "/")("playwright");
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 900, height: 160 } });
await p.setContent(`<body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:160px">
  <div style="font:600 44px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff;background:rgba(0,0,0,.65);padding:16px 36px;border-radius:12px">${text.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</div></body>`);
await p.screenshot({ path: out, omitBackground: true }); await b.close();
JS
  node "$WORK/label.mjs" "$HERE" "$text" "$png"
}

# ---------- plan: caption offsets relative to the recording start ----------
python3 - "$START" "$TIMELINE" "$RAW_DUR" "$GAP" "$KEEP_HEAD" "$KEEP_TAIL" > "$WORK/plan.txt" <<'PY'
import json, sys
start, timeline, dur, gap, head, tail = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
t0 = json.load(open(start))["t"]
marks = sorted({min(max(0.0, float(e["t"]) - t0), dur) for e in json.load(open(timeline))})
marks = [0.0] + [m for m in marks if 0.0 < m < dur] + [dur]
segs = []
def cut(a, b):
    if b - a < 0.05: return
    if segs and segs[-1][0] == "cut" and abs(segs[-1][2] - a) < 1e-6: segs[-1] = ("cut", segs[-1][1], b)
    else: segs.append(("cut", a, b))
for a, b in zip(marks, marks[1:]):
    if b - a > gap:
        cut(a, a + head)
        segs.append(("freeze", a + head, int(round(b - a - head - tail))))
        cut(b - tail, b)
    else:
        cut(a, b)
for s in segs:
    print(" ".join(str(x) for x in s))
PY
echo "plan:"; cat "$WORK/plan.txt"

# ---------- render segments ----------
LIST="$WORK/list.txt"; : > "$LIST"
i=0
while read -r -u 3 kind a b; do   # fd 3: ffmpeg inside the loop reads stdin and would eat plan lines
  i=$((i + 1)); seg="$WORK/seg$(printf '%03d' "$i").mp4"
  case "$kind" in
    cut)
      len="$(python3 -c 'import sys; print(max(0.04, float(sys.argv[2]) - float(sys.argv[1])))' "$a" "$b")"
      ffmpeg -y -v error -ss "$a" -t "$len" -i "$RAW" "${ENC[@]}" "$seg"
      ;;
    freeze)
      frame="$WORK/frame$i.png"; text="… ${b} s pass …"
      ffmpeg -y -v error -ss "$a" -i "$RAW" -frames:v 1 "$frame"
      if [ "$HAVE_DRAWTEXT" = 1 ]; then
        printf '%s' "$text" > "$WORK/label$i.txt"
        dt="drawtext=textfile=$WORK/label$i.txt:fontsize=44:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=18:x=(w-text_w)/2:y=(h-text_h)/2"
        [ -n "$FONTFILE" ] && dt="$dt:fontfile=$FONTFILE"
        ffmpeg -y -v error -loop 1 -i "$frame" -t "$FREEZE" -vf "$dt" "${ENC[@]}" "$seg"
      else
        label_png "$text" "$WORK/label$i.png"
        ffmpeg -y -v error -loop 1 -i "$frame" -i "$WORK/label$i.png" -t "$FREEZE" -filter_complex "[0][1]overlay=(W-w)/2:(H-h)/2" "${ENC[@]}" "$seg"
      fi
      ;;
    *) echo "cut.sh: bad plan line: $kind $a $b" >&2; exit 1 ;;
  esac
  printf "file '%s'\n" "$seg" >> "$LIST"
done 3< "$WORK/plan.txt"

# ---------- join ----------
ffmpeg -y -v error -f concat -safe 0 -i "$LIST" "${ENC[@]}" -movflags +faststart "$FINAL"
FINAL_DUR="$(duration "$FINAL")"
echo "wrote $FINAL (${FINAL_DUR}s, from ${RAW_DUR}s raw)"
python3 - "$FINAL_DUR" "$LIMIT" <<'PY'
import sys
d, lim = float(sys.argv[1]), float(sys.argv[2])
if d > lim:
    print(f"cut.sh: FINAL VIDEO IS {d:.1f}s, OVER THE {lim:.0f}s LIMIT — tighten GAP/KEEP_HEAD/KEEP_TAIL or shorten the scenes", file=sys.stderr)
    sys.exit(1)
print(f"under the {lim:.0f}s limit")
PY
