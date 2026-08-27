#!/usr/bin/env python3
"""Validate/benchmark the loopback Qwen expert-cell service."""
from __future__ import annotations
import json,os,re,socket,subprocess,sys,threading,time,urllib.error,urllib.request
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','1');os.environ.setdefault('OPENBLAS_NUM_THREADS','1');os.environ.setdefault('VECLIB_MAXIMUM_THREADS','1')
LLAMA=Path(os.environ.get('LLAMA_CPP','/Users/lotar/projects/local-llm/llama.cpp-rpc'));sys.path.insert(0,str(LLAMA/'gguf-py'))
import numpy as np
from cell import QwenExpertCell,deterministic_activation,softmax_top10,streamed_reference
from binary_protocol import encode_service_request,decode_service_response
from signing import verify_manifest
SHARD=Path(os.environ.get('QWEN_SHARD','/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00005.gguf'));HERE=Path(__file__).parent;SERVICE_PORT=9590;BACKEND=os.environ.get('QWEN_EXPERT_BACKEND','mlx');PARITY_ABS=1e-3 if BACKEND=='mlx' else 2e-5

def rss_kb(pid):
 out=subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True).strip()
 if not out:raise RuntimeError(f'RSS unavailable for live pid {pid}')
 return int(out)
def proof_children_rss():
 s=subprocess.check_output(['ps','-axo','rss=,command='],text=True);total=0
 for l in s.splitlines():
  if 'qwen-flash-experts/' in l and ('server.py' in l or 'worker.py' in l):total+=int(l.strip().split()[0])
 return total
def swap_mb():
 s=subprocess.check_output(['sysctl','vm.swapusage'],text=True);m=re.search(r'used = ([\d.]+)M',s)
 if not m:raise RuntimeError('swap telemetry unavailable')
 return float(m.group(1))
def request_url(url,obj=None,timeout=180):
 if obj is None:r=urllib.request.urlopen(url,timeout=timeout)
 else:
  raw=json.dumps(obj,separators=(',',':')).encode();r=urllib.request.urlopen(urllib.request.Request(url,data=raw,headers={'content-type':'application/json'}),timeout=timeout)
 with r:return json.load(r)
def req(path,obj=None,timeout=180):return request_url(f'http://127.0.0.1:{SERVICE_PORT}{path}',obj,timeout)
def port_free(p):
 s=socket.socket()
 try:s.bind(('127.0.0.1',p));return True
 except OSError:return False
 finally:s.close()

