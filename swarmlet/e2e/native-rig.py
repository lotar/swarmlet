#!/usr/bin/env python3
"""Guarded routed resident-stage qualification; plan is read-only.

--cases is JSON {cases:[{id,spec}], hosts:{nodeId:sshDestination}}. Supply explicit
stage artifact paths/hashes or P/D nodes/source hash from installed inventories.
No admission records are accepted here: controller plan-preview must qualify each
case. Require two-stage, three-stage and the same P/D pair in both directions.
"""
import argparse
import fcntl
import importlib.util
import json
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

loader = importlib.util.spec_from_file_location('native_placement',Path(__file__).with_name('placement-qualify.py'))
placement = importlib.util.module_from_spec(loader)
loader.loader.exec_module(placement)
matrix = placement.matrix


def catalogue(document):
    cases = []
    ids = set()
    stages = set()
    pairs = set()
    for entry in document['cases']:
        name,spec = entry['id'],entry['spec']
        if not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name) or name in ids:
            raise ValueError('case IDs must be unique lowercase names')
        ids.add(name)
        if (spec.get('ctx'),spec.get('parallel'),spec.get('chain'),spec.get('transport')) != (1024,1,0,'relay'):
            raise ValueError('each case requires ctx1024 parallel1 chain0 relay')
        if spec.get('kind')=='stages':
            nodes = [s['nodeId'] for s in spec['stages']]
            stages.add(len(nodes))
        elif spec.get('kind')=='prefill-decode':
            nodes = [spec['prefillNodeId'],spec['decodeNodeId']]
            pairs.add(tuple(nodes))
        else:raise ValueError('native cases only')
        if len(set(nodes)) != len(nodes):raise ValueError('distinct explicit nodes required')
        cases.append(dict(id=name,specs=[spec],nodes=nodes))
    if stages != {2,3} or not pairs or any((b,a) not in pairs for a,b in pairs):
        raise ValueError('require stage2, stage3 and P/D in both directions')
    return cases


def verify_plan(case,plan):
    native = plan.get('nativeExecution',{})
    endpoints = native.get('endpoints',[])
    if native.get('mode') != case['specs'][0]['kind'] or [e['nodeId'] for e in endpoints] != case['nodes']:
        raise RuntimeError('qualified plan differs from requested ordered nodes/mode')
    digest = native.get('qualificationEvidenceSha256','')
    if len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):
        raise RuntimeError('controller qualification evidence missing')
    if (plan.get('ctx'),plan.get('parallel')) != (1024,1):raise RuntimeError('unexpected native context/parallel')
    for endpoint in endpoints:
        if not endpoint.get('binarySha256') or not endpoint.get('identity'):raise RuntimeError('qualified endpoint identity missing')
    return endpoints


def verify_health(endpoint,health,previous=None,empty=True):
    if health.get('identity') != endpoint['identity'] or health.get('binary_sha256') != endpoint['binarySha256']:
        raise RuntimeError('resident identity differs from qualified plan')
    if health.get('n_embd') != 2048 or health.get('n_vocab') != 248320 or type(health.get('pid')) is not int or health['pid']<=0:
        raise RuntimeError('invalid resident dimensions/PID')
    if previous and health['pid'] != previous['pid']:raise RuntimeError('resident worker restarted between requests')
    if empty and (health.get('session') != '' or health.get('position') != 0):raise RuntimeError('native session did not reset')


