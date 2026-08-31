#!/usr/bin/env bash
# Attested two-Ubuntu-owner proof over SSH local forwarding. It never opens
# worker ports on the LAN and cleans only resources carrying this run's nonce.
set -Eeuo pipefail
NODE_A=${NODE_A:?set NODE_A=user@host};NODE_B=${NODE_B:?set NODE_B=user@host};REMOTE_REPO=${REMOTE_REPO:-'~/ai-mesh'}
ROOT=$(cd "$(dirname "$0")/../.." && pwd);HARNESS="$ROOT/sin-harness";RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$-$(openssl rand -hex 4);OUT=${OUT:-$HARNESS/data/two-node/$RUN_ID};mkdir -p "$OUT"
PLAN=proofs/tiny-moe/fixtures/two-node/plan.json;REMOTE_RUN="data/two-node/$RUN_ID";TOKEN=$(openssl rand -hex 32);LOCAL_TOKEN=$OUT/admin.token;printf '%s\n' "$TOKEN" >"$LOCAL_TOKEN";chmod 600 "$LOCAL_TOKEN"
RA=$((20000+$$%5000));RB=$((25000+$$%5000));TA=$((30000+$$%5000));TB=$((35000+$$%5000));PA='';PB=''
[[ $NODE_A =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ && $NODE_B =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]]||{ echo 'NODE_A/NODE_B must be user@host';exit 2; }
[ "$NODE_A" != "$NODE_B" ]||{ echo 'NODE_A and NODE_B must be different physical hosts';exit 2; }
[[ $REMOTE_REPO =~ ^[A-Za-z0-9_./~:-]+$ ]]||{ echo 'REMOTE_REPO contains unsupported characters';exit 2; }
test -z "$(git -C "$ROOT" status --porcelain=v1)"||{ echo 'local proof checkout must be clean';exit 2; }
for port in "$TA" "$TB";do ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1||{ echo "local tunnel port $port occupied";exit 2; };done
SSH=(ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
copy_log(){ host=$1;node=$2;"${SSH[@]}" "$host" "cat $REMOTE_REPO/sin-harness/$REMOTE_RUN/$node.log 2>/dev/null||true" >"$OUT/$node.log" 2>/dev/null||true; }
stop_remote(){
 host=$1;node=$2;copy_log "$host" "$node"
 "${SSH[@]}" "$host" "cd $REMOTE_REPO/sin-harness && if test -f $REMOTE_RUN/$node.pid; then record=\$(python3 -c 'import json;d=json.load(open(\"$REMOTE_RUN/$node.pid\"));print(d[\"supervisorPid\"],d[\"launchId\"])');set -- \$record;p=\$1;launch=\$2;test \"\$launch\" = '$RUN_ID' || exit 91; case \$(tr '\\0' ' ' </proc/\$p/cmdline 2>/dev/null) in *tiny-moe/supervisor.ts*--launch-id\\ $RUN_ID*) kill -TERM \$p;; *) exit 92;; esac; for _ in \$(seq 1 50);do test ! -e /proc/\$p&&break;sleep .1;done;test ! -e /proc/\$p;fi;rm -rf $REMOTE_RUN" >/dev/null 2>&1||true
}
cleanup(){ set +e;[ -n "$PA" ]&&kill -TERM "$PA" 2>/dev/null;[ -n "$PB" ]&&kill -TERM "$PB" 2>/dev/null;[ -n "$PA" ]&&wait "$PA" 2>/dev/null;[ -n "$PB" ]&&wait "$PB" 2>/dev/null;stop_remote "$NODE_A" n1;stop_remote "$NODE_B" n2;rm -f "$LOCAL_TOKEN";set -e; }
trap cleanup EXIT INT TERM HUP
LOCAL_COMMIT=$(git -C "$ROOT" rev-parse HEAD);MACHINE_A=$("${SSH[@]}" "$NODE_A" 'cat /etc/machine-id');MACHINE_B=$("${SSH[@]}" "$NODE_B" 'cat /etc/machine-id');[ -n "$MACHINE_A" ]&&[ -n "$MACHINE_B" ]&&[ "$MACHINE_A" != "$MACHINE_B" ]||{ echo 'owners must have distinct Linux machine IDs';exit 3; }
prepare(){
 host=$1;node=$2;port=$3
 remote_commit=$("${SSH[@]}" "$host" "git -C $REMOTE_REPO rev-parse HEAD");[ "$remote_commit" = "$LOCAL_COMMIT" ]||{ echo "$host commit $remote_commit != $LOCAL_COMMIT";exit 3; }
 remote_status=$("${SSH[@]}" "$host" "git -C $REMOTE_REPO status --porcelain=v1");[ -z "$remote_status" ]||{ echo "$host checkout is dirty";exit 3; }
 "${SSH[@]}" "$host" "test \$(bun --version) = 1.3.14;cd $REMOTE_REPO/sin-harness;! ss -ltn | grep -q ':$port ';mkdir -p data/two-node;mkdir $REMOTE_RUN"
 printf '%s\n' "$TOKEN"|"${SSH[@]}" "$host" "umask 077;cat >$REMOTE_REPO/sin-harness/$REMOTE_RUN/admin.token"
 "${SSH[@]}" "$host" "cd $REMOTE_REPO/sin-harness && nohup bun proofs/tiny-moe/supervisor.ts --pid-file $REMOTE_RUN/$node.pid --launch-id $RUN_ID -- --id $node --launch-id $RUN_ID --port $port --fixture proofs/tiny-moe/fixtures/two-node/$node.json --placement-plan $PLAN --admin-token-file $REMOTE_RUN/admin.token >$REMOTE_RUN/$node.log 2>&1 </dev/null &"
}
prepare "$NODE_A" n1 "$RA";prepare "$NODE_B" n2 "$RB"
"${SSH[@]}" "$NODE_A" "cd $REMOTE_REPO;printf 'machineId=';cat /etc/machine-id;printf 'commit=';git rev-parse HEAD;printf 'status=';git status --porcelain=v1;printf 'diff=';git diff --binary HEAD|sha256sum;hostname;uname -a;free -h;nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null||true" >"$OUT/node-a.txt"
"${SSH[@]}" "$NODE_B" "cd $REMOTE_REPO;printf 'machineId=';cat /etc/machine-id;printf 'commit=';git rev-parse HEAD;printf 'status=';git status --porcelain=v1;printf 'diff=';git diff --binary HEAD|sha256sum;hostname;uname -a;free -h;nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null||true" >"$OUT/node-b.txt"
ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:$TA:127.0.0.1:$RA "$NODE_A"&PA=$!
ssh -N -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:$TB:127.0.0.1:$RB "$NODE_B"&PB=$!
for spec in "$TA:n1" "$TB:n2";do port=${spec%:*};node=${spec#*:};for _ in $(seq 1 200);do curl -sf "http://127.0.0.1:$port/health" >/dev/null&&break;sleep .1;done;manifest=$(curl -sf "http://127.0.0.1:$port/manifest")||{ echo "$node unhealthy";exit 3; };python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["nodeId"]==sys.argv[1] and d["launchId"]==sys.argv[2]' "$node" "$RUN_ID"<<<"$manifest";done
python3 - "$OUT" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]);(p/'hosts.json').write_text(json.dumps({'nodeA':(p/'node-a.txt').read_text().splitlines(),'nodeB':(p/'node-b.txt').read_text().splitlines()},indent=2)+'\n')
PY
bun "$HARNESS/proofs/tiny-moe/physical.ts" --plan "$HARNESS/$PLAN" --owner n1=http://127.0.0.1:$TA --owner n2=http://127.0.0.1:$TB --host-evidence "$OUT/hosts.json" --evidence-out "$OUT/result.json" --admin-token-file "$LOCAL_TOKEN" --crash-owner n2 --expect-restart
cleanup;trap - EXIT INT TERM HUP
for item in "$NODE_A:n1" "$NODE_B:n2";do host=${item%:*};"${SSH[@]}" "$host" "test ! -e $REMOTE_REPO/sin-harness/$REMOTE_RUN";done
! kill -0 "$PA" 2>/dev/null&&! kill -0 "$PB" 2>/dev/null
python3 - "$OUT/result.json" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]);d=json.loads(p.read_text());d['cleanup']={'ownedTunnelExited':True,'ownedRemoteSupervisorsStopped':True,'adminTokenRemoved':True,'runDirectoryRemoved':True};tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(d,indent=2,sort_keys=True)+'\n');tmp.replace(p)
PY
sign=(python3 "$HARNESS/proofs/no-ram-goal/sign_artifact.py" --artifact "$OUT/result.json" --out "$OUT/result.signed.json" --key-dir "$HARNESS/data/keys/two-node");[ -n "${TRUSTED_FINGERPRINT:-}" ]&&sign+=(--trusted-fingerprint "$TRUSTED_FINGERPRINT");"${sign[@]}"
echo "RESULT_JSON={\"out\":\"$OUT\",\"cleaned\":true,\"launchId\":\"$RUN_ID\"}"
