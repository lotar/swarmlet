#!/usr/bin/env python3
"""Disk-stream real Qwen experts under a hard RAM/cache cap."""
from __future__ import annotations
import argparse,collections,fcntl,json,math,os,resource,subprocess,sys,threading,time
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','1');os.environ.setdefault('OPENBLAS_NUM_THREADS','1');os.environ.setdefault('VECLIB_MAXIMUM_THREADS','1')
LLAMA=Path(os.environ.get('LLAMA_CPP','/Users/lotar/projects/local-llm/llama.cpp-rpc'));sys.path.insert(0,str(LLAMA/'gguf-py'))
import numpy as np
from gguf import GGUFReader
from gguf.quants import dequantize
MODEL=Path('/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/UD-Q4_K_XL')
NAMES=['ffn_gate_exps','ffn_up_exps','ffn_down_exps'];SHARED=['ffn_gate_shexp','ffn_up_shexp','ffn_down_shexp']
ap=argparse.ArgumentParser();ap.add_argument('--cache-mib',type=int,default=512);ap.add_argument('--rss-limit-mib',type=int,default=15360);ap.add_argument('--layers',type=int,default=48);ap.add_argument('--compute-layers',type=int,default=4);ap.add_argument('--passes',type=int,default=2);ap.add_argument('--route-churn',action='store_true');ap.add_argument('--policy',choices=['lru','pinned'],default='lru');ap.add_argument('--cached-io',action='store_true');a=ap.parse_args()

def rss_kb():
 out=subprocess.check_output(['ps','-o','rss=','-p',str(os.getpid())],text=True).strip()
 if not out:raise RuntimeError('rss unavailable')
 return int(out)
