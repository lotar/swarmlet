# Claude runbook: replace only swarmlet-control

This is a future, separately authorized production procedure, **not executed by this PR**.
Do not merge the PR as part of this runbook. Wait for its independently reviewed merge and explicit
deploy authorization, including permission for the requested build on shop. The current task permits
heavy work only through `run-heavy.sh` on legion2/m1 and makes no production writes.

Use the merged SHA, never the hand-patched build directory. Preserve the complete controller state and
signing keys. Do not publish agent releases, change node offers, restart agents, recreate Traefik/site,
or run production `down -v`. Read [the provenance report](reports/control-gwfix-bun144-20261025.md)
and all outstanding validation failures before scheduling the window.

## 1. Prepare an immutable release from the merged SHA

On the operator's workstation, in a fresh task clone (not a shared checkout):

```sh
GH_TOKEN=$(gh auth token -u lotar) git -c credential.helper= \
  -c 'credential.helper=!f() { printf "%s\n" "username=x-access-token" "password=$GH_TOKEN"; }; f' \
  clone https://github.com/lotar/swarmlet.git swarmlet-control-release
cd swarmlet-control-release
DEPLOY_SHA='<full merged commit SHA>'
git cat-file -e "$DEPLOY_SHA^{commit}"
git merge-base --is-ancestor "$DEPLOY_SHA" origin/main
git show "$DEPLOY_SHA:deploy/control/Dockerfile" | head -1
# Required: oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
# Archive tracked files only; git archive emits no macOS resource forks or .env from the workspace.
git archive --format=tar "$DEPLOY_SHA" | gzip > "control-$DEPLOY_SHA.tar.gz"
shasum -a 256 "control-$DEPLOY_SHA.tar.gz"
# Transfer into your own new operator directory on shop, not the old build tree.
ssh shop 'install -d -m 700 /root/swctl-bun144-deploy'
scp "control-$DEPLOY_SHA.tar.gz" shop:/root/swctl-bun144-deploy/
```

If using macOS `tar` instead of `git archive`, always use
`COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs ...`; delete `._*` after extracting.
Do not include `.env`, credentials, keys or production state in a source archive.

For the remaining commands, use one Bash session on shop so variables remain available:

```bash
set -euo pipefail
umask 077
ROOT=/root/projects/swarmlet-control
DEPLOY_SHA='<same full merged commit SHA>'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ROLLBACK_TAG="rollback-$STAMP"
BACKUP="/root/swctl-bun144-deploy/backup-$STAMP"
RELEASE="/root/swctl-bun144-deploy/release-$DEPLOY_SHA"
test ! -e "$RELEASE"
mkdir -m 700 "$RELEASE" "$BACKUP"
sha256sum "/root/swctl-bun144-deploy/control-$DEPLOY_SHA.tar.gz"
# Compare this hash with the workstation's result before extracting.
tar -xzf "/root/swctl-bun144-deploy/control-$DEPLOY_SHA.tar.gz" -C "$RELEASE"
find "$RELEASE" -name '._*' -delete
printf '%s\n' "$DEPLOY_SHA" > "$BACKUP/deploy-sha.txt"
```

## 2. Capture the baseline and retain the current image FIRST

Revalidate the inspected image. Abort and re-audit if it changed since this report.

```bash
CURRENT_IMAGE=$(docker inspect swarmlet-control --format '{{.Image}}')
test "$CURRENT_IMAGE" = sha256:ade420dccad44d1356d375dce9ccb4562a3759329d878fd8fd4b5f2b77452830
docker image inspect "swarmlet-control:$ROLLBACK_TAG" >/dev/null 2>&1 && { echo 'rollback tag already exists'; exit 1; }
docker tag "$CURRENT_IMAGE" "swarmlet-control:$ROLLBACK_TAG"
printf '%s\n' "$CURRENT_IMAGE" > "$BACKUP/image-id.txt"
printf '%s\n' "$ROLLBACK_TAG" > "$BACKUP/rollback-tag.txt"
cp -p "$ROOT/build/compose.control.prod.yml" "$BACKUP/compose.control.prod.yml"
cp -p "$ROOT/build/deploy/control/Dockerfile" "$BACKUP/Dockerfile.old"
docker inspect swarmlet-control --format '{{json .Mounts}}' > "$BACKUP/mounts.json"
docker inspect swarmlet-control --format '{{json .NetworkSettings.Ports}}' > "$BACKUP/ports.json"
docker exec swarmlet-control bun --version
# Expected current runtime: 1.3.14
```

