#!/usr/bin/env python3
"""Real resident-model proof. Run ONLY inside the rig owner's idle-window guard."""
import argparse, contextlib, hashlib, json, os, pathlib, shutil, signal, re, socket, subprocess, threading, time, urllib.error, urllib.request
import numpy as np

class Endpoint:
 def __init__(self,url): self.url=url
 def call(self,op,**kw):
  raw=json.dumps({'op':op,**kw}).encode();req=urllib.request.Request(self.url+'/command',raw,{'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=120) as r:return json.load(r)
  except urllib.error.HTTPError as e:raise RuntimeError(e.read().decode()) from e
 def status(self): return self.call('status')
 def reject(self,op,expected=None,**kw):
  try:self.call(op,**kw)
  except RuntimeError as ex:
   if expected and expected not in str(ex):raise AssertionError(f"wrong rejection: {ex}; expected {expected}") from ex
   return
  raise AssertionError('accepted invalid '+op)

@contextlib.contextmanager
def launch(binary,model,digest,directory,gpu,ctx):
 directory.mkdir(parents=True,exist_ok=True)
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 log=open(directory/'worker.log','w');p=subprocess.Popen([str(binary),str(model),digest,str(directory),str(port),str(gpu),str(ctx)],stdout=log,stderr=log)
 e=Endpoint(f'http://127.0.0.1:{port}');e.directory=directory
 resources={'pid':p.pid,'peak_sampled_rss_kib':0,'sample_interval_seconds':.2};sampling_done=threading.Event()
 def sample_memory():
  while not sampling_done.is_set():
   sample=subprocess.run(['ps','-o','rss=','-p',str(p.pid)],capture_output=True,text=True)
   if sample.returncode==0 and sample.stdout.strip():resources['peak_sampled_rss_kib']=max(resources['peak_sampled_rss_kib'],int(sample.stdout.strip()))
   sampling_done.wait(.2)
 sampler=threading.Thread(target=sample_memory,daemon=True);sampler.start()
 try:
  deadline=time.monotonic()+90
  while True:
   if p.poll() is not None:raise RuntimeError(f'worker exited {p.returncode}: {directory}/worker.log')
   try:e.status();break
   except (OSError,RuntimeError):
    if time.monotonic()>deadline:raise RuntimeError('worker load timed out')
    time.sleep(.2)
  yield e
 finally:
  if p.poll() is None:
   p.terminate()
   try:p.wait(timeout=15)
   except subprocess.TimeoutExpired:p.kill();p.wait()
  sampling_done.set();sampler.join(timeout=2);resources['returncode']=p.returncode;(directory/'resources.json').write_text(json.dumps(resources,indent=2));log.close()

def download_capsule(endpoint,name,path):
 offset=0
 with path.open('wb') as output:
  while True:
   chunk=endpoint.call('state_read',session='pd',file=name,offset=offset,max_bytes=262144)
   data=bytes(chunk['data']);assert chunk['next_offset']==offset+len(data);output.write(data);offset=chunk['next_offset']
   if chunk['eof']:assert offset==chunk['total_bytes'];return offset
   assert data

def upload_capsule(endpoint,name,path):
 offset=0
 with path.open('rb') as source:
  while chunk:=source.read(262144):
   ack=endpoint.call('state_write',session='pd',file=name,offset=offset,data=list(chunk));offset+=len(chunk);assert ack['next_offset']==offset
 return offset

def resign_envelope(raw,previous):
 unsigned=re.sub(r'"envelope_sha256":"[0-9a-f]{64}",','',raw)
 return raw.replace(previous,hashlib.sha256(unsigned.encode()).hexdigest())

def close_float(actual,expected,label,stats):
 a=np.asarray(actual,dtype=np.float32);b=np.asarray(expected,dtype=np.float32)
 if a.shape!=b.shape:raise AssertionError(f'{label}: shape {a.shape} != {b.shape}')
 if not (np.isfinite(a).all() and np.isfinite(b).all()):raise AssertionError(f'{label}: nonfinite float output')
 delta=float(np.max(np.abs(a-b))) if a.size else 0
 stats['max_abs']=max(stats.get('max_abs',0),delta)
 stats.setdefault('comparisons',[]).append({'label':label,'max_abs':delta,'values':int(a.size)})
 # Fixed in advance. Never relaxed based on outcomes.
 if not np.allclose(a,b,rtol=1e-4,atol=1e-3):raise AssertionError(f'{label}: float mismatch max_abs={delta}')

def full_run(e,prompt,n,layer):
 s=e.status()['session']
 if s:e.call('reset',session=s)
 outputs=[];result=e.call('eval',session='proof',position=0,tokens=prompt,capture_layer=layer);outputs.append(result)
 for _ in range(n):
  result=e.call('eval',session='proof',position=result['position'],tokens=[result['token']],capture_layer=layer);outputs.append(result)
 return outputs

def validate_args(a):
 if not 1<=a.tokens<=128:raise ValueError('tokens must be 1..128 for real continuation qualification')
 if not 64<=a.ctx<=32768:raise ValueError('context must be 64..32768')

def main(a):
 validate_args(a)
 if os.environ.get('SWARMLET_IDLE_WINDOW')!='1':raise RuntimeError('Run through idle-window.py; no model loads outside the rig guard')
 def terminate(signum,frame):raise RuntimeError(f'interrupted signal {signum}')
 signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
 out=a.out;out.mkdir(parents=True,exist_ok=False);evidence={'schema':1,'qualified':False,'model_sha256':a.sha,'worker_sha256':hashlib.sha256(a.binary.read_bytes()).hexdigest(),'results':[],'float_tolerance':{'atol':1e-3,'rtol':1e-4}}
 def save(): (out/'result.json').write_text(json.dumps(evidence,indent=2))
 try:
  for count,modeldir in [(2,a.two),(3,a.three)]:
   shards=json.loads((modeldir/'manifest.json').read_text());assert len(shards)==count
   with launch(a.binary,a.model,a.sha,out/f'baseline-{count}',a.gpu,a.ctx) as baseline:
    prompt=baseline.call('tokenize',text='The red box has three blue marbles. How many blue marbles are in the box?')['tokens'];assert len(prompt)<=64
    refs={s['end']:full_run(baseline,prompt,a.tokens,s['end']-1) for s in shards[:-1]}
    expected=list(refs.values())[0]
    artifact={f'boundary_{cut}_step_{step}':np.asarray(r['boundary'],dtype=np.float32) for cut,rs in refs.items() for step,r in enumerate(rs)}
    artifact.update({f'logits_step_{step}':np.asarray(r['logits'],dtype=np.float32) for step,r in enumerate(expected)})
    np.savez_compressed(out/f'baseline-{count}.npz',**artifact)
    # Different capture settings must not change the uninterrupted token stream.
    for ref in refs.values():assert [x['token'] for x in ref]==[x['token'] for x in expected]
   with contextlib.ExitStack() as stack:
    stages=[stack.enter_context(launch(a.binary,pathlib.Path(s['path']),s['sha256'],out/f'chain-{count}-{i}',a.gpu,a.ctx)) for i,s in enumerate(shards)]
    pids=[e.status()['pid'] for e in stages];stats={};pos=0
    stages[0].reject('export',session='invalid',file='never.state');assert stages[0].status()['session']==''
    for headers in [{'Host':'rebinding.invalid'},{'Origin':'http://evil.invalid'},{'Host':'localhost:9999','Origin':'http://localhost:8888'},{'Content-Type':'text/plain'}]:
     h={'Content-Type':'application/json',**headers};req=urllib.request.Request(stages[0].url+'/command',json.dumps({'op':'reset','session':''}).encode(),h)
     try:urllib.request.urlopen(req,timeout=10)
     except urllib.error.HTTPError as ex:assert ex.code==403
     else:raise AssertionError('accepted nonlocal HTTP request')
    for step,ref in enumerate(expected):
     tokens=prompt if step==0 else [expected[step-1]['token']]
     value={'tokens':tokens}
     for i,(e,s) in enumerate(zip(stages,shards)):
      result=e.call('eval',session='proof',position=pos,**value)
      if i<count-1:
       close_float(result['activations'],refs[s['end']][step]['boundary'],f'chain{count}stage{i}step{step}',stats);value={'activations':result['activations']}
      else:
       close_float(result['logits'],ref['logits'],f'chain{count}logits{step}',stats);assert result['token']==ref['token']
     pos=result['position']
    assert [e.status()['pid'] for e in stages]==pids
    stages[0].reject('eval',session='other',position=pos,tokens=[1]);stages[0].reject('eval',session='proof',position=0,tokens=[1]);stages[0].reject('eval',session='proof',position=pos,tokens=[-1])
    for e in stages:e.call('reset',session='proof');assert e.status()['position']==0
    evidence['results'].append({'test':f'{count}-stages','tokens':len(expected),'resident_pids':pids,'endpoint_status':[e.status() for e in stages],'generated_token_ids':[x['token'] for x in expected],'max_abs':stats['max_abs'],'comparisons':stats['comparisons'],'passed':True});save()
  # Complete recurrent + attention state migrates to another resident full-model process.
  with launch(a.binary,a.model,a.sha,out/'prefill',a.gpu,a.ctx) as prefill:
   prompt=prefill.call('tokenize',text='Write the sequence of prime numbers starting at two:')['tokens']
   initial=prefill.call('eval',session='pd',position=0,tokens=prompt)
   meta=prefill.call('export',session='pd',file='transfer.state')
   transfer=out/'pd-transfer';transfer.mkdir();transferred={}
   for suffix in ['', '.json']:transferred[suffix]=download_capsule(prefill,'transfer.state'+suffix,transfer/('transfer.state'+suffix))
   prefill.reject('state_read',session='wrong',file='transfer.state',offset=0,max_bytes=262144)
   prefill.reject('state_read',session='pd',file='transfer.state',offset=0,max_bytes=262145)
   for suffix in ['', '.json']:prefill.call('state_delete',session='pd',file='transfer.state'+suffix)
   reference=[];r=initial
   for _ in range(a.tokens):r=prefill.call('eval',session='pd',position=r['position'],tokens=[r['token']]);reference.append(r)
  with launch(a.binary,a.model,a.sha,out/'decode',a.gpu,a.ctx) as decode:
   decode.reject('state_write',session='pd',file='transfer.state',offset=1,data=[1])
   for suffix in ['', '.json']:assert upload_capsule(decode,'transfer.state'+suffix,out/'pd-transfer'/('transfer.state'+suffix))==transferred[suffix]
   decode.reject('state_write',session='pd',file='transfer.state',offset=0,data=[1])
   decode.reject('import',session='',file='transfer.state');decode.reject('import',session='x'*129,file='transfer.state');decode.reject('import',session='wrong',file='transfer.state');decode.reject('import',session='pd',file='../transfer.state')
   imported=decode.call('import',session='pd',file='transfer.state');assert imported['evaluated_tokens']==0
   stats={};close_float(imported['logits'],initial['logits'],'import logits',stats)
   r=initial
   for ref in reference:
    r=decode.call('eval',session='pd',position=r['position'],tokens=[r['token']]);close_float(r['logits'],ref['logits'],'pd continuation',stats);assert r['token']==ref['token']
   decode.call('reset',session='pd')
   capsule=out/'decode'/'transfer.state';original=capsule.read_bytes();capsule.write_bytes(original[:-1]);decode.reject('import',session='pd',file='transfer.state');assert decode.status()['position']==0;capsule.write_bytes(original)
   manifest=out/'decode'/'transfer.state.json';original_manifest=manifest.read_text();old=json.loads(original_manifest);forged=resign_envelope(original_manifest.replace(old['identity']['model_sha256'],'0'*64),old['envelope_sha256']);manifest.write_text(forged);decode.reject('import',expected='state identity mismatch',session='pd',file='transfer.state');assert decode.status()['position']==0;manifest.write_text(original_manifest)
   for field in ['position','last_logits']:
    bad=json.loads(json.dumps(old))
    if field=='position':bad[field]+=1
    else:bad[field][0]+=1
    manifest.write_text(json.dumps(bad));decode.reject('import',expected='envelope integrity mismatch',session='pd',file='transfer.state');assert decode.status()['position']==0
   # Recompute the envelope for a wrong position: native memory position must still reject it.
   forged=re.sub(r'"position":\d+',f'"position":{old["position"]+1}',original_manifest)
   forged=resign_envelope(forged,old['envelope_sha256'])
   manifest.write_text(forged);decode.reject('import',expected='state position metadata mismatch',session='pd',file='transfer.state');assert decode.status()['position']==0
   manifest.write_text(json.dumps(old))
   for suffix in ['', '.json']:decode.call('state_delete',session='pd',file='transfer.state'+suffix)
   evidence['results'].append({'test':'prefill-decode-full-state','state_bytes':meta['bytes'],'chunk_transfer_bytes':transferred,'decode_prefill_tokens':imported['evaluated_tokens'],'continuation_tokens':len(reference),'generated_token_ids':[x['token'] for x in reference],'endpoint_status':decode.status(),'max_abs':stats['max_abs'],'comparisons':stats['comparisons'],'passed':True})
  evidence['qualified']=True;save();print(json.dumps(evidence))
 except BaseException as ex:evidence['error']=str(ex);save();raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--binary',type=pathlib.Path,required=True);p.add_argument('--model',type=pathlib.Path,required=True);p.add_argument('--sha',required=True);p.add_argument('--two',type=pathlib.Path,required=True);p.add_argument('--three',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--gpu',type=int,default=999);p.add_argument('--ctx',type=int,default=256);p.add_argument('--tokens',type=int,default=8);main(p.parse_args())
