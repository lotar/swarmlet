#!/usr/bin/env python3
"""Guarded physical placement qualification. Use through idle-window.py; plan is read-only.

Reuses mesh-matrix transport, evidence and owned-deployment cleanup. No profile changes,
engine installation, model transfers, role changes or control restart are performed here.
"""
import argparse
import bisect
import concurrent.futures
import fcntl
import importlib.util
import json
import os
import re
from pathlib import Path
import signal
import socket
import struct
import sys
import threading
import urllib.request

_loader = importlib.util.spec_from_file_location('placement_matrix', Path(__file__).with_name('mesh-matrix.py'))
matrix = importlib.util.module_from_spec(_loader)
_loader.loader.exec_module(matrix)


def catalogue(nodes):
    mac, l1, l2 = nodes
    common = dict(profile='qwen35-2b-q8', ctx=1024, parallel=1, chain=0, transport='relay')
    def split(name, coordinator, workers, layers):
        return dict(id=name, specs=[dict(common, kind='split', coordinatorNodeId=coordinator,
                    workerNodeIds=workers, workerLayers=layers)], nodes=[coordinator],
                    tensorSplit=[*layers, 24-sum(layers)])
    cases = [split('asymmetric-2-3', mac, [l1,l2], [2,3]), split('asymmetric-3-2', mac, [l1,l2], [3,2])]
    for name, members in [('legion1',[l1]), ('legion2',[l2]), ('mac-legion1',[mac,l1]),
                          ('mac-legion2',[mac,l2]), ('legions',[l1,l2]), ('all',[mac,l1,l2])]:
        cases.append(dict(id='replicas-'+name, nodes=members,
            specs=[dict(common, kind='replica', replicaNodeId=node) for node in members]))
    cases += [split('coordinator-legion1', l1, [mac,l2], [2,3]), split('coordinator-legion2', l2, [mac,l1], [2,3])]
    return cases


def guard():
    if os.environ.get('SWARMLET_IDLE_WINDOW') != '1':
        raise RuntimeError('run inside idle-window.py; do not set its marker manually')
    try:
        connection = socket.create_connection(('127.0.0.1',8099), timeout=2)
    except ConnectionRefusedError:
        return
    except OSError as exc:
        raise RuntimeError('cannot establish that production port 8099 is closed') from exc
    connection.close()
    raise RuntimeError('production is still listening on 8099')


def verify_routes(requests, expected):
    """Expected maps deployment IDs to node IDs; accept only full successful streams."""
    seen = set()
    for response in requests:
        if response.get('status') != 'pass' or not response.get('text') or not response.get('done') or response.get('error'):
            raise RuntimeError('inference failed: '+str(response.get('error') or response))
        headers = {key.lower(): value for key,value in response.get('routeHeaders',{}).items()}
        deployment, node = headers.get('x-swarmlet-deployment'), headers.get('x-swarmlet-node')
        if expected.get(deployment) != node or deployment not in expected:
            raise RuntimeError('route headers do not identify an expected deployment/node: '+str(headers))
        seen.add(deployment)
    if seen != set(expected):
        raise RuntimeError('concurrent pool requests did not reach all members: missing '+str(sorted(set(expected)-seen)))