Confirm the only state mount is still `$ROOT/data:/data`. If a new state volume/mount has appeared,
include it in the offline backup before continuing. Do not inspect environment values or commands.
The original image remains both `:2026091902-gwfix` and the new `:rollback-<UTC-date/time>`.
An older `:rollback-20261024-baseline` already existed during inspection; do not overwrite it.

Capture online identities and route IDs without exposing tokens. The token stays inside the container;
only the selected non-secret fields are written to the operator's protected backup directory.

```bash
snapshot() {
  docker exec -i swarmlet-control bun - <<'JS'
const cfg = await Bun.file('/data/control.json').json();
async function get(path) {
  const r = await fetch('http://127.0.0.1:47900' + path, {
    headers: {authorization: 'Bearer ' + cfg.adminToken}
  });
  if (!r.ok) throw new Error('snapshot HTTP ' + r.status);
  return r.json();
}
const nodes = await get('/api/nodes');
const routes = await get('/api/routing');
console.log(JSON.stringify({
  at: new Date().toISOString(),
  nodes: nodes.nodes.map(n => ({id:n.id, hostname:n.hostname, online:n.online, lastSeen:n.lastSeen, agentVersion:n.agentVersion})),
  routes: routes.models.flatMap(m => m.deployments.map(d => ({model:m.modelName, deployment:d.id, node:d.nodeId})))
}));
JS
}
snapshot > "$BACKUP/before.json"
for url in https://swarmlet.ai/ https://app.swarmlet.ai/ https://app.swarmlet.ai/health; do
  curl --max-time 20 -sS -o /dev/null -w "$url %{http_code}\n" "$url"
done
docker exec swarmlet-control bun -e 'const r=await fetch("http://127.0.0.1:47900/health"); console.log(r.status,await r.text()); if(!r.ok)process.exit(1)'
```

The audit baseline returned HTTP 200 for all URLs and `/health` reported five nodes; recapture this
at deployment time and use actual identity/route comparisons, not an assumed count. Main intentionally
retires the Bonsai profile. If the current workload requires that removed profile, resolve that
compatibility requirement before deploying; do not silently reintroduce it or stop those workloads.

## 3. Build on shop, before the outage

Only after the separate authorization described above:

```bash
export SWARMLET_CONTROL_DATA="$ROOT/data"
export SWARMLET_REVISION="$DEPLOY_SHA"
DC=(docker compose -p swarmlet-control --project-directory "$RELEASE" -f "$RELEASE/compose.control.prod.yml")
"${DC[@]}" build --pull control
docker image inspect "swarmlet-control:$DEPLOY_SHA" --format 'id={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
docker run --rm --network none --read-only --entrypoint bun "swarmlet-control:$DEPLOY_SHA" --version
# Require revision == DEPLOY_SHA and Bun == 1.4.4.
```

The version-only container has no state mount and cannot start a second controller.
Do not copy post-build patches into the image or build from `$ROOT/build`.

## 4. Take an offline, restorable state backup; recreate only control

Arrange a window with no external release publisher writing to the control data directory.
Stop only control. A live `tar` of SQLite WAL files is not a consistent backup.

```bash
OLD=(docker compose -p swarmlet-control --project-directory "$ROOT/build" -f "$BACKUP/compose.control.prod.yml")
"${OLD[@]}" stop control
test "$(docker inspect swarmlet-control --format '{{.State.Running}}')" = false
# Includes control.json, control.sqlite + WAL/SHM if present, keys/, releases/, telemetry/ and any other state.
tar -czpf "$BACKUP/data.tar.gz" -C "$ROOT" data
sha256sum "$BACKUP/data.tar.gz" > "$BACKUP/data.tar.gz.sha256"
sha256sum -c "$BACKUP/data.tar.gz.sha256"
mkdir -m 700 "$BACKUP/restore-check"
tar -xzpf "$BACKUP/data.tar.gz" -C "$BACKUP/restore-check"
python3 - "$BACKUP/restore-check/data" <<'PY'
import pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1])
for name in ['control.json', 'control.sqlite', 'keys', 'releases']:
    assert (root / name).exists(), 'missing backup component: ' + name
for db in sorted(root.rglob('*.sqlite')):
    with sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True) as c:
        result = c.execute('PRAGMA integrity_check').fetchall()
    assert result == [('ok',)], 'backup database integrity failed'
print('BACKUP_RESTORE_CHECK=ok')
PY
"${DC[@]}" up -d --no-deps --no-build --force-recreate control
```

