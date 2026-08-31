#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd);cd "$ROOT"
[ "${ALLOW_DIRTY:-0}" = 1 ] || test -z "$(git status --porcelain=v1)" || { echo 'release requires a clean tree' >&2;exit 2; }
test -f README.md -a -f LICENSE -a -f SECURITY.md -a -f CONTRIBUTING.md -a -f CHANGELOG.md -a -f THIRD_PARTY.md
grep -q 'Swarmlet Community License 1.0' LICENSE
grep -q '1.0.0-alpha.1' sin-harness/package.json
git diff --check
cd sin-harness
bun install --frozen-lockfile
bun run test
bash -n scripts/*.sh docker/*.sh ../tools/site/*.sh
python3 -m compileall -q proofs
bun run report:results-grid >/tmp/swarmlet-results-grid.log
cd "$ROOT";git diff --exit-code -- docs/RESULTS_GRID.md
SITE_PORT=18123;PORT=$SITE_PORT node site/server.mjs >/tmp/swarmlet-site.log 2>&1 & site_pid=$!
trap 'kill "$site_pid" 2>/dev/null||true' EXIT
for _ in $(seq 1 50);do curl -fsS http://127.0.0.1:$SITE_PORT/ >/dev/null 2>&1&&break;sleep .1;done
curl -fsS http://127.0.0.1:$SITE_PORT/ >/dev/null;curl -fsS http://127.0.0.1:$SITE_PORT/app.js >/dev/null;curl -fsS http://127.0.0.1:$SITE_PORT/og.png >/dev/null
kill "$site_pid";wait "$site_pid" 2>/dev/null||true;trap - EXIT
! grep -RInE '/Users/lotar|/home/[A-Za-z0-9._-]+' README.md CONTRIBUTING.md SECURITY.md site tools sin-harness/scripts sin-harness/docker sin-harness/proofs --exclude='*.signed.json' --exclude=release-check.sh --exclude-dir=results --exclude-dir=node_modules
! git grep -nE 'AKIA[0-9A-Z]{16}|xox[baprs]-|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}' -- ':!sin-harness/scripts/release-check.sh'
echo 'RELEASE_CHECK_OK version=1.0.0-alpha.1 portable=true model=false docker=false hardware=false'
