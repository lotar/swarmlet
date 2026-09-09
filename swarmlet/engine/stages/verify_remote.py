#!/usr/bin/env python3
"""Guarded real LAN CUDA/Metal stages and bidirectional full-state migration."""
import argparse, contextlib, importlib.util, json, os, pathlib, shlex, signal, socket, subprocess, time
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('native_verify',HERE/'verify.py');local=importlib.util.module_from_spec(spec);spec.loader.exec_module(local)
SSH=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2']

def ssh(host,cmd):return subprocess.check_output([*SSH,host,cmd],text=True)
def free_port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

@contextlib.contextmanager
def remote_launch(a,host,model,digest,label):
 directory=a.remote_root+'/runs/'+a.out.name+'-'+label
 remote_port=int(ssh(host,"python3 -c 'import socket;s=socket.socket();s.bind((\"127.0.0.1\",0));print(s.getsockname()[1]);s.close()'"))
 port=free_port();binary=a.remote_root+'/swarmlet/engine/.build/stages-build/mesh-stage-worker'
 command=shlex.join(['python3','-u','-c',(HERE/'remote_worker.py').read_text(),binary,model,digest,directory,str(remote_port),'999',str(a.ctx)])
 log=(a.out/(label+'-ssh.log')).open('w');process=subprocess.Popen([*SSH,'-o','ExitOnForwardFailure=yes','-L',f'127.0.0.1:{port}:127.0.0.1:{remote_port}',host,command],stdin=subprocess.PIPE,stdout=log,stderr=log)
 e=local.Endpoint(f'http://127.0.0.1:{port}');e.host=host
 try:
  deadline=time.monotonic()+150
  while True:
   if process.poll() is not None:raise RuntimeError('remote worker exited; '+label+'-ssh.log')
   try:e.status();break
   except (OSError,RuntimeError):
    if time.monotonic()>deadline:raise RuntimeError('remote model readiness timed out')
    time.sleep(.5)
  yield e
 finally:
  if process.stdin:process.stdin.close()
  try:process.wait(timeout=25)
  except subprocess.TimeoutExpired:
   # A stalled SSH channel is closed so the remote supervisor receives EOF/SIGHUP.
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:process.kill();process.wait()
  log.close()
  # Refuse a successful qualification if owned remote cleanup cannot be verified.
  ownership=json.loads(ssh(host,'cat '+shlex.quote(directory+'/ownership.json')))
  if not ownership.get('stopped_at'):
   # Reconnect cleanup targets only the recorded supervisor with matching Linux start ticks.
   cleanup='''import json,os,pathlib,signal,sys,time
record=pathlib.Path(sys.argv[1]);state=json.loads(record.read_text());pid=state['supervisor_pid']
proc=pathlib.Path('/proc')/str(pid)/'stat'
if proc.exists() and proc.read_text().split()[21]==state['supervisor_start_ticks']:os.kill(pid,signal.SIGTERM)
end=time.monotonic()+20
while time.monotonic()<end:
 state=json.loads(record.read_text())
 if state.get('stopped_at'):break
 time.sleep(.2)
print(json.dumps(state))
'''
   ownership=json.loads(ssh(host,shlex.join(['python3','-c',cleanup,directory+'/ownership.json'])))
   if not ownership.get('stopped_at'):raise RuntimeError('remote supervisor did not record cleanup: '+directory)
  (a.out/(label+'-ownership.json')).write_text(json.dumps(ownership,indent=2))
  worker_log=ssh(host,'cat '+shlex.quote(directory+'/worker.log'))
  (a.out/(label+'-worker.log')).write_text(worker_log)

def mac_launch(a,model,digest,label):return local.launch(a.binary,pathlib.Path(model),digest,a.out/label,999,a.ctx)