class NativeRunner(placement.PlacementRunner):
    def __init__(self,args,cases):
        super().__init__(args,cases)
        self.prefix = 'native-'+matrix.digest(str(self.out.resolve()))[:10]
        self.hosts = args.hosts

    def preflight(self):
        super().preflight()
        previews = []
        for case in self.manifest['arms']:
            plan = self.api('/api/deployments/plan-preview','POST',dict(case['specs'][0],name=self.prefix+'-'+case['id']))
            verify_plan(case,plan)
            for node in case['nodes']:
                if node != self.args.nodes[0] and node not in self.hosts:raise RuntimeError('missing SSH host for '+node)
            previews.append(dict(case=case['id'],plan=plan))
        matrix.write_json(self.out/'qualified-previews.json',previews)

    def health(self,endpoint,stopped=False):
        port = endpoint['port']
        if type(port) is not int or not 1024<=port<=65535:raise RuntimeError('invalid assigned port')
        command = ['curl','--fail','--silent','--show-error','--max-time','10','http://127.0.0.1:'+str(port)+'/health']
        if endpoint['nodeId'] != self.args.nodes[0]:
            host = self.hosts[endpoint['nodeId']]
            if not host or host.startswith('-'):raise RuntimeError('invalid SSH destination')
            command = ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',host,shlex.join(command)]
        response = subprocess.run(command,capture_output=True,text=True,timeout=20)
        if stopped:
            if response.returncode != 7:raise RuntimeError('stopped worker port is not proven closed: '+response.stderr)
            return dict(connectionRefused=True,exitCode=response.returncode)
        if response.returncode:raise RuntimeError('native health unavailable: '+response.stderr)
        return json.loads(response.stdout)

    def snapshot(self,endpoints,previous=None,wait=False):
        deadline = time.monotonic()+30
        while True:
            values = [self.health(e) for e in endpoints]
            try:
                for i,(e,h) in enumerate(zip(endpoints,values)):verify_health(e,h,previous[i] if previous else None)
                return values
            except RuntimeError:
                if not wait or time.monotonic()>=deadline:raise
                time.sleep(.2)

    def request(self,dep,chat=True,stream=True,max_tokens=32):
        path = '/v1/chat/completions' if chat else '/v1/completions'
        body = dict(model=dep['endpoint']['modelName'],stream=stream,temperature=0,max_tokens=max_tokens)
        prompt = 'Write a numbered list of one hundred animals. Start immediately with 1.'
        body.update(dict(messages=[dict(role='user',content=prompt)]) if chat else dict(prompt=prompt))
        return urllib.request.Request(self.args.control_url+path,data=json.dumps(body).encode(),headers={
            'Content-Type':'application/json','Authorization':'Bearer '+self.token,'x-swarmlet-deployment':dep['id']})

    def generate(self,dep,chat,stream):
        record = dict(chat=chat,stream=stream)
        with urllib.request.urlopen(self.request(dep,chat,stream),timeout=self.args.request_timeout) as response:
            record.update(httpStatus=response.status,routeHeaders=dict(response.headers),text='',done=False)
            if stream:
                for line in response:
                    if not line.startswith(b'data:'):continue
                    data = line[5:].strip()
                    if data==b'[DONE]':record['done']=True;break
                    value = json.loads(data)
                    if value.get('error'):raise RuntimeError(str(value['error']))
                    for choice in value.get('choices',[]):record['text'] += (choice.get('delta',{}).get('content','') if chat else choice.get('text','')) or ''
            else:
                value = json.load(response)
                record['body'] = value
                record['text'] = value['choices'][0]['message']['content'] if chat else value['choices'][0]['text']
                record['done'] = value['choices'][0].get('finish_reason') in ['stop','length']
        record['status']='pass'
        placement.verify_routes([record],{dep['id']:dep['endpoint']['nodeId']})
        return record

    def cancel_busy(self,dep,endpoints):
        # Keep a real routed generation open; admission must reject a second request.
        with urllib.request.urlopen(self.request(dep,True,True,128),timeout=self.args.request_timeout) as response:
            for line in response:
                if line.startswith(b'data:') and line[5:].strip()!=b'[DONE]':
                    value=json.loads(line[5:])
                    if any(c.get('delta',{}).get('content') for c in value.get('choices',[])):break
            else:raise RuntimeError('cancel probe received no content')
            active = [self.health(e) for e in endpoints]
            if not any(h.get('session') for h in active):raise RuntimeError('probe finished before busy/cancel could be tested')
            try:
                with urllib.request.urlopen(self.request(dep,False,False),timeout=15) as second:
                    second.read()
                raise RuntimeError('overlapping native request was accepted')
            except urllib.error.HTTPError as exc:
                body = exc.read().decode()
                if exc.code != 429 or 'busy' not in body.lower():raise RuntimeError('unexpected busy rejection: '+body)
                rejected = dict(httpStatus=exc.code,body=body)
        return dict(activeHealth=active,busy=rejected,cancelledByClosingStream=True)

    def arm(self,case):
        directory = self.out/'cases'/case['id']
        directory.mkdir(parents=True,exist_ok=True)
        attempt = 1
        while (directory/str(attempt)).exists():attempt+=1
        directory = directory/str(attempt)
        directory.mkdir()
        record = dict(status='running',complete=False,startedAt=matrix.timestamp(),requests=[],artifactDirectory=str(directory))
        self.results[case['id']] = record
        dep = None
        endpoints = []
        try:
            name = self.prefix+'-'+case['id']
            self.journal['pendingName']=name
            self.save()
            ident = self.api('/api/deployments','POST',dict(case['specs'][0],name=name))['id']
            self.journal['ownedIds'].append(ident)
            self.journal.pop('pendingName',None)
            self.save()
            self.api('/api/deployments/'+ident+'/start','POST',timeout=120)
            dep = self.ready(ident)
            record['deployment']=dep
            endpoints = verify_plan(case,dep['plan'])
            assigned=[a for a in dep.get('assignments',[]) if not a.get('retired') and a.get('body',{}).get('kind')=='stage']
            if len(assigned)!=len(endpoints):raise RuntimeError('native assignment count differs from plan')
            for endpoint in endpoints:
                matches=[a['body'] for a in assigned if a['nodeId']==endpoint['nodeId']]
                if len(matches)!=1 or any(matches[0].get(k)!=endpoint[k] for k in ['port','identity','binarySha256']):
                    raise RuntimeError('actual assignment differs from qualified endpoint')
            startup = dict(deployment=dep)
            self.collect_evidence(startup)
            record['startupEvidence']=startup
            baseline = self.snapshot(endpoints)
            record['residentHealth']=[baseline]
            for chat,stream in [(True,True),(True,False),(False,True),(False,False)]:
                record['requests'].append(self.generate(dep,chat,stream))
                record['residentHealth'].append(self.snapshot(endpoints,baseline,wait=True))
                self.save()
            record['cancelBusy']=self.cancel_busy(dep,endpoints)
            record['residentHealth'].append(self.snapshot(endpoints,baseline,wait=True))
            record['requests'].append(self.generate(dep,True,False))
            record['residentHealth'].append(self.snapshot(endpoints,baseline,wait=True))
            record['status']='pass'
        except Exception as exc:
            record.update(status='fail',error=type(exc).__name__+': '+str(exc))
        except KeyboardInterrupt as exc:
            record.update(status='fail',error=str(exc),interrupted=True)
            raise
        finally:
            if dep:
                evidence=dict(deployment=dep)
                self.collect_evidence(evidence)
                record['finalEvidence']=evidence
            try:
                self.retire()
                record['stoppedHealth']=[self.health(e,stopped=True) for e in endpoints]
            except Exception as exc:
                record.update(status='fail',cleanupError=str(exc))
                raise
            finally:
                record.update(complete=True,finishedAt=matrix.timestamp())
                matrix.write_json(directory/'result.json',record)
                self.save()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['plan','run','restore','status'])
    parser.add_argument('--cases',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--control-url',default='http://127.0.0.1:47900')
    parser.add_argument('--config',type=Path,default=Path.home()/'.swarmlet/control/control.json')
    parser.add_argument('--deployment-id',default='dep-65bedf5278d1')
    parser.add_argument('--nodes',nargs=3,default=matrix.NODES)
    parser.add_argument('--request-timeout',type=int,default=300)
    args=parser.parse_args()
    if len(set(args.nodes))!=3 or args.request_timeout<1:parser.error('three distinct nodes and positive request timeout required')
    document=json.loads(args.cases.read_text())
    cases=catalogue(document)
    args.hosts=document.get('hosts',{})
    args.out=args.out.resolve()
    args.out.mkdir(parents=True,exist_ok=True)
    manifest=dict(cases=cases,hosts=args.hosts,baseline=args.deployment_id,controlUrl=args.control_url)
    with (args.out/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        path=args.out/'manifest.json'
        if path.exists() and json.loads(path.read_text())!=manifest:raise RuntimeError('manifest mismatch; use fresh output directory')
        matrix.write_json(path,manifest)
        if args.command=='plan':print(json.dumps(manifest,indent=2));return 0
        if args.command=='status':print((args.out/'summary.json').read_text());return 0
        placement.guard()
        global_path=Path.home()/'.swarmlet/mesh-matrix.lock'
        global_path.parent.mkdir(parents=True,exist_ok=True)
        with global_path.open('w') as global_lock:
            fcntl.flock(global_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            runner=NativeRunner(args,cases)
            def interrupt(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
            signal.signal(signal.SIGTERM,interrupt)
            if args.command=='restore':runner.restore();return 0
            runner.run()
            return 0 if len(runner.results)==len(cases) and all(r.get('status')=='pass' for r in runner.results.values()) else 1


if __name__=='__main__':sys.exit(main())