def main():
 if not SHARD.exists():raise SystemExit(f'missing {SHARD}')
 for p in [9581,9582,9583,9584,9590]:
  if not port_free(p):raise SystemExit(f'safety: port {p} occupied')
 base_rss=rss_kb(os.getpid());base_swap=swap_mb();peak=[0];sample_error=[];done=threading.Event()
 def sample():
  while not done.wait(.05):
   try:peak[0]=max(peak[0],rss_kb(os.getpid())+proof_children_rss()-base_rss)
   except Exception as e:sample_error.append(str(e));return
 sampler=threading.Thread(target=sample,daemon=True);sampler.start()
 refcell=QwenExpertCell(SHARD,HERE/'worker.py',backend=BACKEND);X=deterministic_activation()[None,:];ids,w=softmax_top10(X,refcell.router);reference=streamed_reference(refcell.T,X,ids,w)
 env=os.environ.copy();env['PYTHONPATH']=os.pathsep.join([str(HERE),str(LLAMA/'gguf-py')]);env.update({'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
 server=subprocess.Popen([sys.executable,str(HERE/'server.py'),'--port',str(SERVICE_PORT),'--shard',str(SHARD),'--backend',BACKEND],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 try:
  for _ in range(600):
   if server.poll() is not None:raise RuntimeError(server.stderr.read())
   try:req('/health');break
   except:time.sleep(.02)
  else:raise RuntimeError('service startup timeout')
  manifest=req('/manifest');epoch=manifest['placementEpoch'];assert manifest['selectedExperts']==refcell.selected and manifest['placement']==refcell.placement and manifest['replicas']=={'n2':'n4'} and manifest['backend']==BACKEND;assert len(epoch)==64 and manifest['epochSigned'] is True and verify_manifest(manifest);assert all(len(x)==64 for x in manifest['nodeContentDigests'].values())
  print('[qwen-service] epoch',epoch[:16],'placement',manifest['placement'],flush=True)
  def forward_json(Xb,profile,ep=epoch):
   t=time.perf_counter();r=req('/v1/ffn',{'placementEpoch':ep,'activations':Xb.tolist(),'profile':profile});return np.asarray(r['output'],dtype=np.float32),(time.perf_counter()-t)*1000,float(r['durationMs'])
  def forward_bin(Xb,profile,ep=epoch):
   raw=encode_service_request(Xb,profile,ep);t=time.perf_counter();request=urllib.request.Request(f'http://127.0.0.1:{SERVICE_PORT}/v1/ffn-bin',data=raw,headers={'content-type':'application/octet-stream'})
   with urllib.request.urlopen(request,timeout=180) as r:data=r.read()
   out,returned_epoch=decode_service_response(data);assert returned_epoch==epoch;return out,(time.perf_counter()-t)*1000
  actual,_,_=forward_json(X,'lan');max_abs=float(np.max(np.abs(actual-reference)));max_rel=float(np.max(np.abs(actual-reference)/np.maximum(np.abs(reference),1e-6)));assert max_abs<PARITY_ABS and max_rel<5e-3,(max_abs,max_rel)
  binary,binary_lan=forward_bin(X,'lan');binary_abs=float(np.max(np.abs(binary-reference)));assert binary_abs<0.02,binary_abs

  # Multi-row parity with a deterministic rank swap that preserves the top-10 set.
  base=np.asarray(refcell.selected);logits=refcell.router@X[0];swapped=None
  for pos in range(len(base)-1):
   i,j=int(base[pos]),int(base[pos+1]);direction=refcell.router[j]-refcell.router[i];diff=float(logits[i]-logits[j])
   z=X[0]+1.01*diff/(float(direction@direction)+1e-12)*direction;ri,_=softmax_top10(z[None,:],refcell.router)
   if set(map(int,ri[0]))==set(refcell.selected) and list(map(int,ri[0]))!=refcell.selected:swapped=z;break
  assert swapped is not None,'could not construct same-set rank swap'
  X4=np.asarray([X[0],swapped,X[0]*.95,X[0]*1.05],dtype=np.float32);ids4,w4=softmax_top10(X4,refcell.router);assert any(list(map(int,row))!=refcell.selected for row in ids4)
  ref4=streamed_reference(refcell.T,X4,ids4,w4);act4,_,_=forward_json(X4,'lan');batch4_abs=float(np.max(np.abs(act4-ref4)));assert batch4_abs<PARITY_ABS,batch4_abs

  # Malformed JSON and stale epochs fail as structured client errors.
  try:request_url(f'http://127.0.0.1:{SERVICE_PORT}/v1/ffn',[1,2,3]);raise AssertionError('scalar/list body accepted')
  except urllib.error.HTTPError as e:assert e.code==400
  try:request_url('http://127.0.0.1:9581/execute',[1]);raise AssertionError('worker list body accepted')
  except urllib.error.HTTPError as e:assert e.code==400
  # Epoch enforced at both public and worker boundaries.
  try:forward_json(X,'lan','0'*64);raise AssertionError('stale public epoch accepted')
  except urllib.error.HTTPError as e:assert e.code==409
  owned=manifest['placement']['n1'][0]
  try:request_url('http://127.0.0.1:9581/execute',{'placementEpoch':'0'*64,'activations':X.tolist(),'assignments':[{'expertId':owned,'weights':[1.0]}]});raise AssertionError('stale worker epoch accepted')
  except urllib.error.HTTPError as e:assert e.code==409

  # Placement epoch is strict: nonresident routes fail closed.
  outsider=None
  for seed in range(381,500):
   z=deterministic_activation(seed)[None,:];ri,_=softmax_top10(z,refcell.router)
   if set(map(int,ri[0]))!=set(refcell.selected):outsider=z;break
  assert outsider is not None
  try:forward_json(outsider,'lan');raise AssertionError('nonresident route accepted')
  except urllib.error.HTTPError as e:assert e.code==409

  # Binary FP16 data plane benchmark; JSON batch-1 retained as instrumentation baseline.
  benches={};json_bench={}
  for profile in ['lan','eu']:
   js=[]
   for _ in range(2):_,ms,_=forward_json(X,profile);js.append(ms)
   json_bench[profile]=float(np.median(js))
   for B in [1,4,16]:
    Xb=X*np.linspace(.85,1.15,B,dtype=np.float32)[:,None];samples=[]
    for _ in range(3):_,ms=forward_bin(Xb,profile);samples.append(ms)
    med=float(np.median(samples));benches[f'{profile}_b{B}']={'apiMedianMs':med,'throughput':B*1000/med};print(f'[qwen-binary bench] {profile} batch={B} api={med:.1f}ms throughput={B*1000/med:.2f}tok/s',flush=True)
  assert benches['eu_b1']['apiMedianMs']-benches['lan_b1']['apiMedianMs']>=15

  # Warm exact replica: primary loss still produces the same FP16 result.
  req('/admin/stop-owner',{'nodeId':'n2','placementEpoch':epoch});replica_out,replica_ms=forward_bin(X,'lan');assert float(np.max(np.abs(replica_out-binary)))<1e-6
  # Primary + replica loss fails closed.
  req('/admin/stop-owner',{'nodeId':'n4','placementEpoch':epoch});failed=False
  try:forward_bin(X,'lan')
  except urllib.error.HTTPError as e:failed=e.code==503
  assert failed
  req('/admin/start-owner',{'nodeId':'n2','placementEpoch':epoch});req('/admin/start-owner',{'nodeId':'n4','placementEpoch':epoch});retry,_,_=forward_json(X,'lan');assert float(np.max(np.abs(retry-reference)))<PARITY_ABS

  proof_rss=rss_kb(os.getpid())+proof_children_rss()-base_rss;peak[0]=max(peak[0],proof_rss);swap=max(0,swap_mb()-base_swap);assert not sample_error,sample_error;assert peak[0]<900*1024,peak[0]/1024;assert swap<512,swap
  eu=benches['eu_b1']['apiMedianMs'];summary={**manifest,'manifestSignatureVerified':True,'fullFfnParityMaxAbs':max_abs,'fullFfnParityMaxRel':max_rel,'batch4ParityMaxAbs':batch4_abs,'binaryFp16ParityMaxAbs':binary_abs,'binaryBenchmarks':benches,'jsonBatch1ApiMs':json_bench,'replicaFailoverMs':replica_ms,'projected48LayerEuMsPerToken':eu*48,'projected48LayerEuTokPerSec':1000/(eu*48),'proofFinalIncrementalRssMiB':proof_rss/1024,'peakAggregateRssDeltaMiB':peak[0]/1024,'swapDeltaMiB':swap,'staleEpochFailClosed':True,'nonresidentRouteFailClosed':True,'exactReplicaFailover':True,'primaryAndReplicaLossFailClosed':True,'restartParity':True,'scope':'complete layer-0 FFN (routed + shared), excluding attention/SSM/residual/KV/logits'}
  print('RESULT_JSON='+json.dumps(summary,separators=(',',':')),flush=True)
 finally:
  try:req('/shutdown',{},5)
  except:pass
  try:server.wait(timeout=20)
  except:server.kill();server.wait()
  done.set();sampler.join(timeout=2)

if __name__=='__main__':main()