def allocation_proof(deployment, evidence, logical):
    """Prove exact blocks using actual assignment weights and native loaded-model metadata.

    Reproduce float32 cumulative normalization and upper_bound from llama-model.cpp
    lines 1459-1494, including its extra output slot. Prefer per-layer debug logs when
    present; never label a derived assignment as observed native block residency.
    """
    weights = [*logical[:-1],logical[-1]+1]
    if deployment.get('plan',{}).get('engineTensorSplit') != weights:
        raise RuntimeError('explicit placement lacks corrected engineTensorSplit')
    assignments = [a for a in deployment.get('assignments',[]) if not a.get('retired') and a.get('body',{}).get('kind')=='coordinator']
    if len(assignments) != 1:
        raise RuntimeError('expected one actual coordinator assignment for allocation proof')
    assignment = assignments[0]
    body = assignment['body']
    if body.get('tensorSplit') != weights:
        raise RuntimeError('actual coordinator assignment tensor weights do not match corrected plan')
    devices = body.get('devices',[])
    if len(devices) != len(weights) or len(set(devices)) != len(devices):
        raise RuntimeError('actual coordinator assignment devices are invalid')
    # Profile overrides that change placement would invalidate this derivation.
    if any(arg in ['--tensor-split','-ts','--device','--split-mode','-sm','-ngl','--n-gpu-layers','--gpu-layers','--override-kv'] for arg in body.get('extraArgs',[])):
        raise RuntimeError('profile overrides native placement; cannot prove exact blocks')
    logs = []
    for key in ['controlLogs','logs']:
        payload = evidence.get(key,{}).get(assignment['id']) or {}
        logs += payload.get('lines',[]) if isinstance(payload,dict) else []
    text = '\n'.join(logs)
    counts = set(int(value) for value in re.findall(r'\bn_layer_all\s*=\s*(\d+)',text))
    if counts != {sum(logical)}:
        raise RuntimeError('native loaded-model n_layer_all metadata missing or differs from logical block total')
    n_layer = counts.pop()
    offloads = {(int(a),int(b)) for a,b in re.findall(r'offloaded\s+(\d+)/(\d+)\s+layers to GPU',text)}
    if offloads != {(n_layer+1,n_layer+1)}:
        raise RuntimeError('native logs do not prove all transformer blocks and output are offloaded')
    f32 = lambda value: struct.unpack('f',struct.pack('f',value))[0]
    cumulative = []
    total = f32(0)
    for weight in weights:
        total = f32(total+f32(weight))
        cumulative.append(total)
    splits = [f32(value/total) for value in cumulative]
    mapping = [devices[bisect.bisect_right(splits,f32(f32(layer)/f32(n_layer+1)))] for layer in range(n_layer+1)]
    actual_counts = [mapping[:-1].count(device) for device in devices]
    if actual_counts != logical or mapping[-1] != devices[-1]:
        raise RuntimeError('native loader rounding does not produce requested block allocation')
    debug = {}
    for layer,device in re.findall(r'load_tensors: layer\s+(\d+) assigned to device\s+(\S+),',text):
        index = int(layer)
        if index in debug and debug[index] != device:
            raise RuntimeError('conflicting native layer allocation logs')
        debug[index] = device
    mode = 'derived-from-assignment-and-native-metadata'
    if debug:
        if debug != dict(enumerate(mapping)):
            raise RuntimeError('native per-layer allocation differs from expected or logs are incomplete')
        mode = 'observed-native-per-layer-log'
    return dict(mode=mode,assignmentId=assignment['id'],modelPath=body.get('model',{}).get('path'),
                nLayerAll=n_layer,engineWeights=weights,devices=devices,transformerBlocks=actual_counts,
                outputDevice=mapping[-1],blockDevice=mapping[:-1],nativeLogLines=logs,
                algorithm='llama-model.cpp float32 cumulative normalized weights; upper_bound(layer/(n_layer_all+1)); output occupies final slot')