class Store:
 def __init__(self,root,cap):
  self.cap=cap;self.bytes=0;self.peak=0;self.cache=collections.OrderedDict();self.frozen=False;self.hits=0;self.misses=0;self.evictions=0;self.transient=0;self.read_bytes=0;self.read_ms=0
  self.readers=[];self.fd={};self.tensor={}
  for p in sorted(root.glob('*.gguf')):
   r=GGUFReader(str(p),'r');self.readers.append(r);fd=os.open(p,os.O_RDONLY);self.fd[str(p)]=fd
   if not a.cached_io:fcntl.fcntl(fd,fcntl.F_NOCACHE,1)
   for t in r.tensors:self.tensor[t.name]=(t,fd)
 def close(self):
  for fd in self.fd.values():os.close(fd)
 def _raw(self,t,fd,eid=None):
  if eid is None:off=t.data_offset;n=t.n_bytes;shape=t.data.shape
  else:n=t.n_bytes//int(t.shape[-1]);off=t.data_offset+eid*n;shape=t.data.shape[1:]
  st=time.perf_counter();b=os.pread(fd,n,off);self.read_ms+=(time.perf_counter()-st)*1000;self.read_bytes+=len(b)
  if len(b)!=n:raise RuntimeError(f'short pread {t.name}')
  return np.frombuffer(b,dtype=np.uint8).reshape(shape)
 def _estimate(self,layer,eid):
  if eid=='shared':return sum(int(np.prod(self.tensor[f'blk.{layer}.{n}.weight'][0].shape))*4 for n in SHARED)
  return sum((int(np.prod(self.tensor[f'blk.{layer}.{n}.weight'][0].shape))//512)*4 for n in NAMES)
 def _evict(self,need):
  while self.cache and self.bytes+need>self.cap:
   _,arrs=self.cache.popitem(last=False);self.bytes-=sum(x.nbytes for x in arrs);self.evictions+=1
  if self.bytes+need>self.cap:raise MemoryError(f'one active item {need} exceeds cache {self.cap}')
 def freeze(self):self.frozen=True
 def get(self,layer,eid):
  key=(layer,eid)
  if key in self.cache:self.hits+=1;v=self.cache.pop(key);self.cache[key]=v;return v
  self.misses+=1;need=self._estimate(layer,eid)
  if not self.frozen:self._evict(need)
  arr=[]
  for n in (SHARED if eid=='shared' else NAMES):
   t,fd=self.tensor[f'blk.{layer}.{n}.weight'];raw=self._raw(t,fd,None if eid=='shared' else int(eid));arr.append(dequantize(raw,t.tensor_type).astype(np.float32,copy=False))
  v=tuple(arr);actual=sum(x.nbytes for x in v)
  if self.frozen:self.transient+=1;return v
  self.bytes+=actual;self.peak=max(self.peak,self.bytes);self.cache[key]=v;return v
 def route(self,layer,x):
  t,_=self.tensor[f'blk.{layer}.ffn_gate_inp.weight'];R=np.asarray(t.data,dtype=np.float32);log=R@x;ids=np.argsort(-log,kind='stable')[:10];v=log[ids]-log[ids].max();w=np.exp(v,dtype=np.float32);w/=w.sum();return ids,w
 def shared_gate(self,layer,x):
  t,_=self.tensor[f'blk.{layer}.ffn_gate_inp_shexp.weight'];v=float(np.asarray(t.data,dtype=np.float32).reshape(-1)@x);return 1/(1+math.exp(-max(-30,min(30,v))))
def ffn(x,g,u,d):
 gate=g@x;up=u@x;h=gate/(1+np.exp(-np.clip(gate,-30,30),dtype=np.float32))*up;return d@h
base=rss_kb();base_swap=float(subprocess.check_output(['sysctl','vm.swapusage'],text=True).split('used = ')[1].split('M')[0]);peak=[0];err=[];done=threading.Event()
def sample():
 while not done.wait(.05):
  try:
   r=rss_kb()-base;peak[0]=max(peak[0],r)
   free=int(subprocess.check_output(['memory_pressure','-Q'],text=True).split('free percentage: ')[1].split('%')[0]);swap=float(subprocess.check_output(['sysctl','vm.swapusage'],text=True).split('used = ')[1].split('M')[0])
   if r>a.rss_limit_mib*1024 or free<8 or swap-base_swap>1024:
    msg=f'safety rss={r/1024:.1f}MiB free={free}% swapDelta={swap-base_swap:.1f}MiB';err.append(msg);print('SAFETY_ABORT '+msg,file=sys.stderr,flush=True);os._exit(70)
  except Exception as e:err.append(str(e));return
threading.Thread(target=sample,daemon=True).start();store=Store(MODEL,a.cache_mib*2**20)
def activation(layer,pass_id=0):
 rng=np.random.default_rng(380+layer+(10000*pass_id if a.route_churn else 0));x=rng.standard_normal(2560,dtype=np.float32);return x/np.sqrt(np.mean(x*x,dtype=np.float32))
def run_layer(layer,compute,pass_id=0):
 x=activation(layer,pass_id);ids,w=store.route(layer,x);out=np.zeros(2560,dtype=np.float32);st=time.perf_counter()
 for eid,gw in zip(ids,w):
  g,u,d=store.get(layer,int(eid))
  if compute:out+=float(gw)*ffn(x,g,u,d)
 sg,su,sd=store.get(layer,'shared')
 if compute:out+=store.shared_gate(layer,x)*ffn(x,sg,su,sd)
 return {'layer':layer,'experts':list(map(int,ids)),'ms':(time.perf_counter()-st)*1000,'norm':float(np.linalg.norm(out)) if compute else None}
try:
 cold=run_layer(0,True);before=(store.hits,store.misses,store.read_bytes,store.read_ms);warm=run_layer(0,True);warm_delta={'hits':store.hits-before[0],'misses':store.misses-before[1],'readBytes':store.read_bytes-before[2],'readMs':store.read_ms-before[3]}
 pass_rows=[];all_layers=[]
 for pass_id in range(a.passes):
  st=time.perf_counter();b0=store.read_bytes;r0=store.read_ms;h0=store.hits;m0=store.misses;e0=store.evictions;rows=[]
  for layer in range(min(48,a.layers)):rows.append(run_layer(layer,layer<a.compute_layers,pass_id))
  wall=(time.perf_counter()-st)*1000;logical=store.read_bytes-b0;readms=store.read_ms-r0;effective=logical/(wall/1000)/2**30 if wall else 0
  pass_rows.append({'pass':pass_id,'wallMs':wall,'logicalReadBytes':logical,'preadMs':readms,'effectiveReadyGiBPerSec':effective,'hits':store.hits-h0,'misses':store.misses-m0,'evictions':store.evictions-e0});all_layers=rows
  if pass_id==0 and a.policy=='pinned':store.freeze()
 done.set();time.sleep(.1)
 if err:raise RuntimeError(err)
 first=pass_rows[0];kimi_token=92*16*17547264;kimi_io_tps=(first['effectiveReadyGiBPerSec']*2**30/kimi_token) if first['effectiveReadyGiBPerSec'] else 0
 maxrss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1024*1024 if sys.platform=='darwin' else 1024)
 result={'cacheCapMiB':a.cache_mib,'rssLimitMiB':a.rss_limit_mib,'directIO':not a.cached_io,'routeChurn':a.route_churn,'policy':a.policy,'coldLayer0':cold,'warmLayer0':warm,'warmDelta':warm_delta,'layers':len(all_layers),'computedLayers':min(a.compute_layers,len(all_layers)),'passes':pass_rows,'cachePeakMiB':store.peak/2**20,'cacheFinalMiB':store.bytes/2**20,'hits':store.hits,'misses':store.misses,'evictions':store.evictions,'transientLoads':store.transient,'peakRssDeltaMiB':peak[0]/1024,'processMaxRssMiB':maxrss,'swapDeltaMiB':float(subprocess.check_output(['sysctl','vm.swapusage'],text=True).split('used = ')[1].split('M')[0])-base_swap,'kimiColdBytesPerToken':kimi_token,'kimiColdReadyFloorTokPerSec':kimi_io_tps,'sampleLayerNorms':[x['norm'] for x in all_layers[:a.compute_layers]]}
 print('RESULT_JSON='+json.dumps(result,separators=(',',':')))
finally:
 done.set();store.close()