def main(a):
 local.validate_args(a)
 if os.environ.get('SWARMLET_IDLE_WINDOW')!='1':raise RuntimeError('idle-window guard required')
 def stop(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 a.out.mkdir(parents=True,exist_ok=False)
 evidence={'schema':1,'qualified':False,'transport':'HTTP over SSH local forwards on physical LAN','ctx':a.ctx,'results':[],'float_tolerance':{'atol':1e-3,'rtol':1e-4}}
 def save(): (a.out/'result.json').write_text(json.dumps(evidence,indent=2))
 try:
  two=json.loads((a.two/'manifest.json').read_text());three=json.loads((a.three/'manifest.json').read_text())
  with mac_launch(a,a.model,a.sha,'baseline') as baseline:
   prompt=baseline.call('tokenize',text='The red box has three blue marbles. How many blue marbles are in the box?')['tokens']
   refs={end:local.full_run(baseline,prompt,a.tokens,end-1) for end in [3,6]}
   baseline_identity=baseline.status();expected=refs[3]
   local.np.savez_compressed(a.out/'baseline.npz',**{f'{field}_{cut}_{i}':local.np.asarray(r[field],dtype=local.np.float32) for cut,rs in refs.items() for i,r in enumerate(rs) for field in ['boundary','logits']})
  for count,shards in [(2,two),(3,three)]:
   with contextlib.ExitStack() as stack:
    stages=[]
    for i,s in enumerate(shards):
     if i==len(shards)-1:e=stack.enter_context(mac_launch(a,s['path'],s['sha256'],f'chain-{count}-mac'))
     else:e=stack.enter_context(remote_launch(a,a.l1 if i==0 else a.l2,'/home/lotar/swarmlet/models/stages/'+pathlib.Path(s['path']).name,s['sha256'],f'chain-{count}-legion-{i+1}'))
     status=e.status();assert status['identity']['engine']==baseline_identity['identity']['engine'];assert status['identity']['source_sha256']==a.sha;stages.append(e)
    before=[e.status() for e in stages];stats={};pos=0
    for step,ref in enumerate(expected):
     value={'tokens':prompt if step==0 else [expected[step-1]['token']]}
     for i,(e,s) in enumerate(zip(stages,shards)):
      r=e.call('eval',session='proof',position=pos,**value)
      if i<count-1:
       local.close_float(r['activations'],refs[s['end']][step]['boundary'],f'cross-chain{count}-stage{i}-step{step}',stats);value={'activations':r['activations']}
      else:local.close_float(r['logits'],ref['logits'],f'cross-chain{count}-logits{step}',stats);assert r['token']==ref['token']
     pos=r['position']
    for e,s in zip(stages,before):assert e.status()['pid']==s['pid'];e.call('reset',session='proof')
    evidence['results'].append({'test':f'cross-{count}-stage','passed':True,'endpoint_status':before,'max_abs':stats['max_abs'],'comparisons':stats['comparisons'],'generated_token_ids':[r['token'] for r in expected]});save()
  for direction in ['mac-to-cuda','cuda-to-mac']:
   src=mac_launch(a,a.model,a.sha,direction+'-source') if direction=='mac-to-cuda' else remote_launch(a,a.l1,a.remote_model,a.sha,direction+'-source')
   with src as source:
    prompt=source.call('tokenize',text='Write the sequence of prime numbers starting at two:')['tokens'];first=source.call('eval',session='pd',position=0,tokens=prompt);metadata=source.call('export',session='pd',file='transfer.state');identity=source.status()
    transfer=a.out/(direction+'-transfer');transfer.mkdir()
    for suffix in ['', '.json']:local.download_capsule(source,'transfer.state'+suffix,transfer/('transfer.state'+suffix));source.call('state_delete',session='pd',file='transfer.state'+suffix)
    reference=[];r=first
    for _ in range(a.tokens):r=source.call('eval',session='pd',position=r['position'],tokens=[r['token']]);reference.append(r)
   local.np.savez_compressed(a.out/(direction+'-reference.npz'),**{f'logits_{i}':local.np.asarray(r['logits'],dtype=local.np.float32) for i,r in enumerate([first,*reference])})
   dst=remote_launch(a,a.l1,a.remote_model,a.sha,direction+'-target') if direction=='mac-to-cuda' else mac_launch(a,a.model,a.sha,direction+'-target')
   with dst as target:
    for suffix in ['', '.json']:local.upload_capsule(target,'transfer.state'+suffix,transfer/('transfer.state'+suffix))
    imported=target.call('import',session='pd',file='transfer.state');assert imported['evaluated_tokens']==0;stats={};local.close_float(imported['logits'],first['logits'],direction+'-import-logits',stats);r=first
    for ref in reference:r=target.call('eval',session='pd',position=r['position'],tokens=[r['token']]);local.close_float(r['logits'],ref['logits'],direction+'-continuation',stats);assert r['token']==ref['token']
    target_identity=target.status()
    for suffix in ['', '.json']:target.call('state_delete',session='pd',file='transfer.state'+suffix)
    target.call('reset',session='pd')
    evidence['results'].append({'test':direction,'passed':True,'source':identity,'target':target_identity,'state_bytes':metadata['bytes'],'decode_prefill_tokens':0,'max_abs':stats['max_abs'],'comparisons':stats['comparisons'],'generated_token_ids':[r['token'] for r in reference]});save()
  evidence['qualified']=True;save();print(json.dumps({'qualified':True,'results':[(r['test'],r['max_abs']) for r in evidence['results']]}))
 except BaseException as ex:evidence['error']=str(ex);save();raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--binary',type=pathlib.Path,required=True);p.add_argument('--model',type=pathlib.Path,required=True);p.add_argument('--sha',required=True);p.add_argument('--two',type=pathlib.Path,required=True);p.add_argument('--three',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--remote-root',default='/home/lotar/.swarmlet/stage-lab/f4a228e8');p.add_argument('--remote-model',default='/home/lotar/swarmlet/models/Qwen3.5-2B-Q8_0.gguf');p.add_argument('--l1',default='lotar@192.168.1.243');p.add_argument('--l2',default='lotar@192.168.1.220');p.add_argument('--ctx',type=int,default=1024);p.add_argument('--tokens',type=int,default=8);main(p.parse_args())