If backup creation or verification fails, keep the failed backup for diagnosis and restart only the old
image using the saved Compose file and `SWARMLET_REVISION="$ROLLBACK_TAG"`; do not proceed to replacement.
Preserve ownership/modes on all state. Do not regenerate `control.json`, `keys/` or node identities.
`Registry` and `TelemetryStore` source match between old image and main, but retaining complete
pre-upgrade state is still required for rollback. Never run two controllers against these data.

## 5. Health and reconnection gate

```bash
for i in $(seq 1 60); do
  status=$(docker inspect swarmlet-control --format '{{.State.Health.Status}}')
  [ "$status" = healthy ] && break
  sleep 2
done
test "$status" = healthy
test "$(docker inspect swarmlet-control --format '{{.Image}}')" = "$(docker image inspect "swarmlet-control:$DEPLOY_SHA" --format '{{.Id}}')"
docker exec swarmlet-control bun --version
docker exec swarmlet-control bun -e 'const r=await fetch("http://127.0.0.1:47900/health"); console.log(r.status,await r.text()); if(!r.ok)process.exit(1)'
for url in https://swarmlet.ai/ https://app.swarmlet.ai/ https://app.swarmlet.ai/health; do
  code=$(curl --max-time 20 -sS -o /dev/null -w '%{http_code}' "$url")
  printf '%s %s\n' "$url" "$code"
  test "$code" = 200
done
snapshot > "$BACKUP/after.json"
python3 - "$BACKUP/before.json" "$BACKUP/after.json" <<'PY'
import json, sys
before, after = (json.load(open(p)) for p in sys.argv[1:])
expected = {n['id'] for n in before['nodes'] if n['online']}
online = {n['id'] for n in after['nodes'] if n['online']}
missing = sorted(expected - online)
old_routes = {(r['model'], r['deployment'], r['node']) for r in before['routes']}
new_routes = {(r['model'], r['deployment'], r['node']) for r in after['routes']}
print('missing_online_ids', missing)
print('missing_routes', sorted(old_routes - new_routes))
assert not missing and not (old_routes - new_routes), 'reconnection/routing not restored'
print('RECONNECT_AND_ROUTES=ok')
PY
```

Allow up to five minutes for automatic reconnection/reconciliation, taking a fresh snapshot on each
retry. Require the same previously online IDs and expected routes, fresh heartbeats in `/api/nodes`,
and no restart-count growth. Changes to placement may be legitimate but must be explained from current
state before acceptance. Check the authenticated UI and a separately approved existing inference smoke
if operational policy allows it; health alone is not an inference test. Do not print admin/API keys,
fetch full environment/command metadata, or dump unfiltered logs into a report.
If nodes/routes remain missing, HTTP checks fail, the runtime is wrong, or crashes recur, roll back.

## 6. Roll back the image and, if necessary, state

Use the saved variables from this deployment, not a hard-coded old date. Do not rebuild for rollback.

```bash
"${DC[@]}" stop control
export SWARMLET_REVISION="$ROLLBACK_TAG"
"${OLD[@]}" up -d --no-deps --no-build --force-recreate control
```

First try the old image against the preserved current state, since the state schema is unchanged in
this PR. Repeat health, same-node and route checks. If state itself must be reverted, stop control
again and restore the verified offline archive into a new directory while preserving the failed state:

```bash
"${OLD[@]}" stop control
test "$(docker inspect swarmlet-control --format '{{.State.Running}}')" = false
sha256sum -c "$BACKUP/data.tar.gz.sha256"
RESTORE="$ROOT/restore-$STAMP"
FAILED="$ROOT/data-after-failed-$STAMP"
test ! -e "$RESTORE" && test ! -e "$FAILED"
mkdir -m 700 "$RESTORE"
tar -xzpf "$BACKUP/data.tar.gz" -C "$RESTORE"
# Explicitly accept loss of post-backup registrations/changes before replacing state.
mv "$ROOT/data" "$FAILED"
mv "$RESTORE/data" "$ROOT/data"
export SWARMLET_REVISION="$ROLLBACK_TAG"
"${OLD[@]}" up -d --no-deps --no-build --force-recreate control
```

Verify the old image ID equals the captured `CURRENT_IMAGE`, then rerun section 5's health/reconnect
checks (expect Bun 1.3.14 on rollback, not 1.4.4). Keep rollback image, source archive, backup and failed
state until the operator closes the rollback window. A rollback restores availability but restores the
vulnerable Bun runtime too; record it as a failed upgrade, not security remediation.

## Evidence handoff

Record merged SHA, new/rollback image IDs, backup checksum and restore result, Bun version, internal and
public HTTP codes, missing-ID/route lists, and final container health/restart count. Include exact commands
and output lines, never credentials. Report post-deploy checks as UNVERIFIED until actually executed.