class PlacementRunner(matrix.Runner):
    def __init__(self, args, cases):
        super().__init__(args, {'arms':cases,'blocked':[]})
        self.prefix = 'placement-'+matrix.digest(str(self.out.resolve()))[:10]
        self.journal.setdefault('ownedIds', [])

    def save(self):
        matrix.write_json(self.journal_path, self.journal)
        matrix.write_json(self.results_path, self.results)
        matrix.write_json(self.out/'summary.json', dict(updatedAt=matrix.timestamp(),
            plannedCases=len(self.manifest['arms']), completedCases=sum(r.get('complete',False) for r in self.results.values()),
            passedCases=sum(r.get('status')=='pass' for r in self.results.values()),
            failedCases=sum(r.get('status')=='fail' for r in self.results.values()),
            restoredAt=self.journal.get('restoredAt'), results='results.json', journal='journal.json'))

    def retire(self):
        super().retire()
        self.journal['ownedIds'] = []
        self.journal.pop('pendingName',None)
        self.save()

    def restore(self):
        self.retire()
        baseline = self.journal.get('baseline')
        if baseline:
            current = self.api('/api/deployments/'+self.args.deployment_id)
            if current['spec'] != baseline['spec']:
                raise RuntimeError('baseline spec changed; refusing to overwrite it')
            if baseline['running']:
                self.api('/api/deployments/'+self.args.deployment_id+'/start','POST')
                current = self.ready(self.args.deployment_id)
                if current.get('plan',{}).get('tensorSplit') != baseline['split']:
                    raise RuntimeError('baseline split not restored')
            elif current['state'] != 'stopped':
                self.cleanup_call('/api/deployments/'+self.args.deployment_id+'/stop','POST')
        remaining = [d['id'] for d in self.api('/api/deployments')['deployments'] if d['spec']['name'].startswith(self.prefix+'-')]
        if remaining:
            raise RuntimeError('owned deployments remain: '+str(remaining))
        self.journal['restoredAt'] = matrix.timestamp()
        self.save()

    def preflight(self):
        if self.api('/api/routing')['totals']['inflight']:
            raise RuntimeError('router has active requests')
        for dep in self.api('/api/deployments')['deployments']:
            if dep['id'] != self.args.deployment_id and dep['spec']['kind'] != 'external' and dep['state'] not in ['stopped','failed','planned'] and not dep['spec']['name'].startswith(self.prefix+'-'):
                raise RuntimeError('unrelated managed deployment is active: '+dep['id'])
        for case in self.manifest['arms']:
            for i,spec in enumerate(case['specs']):
                preview = self.api('/api/deployments/plan-preview','POST',dict(spec,name=self.prefix+'-'+case['id']+'-'+str(i)))
                if case.get('tensorSplit') is not None and preview['tensorSplit'] != case['tensorSplit']:
                    raise RuntimeError('unexpected preview tensor split: '+case['id'])
                if case.get('tensorSplit') is not None and preview.get('engineTensorSplit') != [*case['tensorSplit'][:-1],case['tensorSplit'][-1]+1]:
                    raise RuntimeError('preview lacks corrected engine weights: '+case['id'])

    def arm(self, case):
        record = dict(status='running', complete=False, startedAt=matrix.timestamp(), deployments=[], requests=[])
        self.results[case['id']] = record
        self.save()
        try:
            expected = {}
            model = None
            for i,spec in enumerate(case['specs']):
                name = self.prefix+'-'+case['id']+'-'+str(i)
                self.journal['pendingName'] = name
                self.save()
                ident = self.api('/api/deployments','POST',dict(spec,name=name))['id']
                self.journal['ownedIds'].append(ident)
                self.journal.pop('pendingName',None)
                self.save()
                self.api('/api/deployments/'+ident+'/start','POST',timeout=120)
                deployment = self.ready(ident)
                record['deployments'].append(deployment)
                endpoint = deployment['endpoint']
                if endpoint['nodeId'] != case['nodes'][i]:
                    raise RuntimeError('deployment placed on an unexpected coordinator/replica')
                if case.get('tensorSplit') is not None and deployment['plan']['tensorSplit'] != case['tensorSplit']:
                    raise RuntimeError('actual placement differs from expected tensor split')
                if case.get('tensorSplit') is not None:
                    # Capture startup logs before concurrent inference can rotate bounded log buffers.
                    startup = dict(deployment=deployment)
                    self.collect_evidence(startup)
                    record.setdefault('startupEvidence',[]).append(startup)
                    record.setdefault('allocationProofs',[]).append(allocation_proof(deployment,startup,case['tensorSplit']))
                expected[ident] = endpoint['nodeId']
                model = endpoint['modelName']
                self.save()
            # A barrier starts every unpinned pool request together. Missing coverage is a failure,
            # not rescued by pinned requests that would bypass the pooling policy under test.
            count = max(3, len(expected)*3)
            barrier = threading.Barrier(count)
            def request(i):
                barrier.wait(timeout=30)
                return matrix.stream_request(self.args.control_url+'/v1/chat/completions',
                    {'Authorization':'Bearer '+self.token, 'x-request-id':self.prefix+'-'+case['id']+'-'+str(i)},
                    dict(model=model,messages=[dict(role='user',content='Write a numbered list of twenty different animals. Start immediately with 1.')],
                         stream=True,temperature=0,seed=42,max_tokens=128,chat_template_kwargs={'enable_thinking':False}), self.args.request_timeout)
            with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
                record['requests'] = list(pool.map(request, range(count)))
            verify_routes(record['requests'],expected)
            record['status'] = 'pass'
        except Exception as exc:
            record.update(status='fail', error=type(exc).__name__+': '+str(exc))
        except KeyboardInterrupt as exc:
            record.update(status='fail', error='KeyboardInterrupt: '+str(exc), interrupted=True)
            raise
        finally:
            record['evidence'] = []
            known = {d['id']:d for d in record['deployments']}
            for ident in self.journal['ownedIds']:
                deployment = known.get(ident,dict(id=ident,assignments=[]))
                evidence = dict(deployment=deployment)
                self.collect_evidence(evidence)
                record['evidence'].append(evidence)
            record.update(complete=True, finishedAt=matrix.timestamp())
            self.save()
            print('CASE',case['id'],record['status'],record.get('error',''),flush=True)
            self.retire()

    def run(self):
        guard()
        self.preflight()
        dep = self.api('/api/deployments/'+self.args.deployment_id)
        if self.journal['baseline'] is None:
            if dep['state'] not in ['ready','stopped']:
                raise RuntimeError('baseline must be ready or intentionally stopped')
            self.journal['baseline'] = dict(running=dep['state']=='ready', split=dep.get('plan',{}).get('tensorSplit'), spec=dep['spec'])
            self.save()
        if dep['state'] == 'ready':
            # The standing rig deployment is Mac-local. Refuse an unknown remote baseline.
            if dep['endpoint']['nodeId'] != self.args.nodes[0]:
                raise RuntimeError('baseline metrics must be on the local Mac')
            with urllib.request.urlopen('http://127.0.0.1:'+str(dep['endpoint']['port'])+'/metrics', timeout=5) as response:
                metrics = '\n'+response.read().decode()
            if '\nllamacpp:requests_processing 0\n' not in metrics or '\nllamacpp:requests_deferred 0\n' not in metrics:
                raise RuntimeError('baseline has active or unreported local requests')
        self.journal.pop('restoredAt',None)
        self.save()
        try:
            self.cleanup_call('/api/deployments/'+self.args.deployment_id+'/stop','POST')
            self.retire()
            for case in self.manifest['arms']:
                if not self.results.get(case['id'],{}).get('complete'):
                    self.arm(case)
        finally:
            old_int = signal.signal(signal.SIGINT,signal.SIG_IGN)
            old_term = signal.signal(signal.SIGTERM,signal.SIG_IGN)
            try:
                self.restore()
            finally:
                signal.signal(signal.SIGINT,old_int)
                signal.signal(signal.SIGTERM,old_term)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['plan','run','restore','status'])
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--control-url',default='http://127.0.0.1:47900')
    parser.add_argument('--config',type=Path,default=Path.home()/'.swarmlet/control/control.json')
    parser.add_argument('--deployment-id',default='dep-65bedf5278d1')
    parser.add_argument('--nodes',nargs=3,default=matrix.NODES,metavar=('MAC','LEGION1','LEGION2'))
    parser.add_argument('--request-timeout',type=int,default=300)
    args = parser.parse_args()
    if len(set(args.nodes)) != 3 or args.request_timeout < 1:
        parser.error('three distinct node IDs and a positive request timeout are required')
    args.out = args.out.resolve()
    if args.command == 'status':
        print((args.out/'summary.json').read_text())
        return 0
    cases = catalogue(args.nodes)
    manifest = dict(cases=cases, baseline=args.deployment_id,controlUrl=args.control_url)
    args.out.mkdir(parents=True,exist_ok=True)
    with (args.out/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        path = args.out/'manifest.json'
        if path.exists() and json.loads(path.read_text()) != manifest:
            raise RuntimeError('manifest mismatch; use a fresh output directory')
        matrix.write_json(path,manifest)
        if args.command == 'plan':
            print(json.dumps(manifest,indent=2))
            return 0
        guard()
        global_path = Path.home()/'.swarmlet/mesh-matrix.lock'
        global_path.parent.mkdir(parents=True,exist_ok=True)
        with global_path.open('w') as global_lock:
            fcntl.flock(global_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            runner = PlacementRunner(args,cases)
            def interrupt(signum,frame):
                raise KeyboardInterrupt('signal '+str(signum))
            signal.signal(signal.SIGTERM,interrupt)
            if args.command == 'restore':
                runner.restore()
                return 0
            runner.run()
            return 0 if len(runner.results)==len(cases) and all(r.get('status')=='pass' for r in runner.results.values()) else 1


if __name__ == '__main__':
    sys.exit(main())
