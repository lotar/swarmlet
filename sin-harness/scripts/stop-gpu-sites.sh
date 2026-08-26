#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"
stop_one() {
  id=$1; pf="$HERE/data/gpu-sites/$id/pid"
  [ -f "$pf" ] || { echo "[$id] no pidfile"; return; }
  pid=$(cat "$pf")
  if kill -0 "$pid" 2>/dev/null; then
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$cmd" in
      *OLMoE-1B-7B-0125-Instruct-Q4_K_M.gguf*) kill "$pid"; echo "[$id] stopped pid=$pid" ;;
      *) echo "[$id] refusing to kill pid=$pid (unexpected command: $cmd)"; exit 1 ;;
    esac
  fi
  rm -f "$pf"
}
case "$TARGET" in
  all) stop_one n1; stop_one n2; stop_one n3 ;;
  n1|n2|n3) stop_one "$TARGET" ;;
  *) echo "usage: $0 [all|n1|n2|n3]"; exit 2 ;;
esac
