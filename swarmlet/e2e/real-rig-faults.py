#!/usr/bin/env python3
"""Real three-node acceptance, invoked ONLY inside idle-window.py's maintenance window.

SWARMLET_IDLE_WINDOW=1 python3 e2e/real-rig-faults.py --out /absolute/evidence.json
Reuses the standing mesh-2b-internet deployment and existing node offers/enrollments.
Success leaves that mesh ready. Failure stops it; Legion 1's service is always restored.
Production :8099 restoration belongs to the enclosing idle-window operator.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import signal
import shlex
import sys
import socket
import subprocess
import time
import urllib.error
import urllib.request


# These read-only probes run on each node. They emit only selected process metadata, never config.
PROCESS_AUDIT = r'''
import json, os, re, subprocess, sys
from pathlib import Path
payload = json.loads(sys.argv[1])
config = json.loads((Path.home()/'.swarmlet/node.json').read_text())
roots = [Path(config['enginePath']), Path.home()/'.swarmlet/engine', Path.home()/'swarmlet/engine',
         Path.home()/'swarmlet-engine/dist/linux', Path('/usr/lib/Swarmlet Node')]
allowed = {str((root/name).resolve()) for root in roots for name in ['ggml-rpc-server', 'llama-server']}
rows = []
ps = subprocess.run(['ps', '-ww', '-axo', 'pid=,ppid=,comm='], check=True, capture_output=True, text=True).stdout
parents = {}
for line in ps.splitlines():
    fields = line.strip().split(None, 2)
    if len(fields) != 3: continue
    pid, ppid = map(int, fields[:2]); parents[pid] = ppid
    if sys.platform.startswith('linux'):
        try: executable = os.readlink('/proc/%d/exe' % pid).removesuffix(' (deleted)')
        except (FileNotFoundError, PermissionError): continue
    else:
        executable = fields[2]
    if str(Path(executable).resolve()) in allowed:
        rows.append({'pid': pid, 'ppid': ppid, 'executable': executable, 'ports': []})
if sys.platform.startswith('linux'):
    sockets = subprocess.run(['ss', '-H', '-ltnp'], check=True, capture_output=True, text=True).stdout
    for row in rows:
        for line in sockets.splitlines():
            if re.search(r'pid=%d,' % row['pid'], line):
                row['ports'].append(int(line.split()[3].rsplit(':', 1)[1]))
else:
    for row in rows:
        result = subprocess.run(['lsof', '-nP', '-a', '-p', str(row['pid']), '-iTCP', '-sTCP:LISTEN', '-Fn'], capture_output=True, text=True)
        if result.returncode not in (0, 1): raise RuntimeError('lsof failed')
        row['ports'] = [int(line[1:].rsplit(':', 1)[1]) for line in result.stdout.splitlines() if line.startswith('n')]
errors = []
matched = set()
for assignment in payload['expected']:
    pid = assignment.get('pid')
    matches = []
    for row in rows:
        ancestor = row['pid']; seen = set()
        while ancestor and ancestor not in seen:
            if ancestor == pid:
                matches.append(row); break
            seen.add(ancestor); ancestor = parents.get(ancestor)
    if len(matches) != 1:
        errors.append('assignment %s pid %s has %d engine processes' % (assignment['id'], pid, len(matches)))
        continue
    row = matches[0]; matched.add(row['pid'])
    row['assignmentId'] = assignment['id']; row['snapshotPid'] = pid
    # Worker/server ports, unlike rpcN/peerN dialer sockets, are owned by the engine process.
    expected_ports = assignment['expectedEnginePorts']
    if not row['ports'] or any(port not in row['ports'] for port in expected_ports):
        errors.append('assignment %s missing engine listening ports %s' % (assignment['id'], expected_ports))
for row in rows:
    if row['pid'] not in matched: errors.append('unaccounted managed engine pid %d' % row['pid'])
print(json.dumps({'processes': rows, 'errors': errors}))
'''

AGENT_SIGNAL = r'''
import json, os, signal, subprocess, sys
from pathlib import Path
payload = json.loads(sys.argv[1]); identity = payload['identity']; action = payload['action']
def start_ticks(pid):
    return Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()[19]
if action == 'identify':
    pid = int(subprocess.run(['systemctl', '--user', 'show', 'swarmlet-node.service', '-p', 'MainPID', '--value'], check=True, capture_output=True, text=True).stdout)
    if pid <= 1 or 'swarmlet-node' not in os.readlink('/proc/%d/exe' % pid): raise RuntimeError('unexpected agent MainPID executable')
    import urllib.request
    with urllib.request.urlopen('http://127.0.0.1:47800/api/status', timeout=10) as response:
        workers = [a for a in json.load(response)['assignments'] if a['kind'] == 'worker' and a['state'] == 'listening']
    if len(workers) != 1 or not workers[0].get('pid'): raise RuntimeError('expected exactly one live Legion1 mesh worker')
    worker_pid = payload['workerPid']
    if Path(os.readlink('/proc/%d/exe' % worker_pid)).name != 'ggml-rpc-server': raise RuntimeError('expected actual RPC engine PID')
    identity = {'pid': pid, 'startTicks': start_ticks(pid), 'workerPid': worker_pid, 'workerStartTicks': start_ticks(worker_pid)}
else:
    pid = identity['pid']
    if start_ticks(pid) != identity['startTicks']: raise RuntimeError('agent PID identity changed; refusing signal')
    if action == 'pause': os.kill(pid, signal.SIGSTOP)
    elif action == 'resume': os.kill(pid, signal.SIGCONT)
    elif action == 'inspect':
        proc = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], check=True, capture_output=True, text=True).stdout.strip()
        worker = subprocess.run(['ps', '-o', 'pid=,stat=', '-p', str(identity['workerPid'])], check=True, capture_output=True, text=True).stdout.strip()
        identity.update(paused='T' in proc, workerAlive=start_ticks(identity['workerPid']) == identity['workerStartTicks'] and 'Z' not in worker,
                        agentPs=proc, workerPs=worker)
    else: raise RuntimeError('unknown signal operation')
print(json.dumps(identity))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--control-url', default='http://127.0.0.1:47900')
    parser.add_argument('--config', type=Path, default=Path.home() / '.swarmlet/control/control.json')
    parser.add_argument('--deployment-id')
    parser.add_argument('--legion1', default='lotar@192.168.1.243')
    parser.add_argument('--legion2', default='lotar@192.168.1.220')
    parser.add_argument('--timeout', type=int, default=360)
    args = parser.parse_args()
    if os.environ.get('SWARMLET_IDLE_WINDOW') != '1':
        parser.error('must be invoked inside the authorized idle maintenance window (SWARMLET_IDLE_WINDOW=1)')
    def require_production_stopped():
        try:
            conn = socket.create_connection(('127.0.0.1', 8099), timeout=2)
        except OSError:
            return
        conn.close()
        raise RuntimeError('production :8099 is listening; refusing fault tests')
    require_production_stopped()
    token = json.loads(args.config.read_text())['adminToken']
    evidence = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'steps': [], 'success': False}
    deployment_id = None
    node_may_be_stopped = False
    paused_agent = None
    last_state = None
    def save():
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(evidence, indent=2) + '\n')
    def record(step, **details):
        evidence['steps'].append({'step': step, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), **details})
        save()
        print(step, flush=True)
    def api(path, method='GET', body=None, timeout=15, headers=None):
        req = urllib.request.Request(args.control_url.rstrip('/') + path, method=method,
            data=json.dumps(body).encode() if body is not None else (b'' if method == 'POST' else None),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Connection': 'close', **(headers or {})})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if path == "/v1/chat/completions" and response.headers.get("x-swarmlet-deployment") != deployment_id:
                raise AssertionError("router did not serve the pinned deployment")
            return json.load(response)
    def wait(label, check, timeout=None):
        start = time.monotonic()
        last_error = None
        while time.monotonic() - start < (timeout or args.timeout):
            try:
                result = check()
                if result:
                    record(label, seconds=round(time.monotonic()-start, 2))
                    return result
            except (OSError, urllib.error.URLError, TimeoutError) as exc:
                last_error = str(exc)
            time.sleep(1)
        raise TimeoutError(f'{label}: timeout; last state={last_state}; last error={last_error}')
    def deployment():
        nonlocal last_state
        dep = api('/api/deployments/' + deployment_id)
        last_state = {'state': dep['state'], 'error': dep.get('error'), 'assignments': [
            {'id': a['id'], 'nodeId': a['nodeId'], 'state': a['state'], 'kind': a['body']['kind']} for a in dep.get('assignments', [])]}
        return dep
    def ready(label):
        dep = wait(label, lambda: (d if (d := deployment())['state'] == 'ready' else None))
        active = [a for a in dep['assignments'] if a['state'] != 'stopped']
        if len(active) != 3 or {a['nodeId'] for a in active} != required_nodes:
            raise AssertionError('ready deployment must have exactly one assignment per rig node')
        if dep['plan']['tensorSplit'] != [3, 3, 18]:
            raise AssertionError('expected verified 3/3/18 split')
        record(label + '-assignments', deployment=last_state, split=dep['plan']['tensorSplit'])
        return {a['id'] for a in active}
    def request(label):
        require_production_stopped()
        start = time.monotonic()
        response = api('/v1/chat/completions', 'POST', {'model': 'qwen3.5-2b',
            'messages': [{'role': 'user', 'content': 'Reply with the word OK.'}], 'max_tokens': 24,
            'temperature': 0, 'stream': False}, timeout=180, headers={'x-swarmlet-deployment': deployment_id})
        choices = response.get('choices', [])
        if not choices or not (choices[0].get('message', {}).get('content') or choices[0].get('message', {}).get('reasoning_content')):
            raise AssertionError('routed request returned no generated output')
        record(label, seconds=round(time.monotonic()-start, 2), response=response)
    def ssh(host, command):
        subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command],
            check=True, timeout=45, capture_output=True, text=True)
    def remote_python(host, source, argument):
        command = 'python3 - ' + shlex.quote(json.dumps(argument))
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command],
            input=source, check=True, timeout=30, capture_output=True, text=True)
        return json.loads(result.stdout)
    def node_snapshots():
        with urllib.request.urlopen('http://127.0.0.1:47800/api/status', timeout=10) as response:
            snapshots = [(None, json.load(response))]
        for host in [args.legion1, args.legion2]:
            result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
                'curl -fsS --max-time 10 http://127.0.0.1:47800/api/status'], check=True, timeout=25, capture_output=True, text=True)
            snapshots.append((host, json.loads(result.stdout)))
        return snapshots
    def local_assignments():
        return [a for _, snapshot in node_snapshots() for a in snapshot.get('assignments', []) if a['deploymentId'] == deployment_id]
    def process_audit(label, expected_count):
        # Inspect OS executables and listening sockets independently of the agent's accounting.
        reports = []
        bodies = {a['id']: a['body'] for a in deployment().get('assignments', [])}
        for host, snapshot in node_snapshots():
            expected = [a for a in snapshot.get('assignments', []) if a['deploymentId'] == deployment_id]
            for assignment in expected:
                body = bodies[assignment['id']]
                assignment['expectedEnginePorts'] = [body[k] for k in ('port', 'peerPort') if body.get(k)]
            payload = {'expected': expected}
            if host:
                report = remote_python(host, PROCESS_AUDIT, payload)
            else:
                result = subprocess.run([sys.executable, '-', json.dumps(payload)], input=PROCESS_AUDIT,
                    capture_output=True, text=True, check=True, timeout=30)
                report = json.loads(result.stdout)
            report['nodeId'] = snapshot['nodeId']
            reports.append(report)
        record(label, nodes=reports)
        if sum(len(r['processes']) for r in reports) != expected_count or any(r['errors'] for r in reports):
            raise AssertionError('OS process/port audit differs from expected assignments; see evidence')
        return reports
    def agent_signal(identity, action, worker_pid=None):
        return remote_python(args.legion1, AGENT_SIGNAL, {'identity': identity, 'action': action, 'workerPid': worker_pid})
    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'interrupted by signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        nodes = api('/api/nodes')['nodes']
        by_name = {node['hostname']: node for node in nodes}
        l1, l2 = by_name['lotar-legion'], by_name['lotar-legion-2']
        macs = [n for n in nodes if n['hostname'] not in {'lotar-legion', 'lotar-legion-2'} and n['online'] and n.get('offer', {}).get('roles', {}).get('coordinator')]
        if len(macs) != 1 or not l1['online'] or not l2['online']:
            raise RuntimeError('expected the existing Mac coordinator and both Legions online')
        required_nodes = {macs[0]['id'], l1['id'], l2['id']}
        existing = api('/api/deployments')['deployments']
        candidates = [d for d in existing if d['id'] == args.deployment_id] if args.deployment_id else [d for d in existing if d['spec']['name'] == 'mesh-2b-internet']
        if len(candidates) != 1:
            raise RuntimeError('expected one standing mesh-2b-internet; pass --deployment-id for an existing replacement')
        dep = candidates[0]
        spec = dep['spec']
        if (spec['kind'] != 'split' or spec['profile'] != 'qwen35-2b-q8' or spec.get('transport') != 'relay'
                or spec.get('stopExternal') or spec.get('coordinatorNodeId') != macs[0]['id']
                or set(spec.get('workerNodeIds', [])) != {l1['id'], l2['id']}):
            raise RuntimeError('standing deployment is not the expected three-node 2B relay spec')
        plan = api('/api/deployments/plan-preview', 'POST', spec)
        if plan['tensorSplit'] != [3, 3, 18]:
            raise RuntimeError(f'current offers produce unexpected split: {plan["tensorSplit"]}')
        deployment_id = dep['id']
        evidence['deploymentId'] = deployment_id
        record('preflight', nodes=[{'id': n['id'], 'hostname': n['hostname'], 'via': n.get('via')} for n in nodes if n['id'] in required_nodes], initialState=dep['state'], plan=plan)
        if dep['state'] != 'ready':
            api('/api/deployments/' + deployment_id + '/start', 'POST', timeout=args.timeout)
        before_disconnect = ready('initial-ready')
        request('initial-inference')
        require_production_stopped()
        initial_audit = process_audit('initial-process-audit', 3)
        legion1_engines = next(r['processes'] for r in initial_audit if r['nodeId'] == l1['id'])
        if len(legion1_engines) != 1:
            raise AssertionError('expected one Legion1 worker engine before channel fault')
        paused_agent = agent_signal(None, 'identify', legion1_engines[0]['pid'])
        agent_signal(paused_agent, 'pause')
        pause_start = time.monotonic()
        try:
            wait('channel-only-legion1-offline', lambda: not next(n for n in api('/api/nodes')['nodes'] if n['id'] == l1['id'])['online'], 75)
            wait('channel-only-deployment-withdrawn', lambda: deployment()['state'] != 'ready', 45)
            # Keep the agent paused beyond the 30s heartbeat stale limit; its worker remains live.
            while time.monotonic() - pause_start < 45:
                time.sleep(1)
            state = agent_signal(paused_agent, 'inspect')
            if not state['paused'] or not state['workerAlive']:
                raise AssertionError('channel-only fault did not preserve the paused agent and live worker')
            record('channel-only-worker-survived', seconds=round(time.monotonic()-pause_start, 2), **state)
        finally:
            agent_signal(paused_agent, 'resume')
            paused_agent = None
        channel_recovered = ready('channel-only-reconnect-ready')
        if channel_recovered & before_disconnect:
            raise AssertionError('channel-only recovery retained stale assignments')
        request('after-channel-only-reconnect-inference')
        process_audit('after-channel-only-process-audit', 3)
        before_disconnect = channel_recovered
        node_may_be_stopped = True
        ssh(args.legion1, 'systemctl --user stop swarmlet-node.service')
        wait('legion1-offline', lambda: not next(n for n in api('/api/nodes')['nodes'] if n['id'] == l1['id'])['online'], 45)
        wait('deployment-withdrawn', lambda: deployment()['state'] != 'ready', 45)
        ssh(args.legion1, 'systemctl --user start swarmlet-node.service')
        node_may_be_stopped = False
        recovered = ready('reconnect-ready')
        if recovered & before_disconnect:
            raise AssertionError('disconnect recovery retained assignments from the old mesh')
        request('after-reconnect-inference')
        require_production_stopped()
        subprocess.run(['launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/ai.swarmlet.control'], check=True, capture_output=True, timeout=45)
        wait('control-all-nodes-reconnected', lambda: required_nodes <= {n['id'] for n in api('/api/nodes')['nodes'] if n['online']})
        restarted = ready('control-restart-ready')
        if restarted & recovered:
            raise AssertionError('control restart retained stale relay assignments')
        request('after-control-restart-inference')
        api('/api/deployments/' + deployment_id + '/stop', 'POST', timeout=args.timeout)
        wait('intentional-stop', lambda: deployment()['state'] == 'stopped')
        wait('no-leftover-workers', lambda: not local_assignments())
        process_audit('stopped-os-process-and-port-audit', 0)
        # Exceed the entire maximum retry delay; stopped intent must remain stopped throughout.
        start = time.monotonic()
        while time.monotonic() - start < 65:
            if deployment()['state'] != 'stopped':
                raise AssertionError('intentional stop automatically restarted')
            time.sleep(2)
        record('stayed-stopped', seconds=round(time.monotonic()-start, 2))
        api('/api/deployments/' + deployment_id + '/start', 'POST', timeout=args.timeout)
        ready('final-ready')
        request('final-inference')
        snapshots = local_assignments()
        if len(snapshots) != 3 or len({a['id'] for a in snapshots}) != 3:
            raise AssertionError('final agent snapshots contain missing or duplicate mesh assignments')
        record('final-agent-assignments', assignments=snapshots)
        process_audit('final-os-process-and-port-audit', 3)
        evidence['success'] = True
    except BaseException as exc:
        evidence['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        cleanup_errors = []
        if paused_agent:
            try:
                agent_signal(paused_agent, 'resume')
            except Exception as exc:
                cleanup_errors.append('resume Legion1 exact agent PID: ' + str(exc))
        if node_may_be_stopped:
            try:
                ssh(args.legion1, 'systemctl --user start swarmlet-node.service')
            except Exception as exc:
                cleanup_errors.append('restore Legion1: ' + str(exc))
        if deployment_id and not evidence['success']:
            try:
                api('/api/deployments/' + deployment_id + '/stop', 'POST', timeout=args.timeout)
            except Exception as exc:
                cleanup_errors.append('stop failed acceptance deployment: ' + str(exc))
        evidence['cleanupErrors'] = cleanup_errors
        evidence['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()


if __name__ == '__main__':
    main()
