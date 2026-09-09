#!/usr/bin/env python3
"""Guarded physical target-versus-ngram qualification on Mac replica and split.

Use through idle-window.py. Reuses PlacementRunner baseline/owned-resource lifecycle
and speculation-qualify's unchanged four-fixture collector and strict comparator.
"""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import sys
from types import SimpleNamespace


def load(name, path):
    loader = importlib.util.spec_from_file_location(name,path)
    module = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
placement = load('speculation_placement',HERE/'placement-qualify.py')
qualify = load('speculation_comparator',HERE/'tools/speculation-qualify.py')
matrix = placement.matrix


def catalogue(nodes):
    mac,l1,l2 = nodes
    common = dict(profile='qwen35-2b-q8',ctx=1024,parallel=1,chain=0,transport='relay')
    replica = dict(common,kind='replica',replicaNodeId=mac)
    split = dict(common,kind='split',coordinatorNodeId=mac,workerNodeIds=[l1,l2],workerLayers=[2,3])
    cases = []
    for name,spec in [('mac-replica',replica),('mac-split',split)]:
        case = dict(id=name,nodes=[mac,mac],specs=[spec,dict(spec,speculation={'type':'ngram-simple'})])
        if spec['kind']=='split':case['tensorSplit']=[2,3,19]
        cases.append(case)
    return cases


