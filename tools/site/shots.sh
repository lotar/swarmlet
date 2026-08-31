#!/bin/bash
# shots.sh — scroll to each section with instant scrolling and shoot the viewport
B="${BROWSE_BIN:-$HOME/.claude/skills/gstack/browse/dist/browse}"
test -x "$B" || { echo "browse binary missing; set BROWSE_BIN" >&2; exit 2; }
URL="${1:-http://localhost:8123/?gl=force}"
W="${2:-1440x900}"
OUT="${3:-/tmp/sw}"
mkdir -p "$OUT"
$B viewport "$W" >/dev/null
$B goto "$URL" >/dev/null
$B wait 1800 >/dev/null 2>&1
$B js "document.querySelectorAll('.rv,[data-anim]').forEach(e=>e.classList.add('in'))" >/dev/null
$B js "[...document.styleSheets].length" >/dev/null
for sel in "#top" "#problem" "#thesis" "#architecture" "#loop" "#proof" "#bench" "#mesh" "#honest" "#roadmap" "#commons" "#faq" "#access" "footer"; do
  name=$(echo "$sel" | tr -d '#')
  Y=$($B js "Math.max(0,Math.round(document.querySelector('$sel').getBoundingClientRect().top+window.scrollY-80))" | tr -dc '0-9-')
  $B js "window.scrollTo({top:$Y,behavior:'instant'});String(window.scrollY)" >/dev/null
  $B wait 420 >/dev/null 2>&1
  $B screenshot "$OUT/$name.png" --viewport >/dev/null
done
$B js "String(document.documentElement.scrollHeight)"
ls "$OUT"
