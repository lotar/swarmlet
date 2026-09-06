#!/usr/bin/env python3
"""Resumable physical-rig matrix. Plan/status are read-only; run requires idle-window.py.

Results are observations, never implied passes for unsupported architectures.
The live profile is never edited. Temporary test profiles and deployments are
owned by this campaign, journalled, and removed before restoring the baseline.
"""
import argparse
import concurrent.futures
import copy
import datetime as dt
import fcntl
import hashlib
import itertools
import json
import os
from pathlib import Path
import random
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PROFILES = ROOT / 'swarmlet/control/profiles'
NODES = ['30f05a2670c368d0', '19d7c8f75e54726a', '6474b864aaf6fa5d']
SCHEMA = 1


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.replace(path)


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def catalogue(repeats=5):
    arms, seen = [], set()
    def add(group, **kw):
        arm = dict(kind='split', layers=3, workers=[1, 2], transport='relay',
                   forwarding=True, batchedGets=True, wire='off', ctx=4096,
                   slots=2, clients=1, workload='conversation', output=64,
                   entry='router', batch=None, microbatch=None, **{})
        arm.update(kw)
        identity = digest(arm)
        if identity in seen:
            return
        seen.add(identity)
        arms.append(dict(id=identity[:16], group=group, config=arm, repeats=repeats))
    # P0 remains first. Every repeat has a fresh-process arm and an exact-prefix repeat.
    add('P0', kind='replica', layers=0, workers=[])
    add('P0', layers=3)
    add('P0', layers=11)
    for transport in ['auto', 'relay']:
        for worker in [1, 2]:
            for k in range(1, 24):
                add('placement', workers=[worker], layers=k, transport=transport)
        for order in [[1, 2], [2, 1]]:
            for k in range(1, 12):
                add('placement', workers=order, layers=k, transport=transport)
    for layers, transport, forwarding, gets, wire in itertools.product(
            [3, 6, 11], ['auto', 'relay'], [False, True], [False, True], ['off', 'f16', 'q8']):
        add('execution', layers=layers, transport=transport, forwarding=forwarding,
            batchedGets=gets, wire=wire)
    for workload, clients, output in itertools.product(
            ['greeting', 'conversation', 'text128', 'text512', 'text1024', 'longchat'],
            [1, 2, 4, 8], [1, 64, 256]):
        add('workload', workload=workload, clients=clients, output=output)
    for slots in [1, 2, 4]:
        add('slots', slots=slots, ctx=2048 * slots, clients=slots)
    for batch, microbatch in [(128, 32), (512, 128), (2048, 512)]:
        add('batch', batch=batch, microbatch=microbatch)
    for entry in ['engine', 'node', 'router']:
        add('entry', entry=entry)
    # Keep the regression reproductions first; randomize the remaining arm order reproducibly.
    first = [a for a in arms if a['group'] == 'P0']
    rest = [a for a in arms if a['group'] != 'P0']
    random.Random(20260906).shuffle(rest)
    blocked = []
    def block(id, reason, configurations=None):
        blocked.append(dict(id=id, status='blocked', reason=reason, configurations=configurations))
    block('asymmetric-placement', 'Current planner assigns the same layer count to every worker; requires planner extension or a separate assignment harness.',
          [{'layers': [a, b, 24-a-b], 'workerOrder': order}
           for a in range(1, 23) for b in range(1, 24-a) if a != b
           for order in [[1, 2], [2, 1]]])
    block('legion-replicas-and-pools', 'Legions currently offer worker role only and have no registered 2B model. Replica provisioning and fit qualification are prerequisites.',
          ['L1', 'L2', 'Mac+L1', 'Mac+L2', 'L1+L2', 'Mac+L1+L2'])
    block('coordinator-relocation', 'Needs Legion coordinator/model provisioning and Mac worker qualification.')
    block('persistent-stages', 'Stage execution/session protocol does not exist.')
    block('prefill-decode-disaggregation', 'No compatible attention/recurrent-state transfer implementation.')
    block('speculative-decoding', 'This 2B profile has no compatible MTP head; needs a separately qualified model campaign.')
    block('dedicated-public-relay', 'No provisioned independent relay endpoint.')
    block('true-direct-internet', 'All three machines currently share one LAN; requires independently located endpoints.')
    block('transport-separation', 'Current agent uses shared multiplexed transport; separate channels require implementation.')
    block('network-emulation', 'No scoped, restoration-tested impairment adapter for the current Cloudflare path; old LAN netem filters do not establish impairment of this path.',
          {'addedRttMs': [0,20,50,100,200], 'jitterMs':[0,5,20], 'lossPct':[0,0.1,1,2], 'bandwidthMbit':[None,100,20,5]})
    block('graph-cache-and-prefill-scheduler', 'Requires separately built and hash-qualified engine variants; flags are not available in DeploymentSpec.')
    block('thread-sweep', 'Requires reversible per-worker offer adapter; not implemented by this runner.', [2,4,8,10])
    block('session-affinity-and-latency-routing', 'Routing policies do not yet exist.')
    block('visible-native-clients', 'No available native UI automation surface; API paths cannot substitute for visual acceptance.')
    block('legion-client-paths', 'Remote client timing adapter not implemented; do not infer its outcome from coordinator/router tests.')
    block('expanded-fault-grid', 'Existing acceptance operator covers channel pause, L1 service restart, control restart and intentional stop. Full per-node/per-phase grid needs additional fault adapters.',
          {'phases':['idle','prefill','decode'], 'faults':['disconnect-5s','disconnect-30s','disconnect-120s','engine-crash','agent-restart','relay-restart','cancel','client-retry','resource-pressure','model-mismatch']})
    block('tail-and-soak-qualification', '100-request finalist and sustained-soak campaign requires selection after screening; five repetitions are not p95 qualification.')
    ordered=first+rest
    baseline=next(a for a in first if a['config']['kind']=='split' and a['config']['layers']==3)
    for pos in range((len(ordered)//10)*10,9,-10):
        control=copy.deepcopy(baseline);control.update(id='baseline-'+str(pos),group='interleaved-baseline',repeats=1)
        ordered.insert(pos,control)
    return dict(schema=SCHEMA, model='Qwen3.5-2B-Q8_0.gguf', seed=20260906,
                arms=ordered, blocked=blocked, faultOperator='real-rig-faults.py')


def messages(workload, nonce):
    if workload == 'greeting':
        return [{'role':'user', 'content':'Reply with a short greeting. Request '+nonce}]
    if workload == 'conversation':
        return [{'role':'user','content':'Hi'}, {'role':'assistant','content':'Hello! How can I help you today?'},
                {'role':'user','content':'Sup?'}, {'role':'assistant','content':"Hey! Just checking in. How is your day going?"},
                {'role':'user','content':'What can you do? Request '+nonce}]
    if workload == 'longchat':
        result=[]
        for i in range(15):
            result += [{'role':'user','content':f'Remember item {i}.'}, {'role':'assistant','content':f'Item {i} noted.'}]
        return result+[{'role':'user','content':'Summarize the items briefly. Request '+nonce}]
    # Labels are targets, not claims about tokenization. /tokenize trims before requests.
    return [{'role':'user','content':('A small mesh exchanges data between computers. ' * int(workload[4:])) + '\nSummarize briefly. Request '+nonce}]


def stream_request(url, headers, body, timeout=180):
    start=time.monotonic()
    req=urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Content-Type':'application/json', **headers})
    result={'startedAt':timestamp(), 'firstTokenSeconds':None, 'text':'', 'done':False, 'chunks':[], 'timings':None}
    with urllib.request.urlopen(req, timeout=timeout) as response:
        result['httpStatus']=response.status
        result['headersSeconds']=time.monotonic()-start
        result['routeHeaders']={k:v for k,v in response.headers.items() if k.lower().startswith('x-swarmlet-')}
        for line in response:
            if time.monotonic()-start > timeout:
                raise TimeoutError('request exceeded wall-clock deadline')
            if not line.startswith(b'data:'):
                continue
            data=line[5:].strip()
            if data == b'[DONE]':
                result['done']=True
                break
            payload=json.loads(data)
            if payload.get('error'):
                raise RuntimeError(str(payload['error']))
            for choice in payload.get('choices', []):
                text=(choice.get('delta') or {}).get('content') or ''
                if text:
                    elapsed=time.monotonic()-start
                    if result['firstTokenSeconds'] is None:
                        result['firstTokenSeconds']=elapsed
                    result['chunks'].append(elapsed)
                    result['text']+=text
                if choice.get('finish_reason'):
                    result['finishReason']=choice['finish_reason']
            for key in ['usage','timings']:
                if payload.get(key) is not None:
                    result[key]=payload[key]
    result['totalSeconds']=time.monotonic()-start
    result['maxSilenceSeconds']=max(b-a for a,b in zip([0]+result['chunks'], result['chunks']+[result['totalSeconds']]))
    result['status']='pass' if result['done'] and result['text'] else 'fail'
    result['latencyGate']='pass' if result['firstTokenSeconds'] is not None and result['firstTokenSeconds']<=10 else 'fail'
    return result


class Runner:
    def __init__(self, args, manifest):
        self.args=args; self.out=args.out; self.manifest=manifest
        self.token=json.loads(args.config.read_text())['adminToken']
        self.prefix='matrix-'+digest(str(self.out.resolve()))[:10]
        self.journal_path=self.out/'journal.json'
        self.journal=json.loads(self.journal_path.read_text()) if self.journal_path.exists() else {'profiles':{}, 'deployment':None, 'baseline':None}
        self.results_path=self.out/'results.json'
        self.results=json.loads(self.results_path.read_text()) if self.results_path.exists() else {}

    def save(self):
        write_json(self.journal_path,self.journal)
        write_json(self.results_path,self.results)
        summary={'updatedAt':timestamp(), 'plannedArms':len(self.manifest['arms']),
                 'completedArms':len([v for k,v in self.results.items() if k!='faults' and v.get('complete')]),
                 'statuses':{}, 'blockedFamilies':len(self.manifest['blocked']), 'journal':self.journal_path.name,
                 'latencyGateFailures':sum(rep.get('latencyFailures',0) for r in self.results.values() for rep in r.get('repetitions',[]))}
        for r in self.results.values():
            status=r.get('status','unknown');summary['statuses'][status]=summary['statuses'].get(status,0)+1
        write_json(self.out/'summary.json',summary)

    def api(self, path, method='GET', body=None, timeout=30):
        req=urllib.request.Request(self.args.control_url+path, method=method,
            data=json.dumps(body).encode() if body is not None else (b'' if method=='POST' else None),
            headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json','Connection':'close'})
        with urllib.request.urlopen(req,timeout=timeout) as response:
            return json.load(response)

    def wait(self, check, seconds=600):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            value=check()
            if value: return value
            time.sleep(1)
        raise TimeoutError('readiness deadline exceeded')

    def restart_control(self):
        subprocess.run(['launchctl','kickstart','-k',f'gui/{os.getuid()}/ai.swarmlet.control'],check=True)
        def online():
            try:
                nodes=self.api('/api/nodes')['nodes']
                return all(any(n['id']==id and n['online'] for n in nodes) for id in NODES)
            except (OSError, ValueError): return False
        self.wait(online,90)

    def ready(self,id):
        def check():
            dep=self.api('/api/deployments/'+id)
            if dep['state']=='failed':raise RuntimeError(dep.get('error') or 'deployment failed')
            return dep if dep['state']=='ready' else None
        return self.wait(check)

    def retire(self):
        # Discover creations whose POST response might have been lost before journalling.
        for dep in self.api('/api/deployments')['deployments']:
            if dep['spec']['name'].startswith(self.prefix+'-'):
                self.api('/api/deployments/'+dep['id']+'/stop','POST',timeout=120)
                self.api('/api/deployments/'+dep['id'],'DELETE')
        self.journal['deployment']=None;self.save()

    def install_profiles(self):
        base=json.loads((PROFILES/'qwen35-2b-q8.json').read_text())
        for arm in self.manifest['arms']:
            cfg=arm['config']; name=self.prefix+'-'+arm['id']
            profile=copy.deepcopy(base);profile.update(id=name,name=name,modelName=self.prefix)
            profile['envelope']=[dict(workerLayers=max(1,cfg['layers']),maxCtx=cfg['ctx'],maxParallel=cfg['slots'],maxChain=0)]
            if cfg['batch']:
                profile['extraArgs']+=['-b',str(cfg['batch']),'-ub',str(cfg['microbatch'])]
            path=PROFILES/(name+'.json');content=json.dumps(profile,indent=2)+'\n'
            if path.exists() and path.read_text()!=content:raise RuntimeError('profile ownership conflict: '+path.name)
            self.journal['profiles'][str(path)]=hashlib.sha256(content.encode()).hexdigest();self.save()
            path.write_text(content)
        self.restart_control()

    def restore(self):
        self.retire()
        for filename,expected in list(self.journal['profiles'].items()):
            path=Path(filename)
            if path.parent!=PROFILES or not path.name.startswith(self.prefix+'-'):raise RuntimeError('invalid owned profile path')
            if path.exists():
                if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise RuntimeError('modified owned profile; refusing deletion')
                path.unlink()
            del self.journal['profiles'][filename];self.save()
        self.restart_control()
        if self.journal['baseline'] and self.journal['baseline']['running']:
            self.api('/api/deployments/'+self.args.deployment_id+'/start','POST')
            dep=self.ready(self.args.deployment_id)
            if dep['plan']['tensorSplit']!=self.journal['baseline']['split']:raise RuntimeError('baseline split not restored')
        self.journal['restoredAt']=timestamp();self.save()

    def body(self,cfg,nonce,endpoint):
        history=messages(cfg['workload'],nonce)
        # Apply chat template and count the ACTUAL prompt tokens. Reject overflow, never silently truncate a conversation.
        def tokenize():
            req=urllib.request.Request(endpoint+'/apply-template',data=json.dumps({'messages':history,'chat_template_kwargs':{'enable_thinking':False}}).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=30) as r:prompt=json.load(r)['prompt']
            req=urllib.request.Request(endpoint+'/tokenize',data=json.dumps({'content':prompt,'add_special':True}).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=30) as r:return len(json.load(r)['tokens'])
        if cfg['workload'].startswith('text'):
            target=int(cfg['workload'][4:]);full=history[0]['content'];low,high=1,len(full)
            while low<high:
                mid=(low+high+1)//2;history[0]['content']=full[:mid]
                if tokenize()<=target:low=mid
                else:high=mid-1
            history[0]['content']=full[:low]
        count=tokenize()
        if count+cfg['output']>cfg['ctx']//cfg['slots']:
            raise ValueError('prompt+output exceeds per-slot context')
        return {'model':self.prefix,'messages':history,'stream':True,'stream_options':{'include_usage':True},
                'max_tokens':cfg['output'],'temperature':0,'chat_template_kwargs':{'enable_thinking':False}}, count

    def arm(self,arm):
        id=arm['id'];cfg=arm['config']
        record=self.results.setdefault(id,{'status':'running','complete':False,'repetitions':[]})
        if record.get('complete'):return
        for rep in range(len(record['repetitions']),arm['repeats']):
            self.retire()
            spec={'name':self.prefix+'-'+id,'profile':self.prefix+'-'+id,'kind':cfg['kind'],
                  'ctx':cfg['ctx'],'parallel':cfg['slots'],'transport':cfg['transport'],
                  'forwarding':cfg['forwarding'],'batchedGets':cfg['batchedGets'],'wire':cfg['wire']}
            if cfg['kind']=='replica':spec['replicaNodeId']=NODES[0]
            else:spec.update(coordinatorNodeId=NODES[0],workerNodeIds=[NODES[i] for i in cfg['workers']])
            dep=self.api('/api/deployments','POST',spec);self.journal['deployment']=dep['id'];self.save()
            load=time.monotonic();self.api('/api/deployments/'+dep['id']+'/start','POST');dep=self.ready(dep['id'])
            endpoint='http://127.0.0.1:'+str(dep['endpoint']['port'])
            result={'rep':rep,'loadSeconds':time.monotonic()-load,'deployment':dep,'samples':[],'requests':[]}
            body,tokens=self.body(cfg,f'{id}-{rep}',endpoint);result['promptTokens']=tokens
            base={'engine':endpoint,'node':'http://127.0.0.1:47800','router':self.args.control_url}[cfg['entry']]
            headers={'x-swarmlet-deployment':dep['id']}
            if cfg['entry']=='router':headers['Authorization']='Bearer '+self.token
            for cache in ['process-cold','prefix-repeat']:
                with concurrent.futures.ThreadPoolExecutor(max_workers=cfg['clients']) as pool:
                    futures=[pool.submit(stream_request,base+'/v1/chat/completions',headers,body,self.args.request_timeout) for _ in range(cfg['clients'])]
                    while not all(f.done() for f in futures):
                        result['samples'].append({'at':timestamp(),'nodes':self.api('/api/nodes')['nodes'],'routing':self.api('/api/routing')})
                        time.sleep(2)
                    for future in futures:
                        try:r=future.result()
                        except Exception as exc:r={'status':'fail','error':type(exc).__name__+': '+str(exc)}
                        r['cacheCondition']=cache
                        if r.get('firstTokenSeconds') is not None:
                            r['latencyGate']='pass' if r['firstTokenSeconds']<=(5 if cache=='prefix-repeat' else 10) else 'fail'
                        result['requests'].append(r)
                # A failed/timeout request may still have work draining. Stop the arm rather than admitting more work.
                if any(r['status']=='fail' for r in result['requests']):break
            status=json.load(urllib.request.urlopen('http://127.0.0.1:47800/api/status',timeout=10))
            result['actualTransports']=[a.get('detail') for a in status['assignments'] if a['deploymentId']==dep['id']]
            for a in status['assignments']:
                if a['deploymentId']==dep['id']:
                    result.setdefault('logs',{})[a['id']]=json.load(urllib.request.urlopen('http://127.0.0.1:47800/api/logs?assignment='+a['id']+'&lines=1000',timeout=10))
            write_json(self.out/'arms'/id/(str(rep)+'.json'),result)
            record['repetitions'].append({'file':f'arms/{id}/{rep}.json','status':'pass' if all(r['status']=='pass' for r in result['requests']) else 'fail',
                'latencyFailures':sum(r.get('latencyGate')=='fail' for r in result['requests'])})
            self.save()
            print('ARM',id,'rep',rep+1,'/',arm['repeats'],record['repetitions'][-1],flush=True)
        record['complete']=True
        record['status']='pass' if all(r['status']=='pass' for r in record['repetitions']) else 'fail'
        self.save()

    def run(self):
        if os.environ.get('SWARMLET_IDLE_WINDOW')!='1':raise RuntimeError('run inside idle-window.py; do not set its marker manually')
        try:
            connection=socket.create_connection(('127.0.0.1',8099),timeout=2)
        except OSError:pass
        else:
            connection.close()
            raise RuntimeError('production is still listening')
        dep=self.api('/api/deployments/'+self.args.deployment_id)
        if self.journal['baseline'] is None:
            if dep['state'] not in ['ready','stopped']:raise RuntimeError('baseline must be ready or intentionally stopped')
            self.journal['baseline']={'running':dep['state']=='ready','split':dep.get('plan',{}).get('tensorSplit'),'spec':dep['spec']};self.save()
        # Reject a user's local request even if it bypassed router accounting.
        if dep['state']=='ready':
            metrics=urllib.request.urlopen('http://127.0.0.1:'+str(dep['endpoint']['port'])+'/metrics',timeout=5).read().decode()
            if '\nllamacpp:requests_processing 0\n' not in metrics or '\nllamacpp:requests_deferred 0\n' not in metrics:raise RuntimeError('baseline has active local requests')
        try:
            self.api('/api/deployments/'+self.args.deployment_id+'/stop','POST',timeout=120)
            self.retire();self.install_profiles()
            for arm in self.manifest['arms']:
                if self.args.only and arm['group'] not in self.args.only:continue
                try:self.arm(arm)
                except Exception as exc:
                    record=self.results.setdefault(arm['id'],{})
                    record.update(status='fail',complete=True,error=type(exc).__name__+': '+str(exc));self.save()
                    print('ARM_FAIL',arm['id'],type(exc).__name__,str(exc),flush=True)
                    self.retire()
        finally:
            # A second signal must not interrupt restoration halfway through.
            old_int=signal.signal(signal.SIGINT,signal.SIG_IGN)
            old_term=signal.signal(signal.SIGTERM,signal.SIG_IGN)
            try:self.restore()
            finally:
                signal.signal(signal.SIGINT,old_int);signal.signal(signal.SIGTERM,old_term)
        if not self.args.only and self.journal['baseline']['running'] and 'faults' not in self.results:
            code=subprocess.run([sys.executable,str(ROOT/'swarmlet/e2e/real-rig-faults.py'),'--deployment-id',self.args.deployment_id,'--out',str(self.out/'faults.json')]).returncode
            self.results['faults']={'status':'pass' if code==0 else 'fail','exitCode':code};self.save()
            # Existing fault operator stops baseline on failure; restore original intent again.
            if code:self.api('/api/deployments/'+self.args.deployment_id+'/start','POST');self.ready(self.args.deployment_id)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['plan','run','status','restore'])
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--repeats',type=int,default=5)
    p.add_argument('--only',nargs='+',help='Explicit partial run by group; never labelled full coverage')
    p.add_argument('--control-url',default='http://127.0.0.1:47900')
    p.add_argument('--config',type=Path,default=Path.home()/'.swarmlet/control/control.json')
    p.add_argument('--deployment-id',default='dep-65bedf5278d1')
    p.add_argument('--request-timeout',type=int,default=180)
    args=p.parse_args();args.out=args.out.resolve()
    if args.repeats<1 or args.request_timeout<1:p.error('positive repeats and timeout required')
    if args.command=='status':
        print((args.out/'summary.json').read_text() if (args.out/'summary.json').exists() else 'No results yet');return 0
    manifest=catalogue(args.repeats)
    manifest['runnerSha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    manifest['fingerprint']=digest(manifest)
    args.out.mkdir(parents=True,exist_ok=True)
    with (args.out/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        global_lock=None
        if args.command!='plan':
            global_lock=(Path.home()/'.swarmlet/mesh-matrix.lock').open('w')
            fcntl.flock(global_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        target=args.out/'manifest.json'
        if target.exists() and json.loads(target.read_text())!=manifest:raise RuntimeError('manifest mismatch; use a fresh output directory')
        write_json(target,manifest)
        print('PLAN',len(manifest['arms']),'runnable arms;',len(manifest['blocked']),'blocked families;',args.repeats,'repeats',flush=True)
        if args.command=='plan':return 0
        runner=Runner(args,manifest)
        def interrupt(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
        signal.signal(signal.SIGTERM,interrupt)
        if args.command=='restore':runner.restore()
        else:runner.run()
        # Explicitly partial: blocked architecture families remain regardless of runnable passes.
        print('RUNNABLE CAMPAIGN FINISHED; full proposed matrix remains BLOCKED by manifest prerequisites',flush=True)
        return 2 if manifest['blocked'] or any(r.get('status')!='pass' for r in runner.results.values()) else 0


if __name__=='__main__':
    sys.exit(main())