def code_provenance():
    paths = [Path(__file__),HERE/'placement-qualify.py',HERE/'mesh-matrix.py',HERE/'tools/speculation-qualify.py',
             matrix.ROOT/'swarmlet/control/planner.ts',matrix.ROOT/'swarmlet/control/deployments.ts',
             matrix.ROOT/'swarmlet/node-agent/roles/recipes.ts',matrix.ROOT/'swarmlet/control/profiles/qwen35-2b-q8.json']
    return {str(path.relative_to(matrix.ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def file_provenance(path):
    file = Path(path)
    before = file.stat()
    digest = hashlib.sha256()
    with file.open('rb') as handle:
        for chunk in iter(lambda:handle.read(8*1024*1024),b''):
            digest.update(chunk)
    after = file.stat()
    if (before.st_size,before.st_mtime_ns,before.st_ino) != (after.st_size,after.st_mtime_ns,after.st_ino):
        raise RuntimeError('model changed while recording provenance')
    return dict(path=str(file),sizeBytes=after.st_size,sha256=digest.hexdigest(),mtimeNs=after.st_mtime_ns)


def compare_to_file(baseline,candidate,output):
    """Persist the existing comparator's exact gate result; never turn failure into success."""
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            code = qualify.compare(SimpleNamespace(baseline=baseline,candidate=candidate))
        report = json.loads(captured.getvalue())
    except Exception as exc:
        report = dict(error=type(exc).__name__+': '+str(exc),comparatorOutput=captured.getvalue())
        matrix.write_json(output,report)
        raise
    matrix.write_json(output,report)
    if code != 0:
        raise RuntimeError('speculative comparison gates failed: '+str(report.get('gates')))
    return report


class SpeculationRunner(placement.PlacementRunner):
    def __init__(self,args,cases):
        super().__init__(args,cases)
        self.prefix = 'speculation-'+matrix.digest(str(self.out.resolve()))[:10]
        self.code = code_provenance()

    def arm(self,case):
        directory = self.out/'cases'/case['id']
        directory.mkdir(parents=True,exist_ok=True)
        attempt = 1
        while (directory/('attempt-'+str(attempt))).exists():attempt += 1
        directory = directory/('attempt-'+str(attempt))
        directory.mkdir()
        record = dict(status='running',complete=False,startedAt=matrix.timestamp(),modes=[],codeSha256=self.code,
                      artifactDirectory=str(directory.relative_to(self.out)))
        previous = self.results.get(case['id'])
        if previous:
            matrix.write_json(directory/'previous-result.json',previous)
        self.results[case['id']] = record
        self.save()
        try:
            outputs = []
            for index,(mode,spec) in enumerate(zip(['target','ngram'],case['specs'])):
                mode_record = dict(mode=mode,startedAt=matrix.timestamp())
                record['modes'].append(mode_record)
                self.save()
                try:
                    name = self.prefix+'-'+case['id']+'-'+mode
                    self.journal['pendingName'] = name
                    self.save()
                    ident = self.api('/api/deployments','POST',dict(spec,name=name))['id']
                    self.journal['ownedIds'].append(ident)
                    self.journal.pop('pendingName',None)
                    mode_record['deploymentId'] = ident
                    self.save()
                    self.api('/api/deployments/'+ident+'/start','POST',timeout=120)
                    deployment = self.ready(ident)
                    mode_record['deployment'] = deployment
                    endpoint = deployment['endpoint']
                    if endpoint['nodeId'] != self.args.nodes[0]:
                        raise RuntimeError('native collector endpoint is not on the local Mac')
                    if deployment['plan'].get('speculation') != spec.get('speculation'):
                        raise RuntimeError('actual plan does not match requested speculative mode')
                    startup = dict(deployment=deployment)
                    self.collect_evidence(startup)
                    mode_record['startupEvidence'] = startup
                    if case.get('tensorSplit') is not None:
                        if deployment['plan']['tensorSplit'] != case['tensorSplit']:
                            raise RuntimeError('logical split differs from requested topology')
                        mode_record['allocationProof'] = placement.allocation_proof(deployment,startup,case['tensorSplit'])
                    assignments = [a['body'] for a in deployment.get('assignments',[]) if not a.get('retired') and a.get('body',{}).get('kind') in ['replica','coordinator']]
                    if len(assignments) != 1 or assignments[0].get('speculation') != spec.get('speculation'):
                        raise RuntimeError('actual engine assignment does not match requested speculative mode')
                    model_path = assignments[0]['model']['path']
                    mode_record['model'] = file_provenance(model_path)
                    self.save()
                    output = directory/(mode+'.json')
                    mode_record['collection'] = str(output.relative_to(self.out))
                    self.save()
                    # Keep the unchanged collector's metric intervals uncontaminated: routed
                    # smoke inference happens only AFTER all four serial native fixtures finish.
                    qualify.collect(SimpleNamespace(url='http://127.0.0.1:'+str(endpoint['port']),arm=case['id']+'-'+mode,output=output))
                    outputs.append(output)
                    response = matrix.stream_request(self.args.control_url+'/v1/chat/completions',
                        {'Authorization':'Bearer '+self.token,'x-swarmlet-deployment':ident,'x-request-id':name+'-route'},
                        dict(model=endpoint['modelName'],messages=[dict(role='user',content='Name three animals.')],stream=True,
                             temperature=0,seed=42,max_tokens=64,chat_template_kwargs={'enable_thinking':False}),self.args.request_timeout)
                    mode_record['routedRequest'] = response
                    placement.verify_routes([response],{ident:self.args.nodes[0]})
                    mode_record['status'] = 'pass'
                finally:
                    ident = mode_record.get('deploymentId')
                    if ident:
                        final = dict(deployment=mode_record.get('deployment',dict(id=ident,assignments=[])))
                        self.collect_evidence(final)
                        mode_record['finalEvidence'] = final
                    mode_record['finishedAt'] = matrix.timestamp()
                    self.save()
                    try:
                        self.retire()
                    except Exception as exc:
                        record['cleanupError'] = type(exc).__name__+': '+str(exc)
                        raise
            if record['modes'][0]['model'] != record['modes'][1]['model']:
                raise RuntimeError('model provenance differs between target and ngram')
            comparison_path = directory/'comparison.json'
            record['comparisonFile'] = str(comparison_path.relative_to(self.out))
            record['comparison'] = compare_to_file(outputs[0],outputs[1],comparison_path)
            record['status'] = 'pass'
        except Exception as exc:
            record.update(status='fail',error=type(exc).__name__+': '+str(exc))
            # An ordinary inference/gate failure may leave the next topology testable.
            # Unacknowledged teardown must abort the campaign before another model load.
            if record.get('cleanupError'):
                raise
        except KeyboardInterrupt as exc:
            record.update(status='fail',error='KeyboardInterrupt: '+str(exc),interrupted=True)
            raise
        finally:
            record.update(complete=True,finishedAt=matrix.timestamp())
            self.save()
            print('CASE',case['id'],record['status'],record.get('error',''),flush=True)


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
    if len(set(args.nodes)) != 3 or args.request_timeout < 1:parser.error('three distinct node IDs and positive timeout required')
    args.out = args.out.resolve()
    if args.command=='status':
        print((args.out/'summary.json').read_text())
        return 0
    cases = catalogue(args.nodes)
    manifest = dict(cases=cases,baseline=args.deployment_id,controlUrl=args.control_url)
    args.out.mkdir(parents=True,exist_ok=True)
    with (args.out/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        path = args.out/'manifest.json'
        if path.exists() and json.loads(path.read_text()) != manifest:raise RuntimeError('manifest mismatch; use a fresh output directory')
        matrix.write_json(path,manifest)
        if args.command=='plan':
            print(json.dumps(manifest,indent=2))
            return 0
        placement.guard()
        global_path = Path.home()/'.swarmlet/mesh-matrix.lock'
        global_path.parent.mkdir(parents=True,exist_ok=True)
        with global_path.open('w') as global_lock:
            fcntl.flock(global_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            runner = SpeculationRunner(args,cases)
            def interrupt(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
            signal.signal(signal.SIGTERM,interrupt)
            if args.command=='restore':
                runner.restore()
                return 0
            runner.run()
            return 0 if len(runner.results)==len(cases) and all(r.get('status')=='pass' for r in runner.results.values()) else 1


if __name__=='__main__':
    sys.exit(main())
