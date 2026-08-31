#!/usr/bin/env python3
"""Reusable real-weight Qwen layer-0 expert cell."""
from __future__ import annotations
import concurrent.futures as cf, gc, hashlib, json, os, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','1');os.environ.setdefault('OPENBLAS_NUM_THREADS','1');os.environ.setdefault('VECLIB_MAXIMUM_THREADS','1')
import numpy as np
from gguf import GGUFReader
from gguf.quants import dequantize
from binary_protocol import encode_worker_request,decode_worker_response
from response_validation import validate_binary_partial,validate_json_response
NAMES=['blk.0.ffn_gate_exps.weight','blk.0.ffn_up_exps.weight','blk.0.ffn_down_exps.weight']
SHARED=['blk.0.ffn_gate_shexp.weight','blk.0.ffn_up_shexp.weight','blk.0.ffn_down_shexp.weight']
ROUTER='blk.0.ffn_gate_inp.weight';SHARED_GATE='blk.0.ffn_gate_inp_shexp.weight'
NODE_IDS=['n1','n2','n3'];ALL_NODES=['n1','n2','n3','n4'];DEFAULT_PORTS=[9581,9582,9583,9584]
LAN={'n1':0,'n2':0,'n3':0};EU={'n1':12,'n2':16,'n3':22}

def deterministic_activation(seed=380):
 rng=np.random.default_rng(seed);x=rng.standard_normal(2560,dtype=np.float32);return x/np.sqrt(np.mean(x*x,dtype=np.float32))
def softmax_top10(X,R):
 logits=X@R.T;idx=np.argsort(-logits,axis=1,kind='stable')[:,:10];vals=np.take_along_axis(logits,idx,axis=1);vals-=vals.max(axis=1,keepdims=True);w=np.exp(vals,dtype=np.float32);w/=w.sum(axis=1,keepdims=True);return idx,w
def sigmoid(x):return 1/(1+np.exp(-np.clip(x,-30,30),dtype=np.float32))
def ffn(X,gate,up,down):
 g=X@gate.T;u=X@up.T;return (g/(1+np.exp(-np.clip(g,-30,30),dtype=np.float32))*u)@down.T
def _hash_tensors(items):
 h=hashlib.sha256()
 for name,t,a,selector in items:
  meta={'name':name,'tensorType':int(t.tensor_type),'fullShape':list(map(int,t.shape)),'sliceShape':list(map(int,np.asarray(a).shape)),'selector':selector}
  h.update(json.dumps(meta,sort_keys=True,separators=(',',':')).encode()+b'\0');h.update(memoryview(np.asarray(a)).cast('B'))
 return h.hexdigest()
def expert_content_digest(T,eid):return _hash_tensors((n,T[n],T[n].data[eid],{'expertId':eid}) for n in NAMES)
def post(url,obj,timeout=180):
 raw=json.dumps(obj,separators=(',',':')).encode();req=urllib.request.Request(url,data=raw,headers={'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
def post_binary(url,raw,timeout=180):
 req=urllib.request.Request(url,data=raw,headers={'content-type':'application/octet-stream'})
 with urllib.request.urlopen(req,timeout=timeout) as r:return r.read()
def get(url,timeout=30):
 with urllib.request.urlopen(url,timeout=timeout) as r:return json.load(r)

def streamed_reference(T,X,route_ids,route_weights):
 """Independent streamed reference for arbitrary per-row rank order."""
 out=np.zeros((len(X),2560),dtype=np.float32);selected=sorted(set(map(int,route_ids.reshape(-1))))
 for eid in selected:
  gate=dequantize(T[NAMES[0]].data[eid],T[NAMES[0]].tensor_type).astype(np.float32,copy=False);up=dequantize(T[NAMES[1]].data[eid],T[NAMES[1]].tensor_type).astype(np.float32,copy=False);down=dequantize(T[NAMES[2]].data[eid],T[NAMES[2]].tensor_type).astype(np.float32,copy=False)
  gw=np.asarray([route_weights[b,int(np.where(route_ids[b]==eid)[0][0])] for b in range(len(X))],dtype=np.float32)
  out+=ffn(X,gate,up,down)*gw[:,None];del gate,up,down;gc.collect()
 sg=dequantize(T[SHARED[0]].data,T[SHARED[0]].tensor_type).astype(np.float32,copy=False);su=dequantize(T[SHARED[1]].data,T[SHARED[1]].tensor_type).astype(np.float32,copy=False);sd=dequantize(T[SHARED[2]].data,T[SHARED[2]].tensor_type).astype(np.float32,copy=False);gv=np.asarray(T[SHARED_GATE].data,dtype=np.float32).reshape(-1)
 out+=ffn(X,sg,su,sd)*sigmoid(X@gv)[:,None];return out

class QwenExpertCell:
 def __init__(self,shard,worker_script,ports=DEFAULT_PORTS,python=sys.executable,gguf_py=None,backend='numpy',external_endpoints=None):
  if backend not in ('numpy','mlx'):raise ValueError('backend must be numpy|mlx')
  self.shard=Path(shard);self.worker_script=Path(worker_script);self.ports=list(ports);self.python=python;self.backend=backend;self.external_endpoints=dict(external_endpoints or {})
  if set(self.external_endpoints)-set(ALL_NODES):raise ValueError('unknown external endpoint node')
  for node,url in self.external_endpoints.items():
   p=urllib.parse.urlparse(url)
   if p.scheme!='http' or p.hostname not in ('127.0.0.1','::1') or p.username or p.password or p.path not in ('','/') or p.query or p.fragment:raise ValueError(f'unsafe external endpoint {node}')
  self.gguf_py=Path(gguf_py or os.environ.get('GGUF_PY',self.worker_script.resolve().parents[3]/'vendor/llama.cpp/gguf-py'));self.lock=threading.RLock();self.procs={};self.closed=False
  self.reader=GGUFReader(str(self.shard),'r');self.T={t.name:t for t in self.reader.tensors}
  for n in NAMES+SHARED+[ROUTER,SHARED_GATE]:
   if n not in self.T:raise RuntimeError(f'missing {n}')
  self.router=np.asarray(self.T[ROUTER].data,dtype=np.float32);self.sg=dequantize(self.T[SHARED[0]].data,self.T[SHARED[0]].tensor_type).astype(np.float32,copy=False);self.su=dequantize(self.T[SHARED[1]].data,self.T[SHARED[1]].tensor_type).astype(np.float32,copy=False);self.sd=dequantize(self.T[SHARED[2]].data,self.T[SHARED[2]].tensor_type).astype(np.float32,copy=False);self.shared_gate=np.asarray(self.T[SHARED_GATE].data,dtype=np.float32).reshape(-1)
  ids,_=softmax_top10(deterministic_activation()[None,:],self.router);self.selected=[int(i) for i in ids[0]];self.placement={NODE_IDS[i]:self.selected[i::3] for i in range(3)};self.replicas={'n2':'n4'};self.worker_experts={**self.placement,'n4':list(self.placement['n2'])};self.owner={eid:n for n,es in self.placement.items() for eid in es}
  self.expert_digests={str(e):expert_content_digest(self.T,e) for e in self.selected};self.node_digests={n:hashlib.sha256(json.dumps({str(e):self.expert_digests[str(e)] for e in sorted(es)},sort_keys=True,separators=(',',':')).encode()).hexdigest() for n,es in self.worker_experts.items()}
  content={'model':'Qwen3.8-Flash-Next-UD-Q4_K_XL','shardBytes':self.shard.stat().st_size,'layer':0,'placement':self.placement,'replicas':self.replicas,'expertDigests':self.expert_digests,'routerDigest':_hash_tensors([(ROUTER,self.T[ROUTER],self.T[ROUTER].data,None)]),'sharedDigest':_hash_tensors([(n,self.T[n],self.T[n].data,None) for n in SHARED]+[(SHARED_GATE,self.T[SHARED_GATE],self.T[SHARED_GATE].data,None)])};self.epoch=hashlib.sha256(json.dumps(content,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 def manifest(self):return {'model':'Qwen3.8-Flash-Next-UD-Q4_K_XL','layer':0,'expertsTotal':512,'topK':10,'selectedExperts':self.selected,'placement':self.placement,'replicas':self.replicas,'placementEpoch':self.epoch,'epochSigned':False,'nodeContentDigests':self.node_digests,'backend':self.backend,'profiles':{'lan':LAN,'eu':EU}}
 def _validate_owner_manifest(self,node,m):
  expected_backend='numpy-bundle' if node in self.external_endpoints else self.backend
  if m['nodeId']!=node or m['expertIds']!=sorted(self.worker_experts[node]) or m['placementEpoch']!=self.epoch or m['ownedContentDigest']!=self.node_digests[node] or m['backend']!=expected_backend or bool(m['lazyReplica'])!=(node=='n4'):raise RuntimeError(f'{node} manifest mismatch')
 def start_owner(self,node):
  with self.lock:
   if self.closed:raise RuntimeError('CELL_CLOSED')
   if node in self.external_endpoints:
    self._validate_owner_manifest(node,get(self._url(node,'/manifest')));return
   if node in self.procs and self.procs[node].poll() is None:return
   i=ALL_NODES.index(node);env=os.environ.copy();env.update({'PYTHONPATH':os.pathsep.join([str(self.worker_script.parent),str(self.gguf_py)]),'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'});cmd=[self.python,str(self.worker_script),'--id',node,'--port',str(self.ports[i]),'--shard',str(self.shard),'--experts',','.join(map(str,self.worker_experts[node])),'--epoch',self.epoch,'--backend',self.backend]
   if node=='n4':cmd.append('--lazy')
   p=subprocess.Popen(cmd,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True);self.procs[node]=p
   try:
    for _ in range(400):
     if p.poll() is not None:raise RuntimeError(f'{node} died: {p.stderr.read()}')
     try:
      m=get(f'http://127.0.0.1:{self.ports[i]}/manifest')
      self._validate_owner_manifest(node,m);return
     except urllib.error.URLError:time.sleep(.02)
    raise RuntimeError(f'{node} startup timeout')
   except Exception:
    if p.poll() is None:p.kill();p.wait(timeout=10)
    self.procs.pop(node,None);raise
 def start(self):
  started=[]
  try:
   for n in ALL_NODES:self.start_owner(n);started.append(n)
  except Exception:
   for n in reversed(started):self.stop_owner(n)
   raise
 def stop_owner(self,node):
  with self.lock:
   if node in self.external_endpoints:raise RuntimeError('EXTERNAL_OWNER_LIFECYCLE')
   p=self.procs.pop(node,None)
   if p and p.poll() is None:p.kill();p.wait(timeout=10)
 def close(self):
  # Permanent, atomic transition: concurrent admin starts cannot race cleanup.
  with self.lock:
   self.closed=True;items=list(self.procs.items());self.procs.clear()
   for _,p in items:
    if p.poll() is None:p.kill();p.wait(timeout=10)
 def stop(self):self.close()
 def _route(self,X):
  idx,w=softmax_top10(X,self.router)
  for row in idx:
   if set(map(int,row))!=set(self.selected):raise RuntimeError('EXPERT_NOT_RESIDENT for placement epoch')
  return idx,w
 def shared_forward(self,X):return ffn(X,self.sg,self.su,self.sd)*sigmoid(X@self.shared_gate)[:,None]
 def _prepare(self,X,profile,expected_epoch):
  if expected_epoch!=self.epoch:raise RuntimeError('STALE_PLACEMENT_EPOCH')
  if profile not in ('lan','eu'):raise ValueError('profile must be lan|eu')
  X=np.asarray(X,dtype=np.float32)
  if X.ndim!=2 or X.shape[1]!=2560 or not 1<=len(X)<=16 or not np.isfinite(X).all():raise ValueError('activations must be finite [1..16,2560]')
  idx,w=self._route(X);delays=LAN if profile=='lan' else EU;groups={n:[] for n in NODE_IDS}
  for eid in self.selected:
   ranks=[int(np.where(idx[b]==eid)[0][0]) for b in range(len(X))];groups[self.owner[eid]].append({'expertId':eid,'weights':[float(w[b,ranks[b]]) for b in range(len(X))]})
  return X,delays,groups
 def _url(self,node,path):return self.external_endpoints.get(node,f'http://127.0.0.1:{self.ports[ALL_NODES.index(node)]}')+path
 def _with_replica(self,primary,call):
  try:return call(primary)
  except Exception as first:
   replica=self.replicas.get(primary)
   if not replica:raise
   try:return call(replica)
   except Exception as second:raise RuntimeError(f'{primary}+{replica} unavailable: {first}; {second}') from second
 def forward(self,X,profile,expected_epoch):
  X,delays,groups=self._prepare(X,profile,expected_epoch)
  def call(primary):
   expected=sorted(int(x['expertId']) for x in groups[primary])
   def one(node):
    r=post(self._url(node,'/execute'),{'placementEpoch':self.epoch,'activations':X.tolist(),'assignments':groups[primary],'delayMs':delays[primary]})
    validate_json_response(r,node,self.epoch,expected,X.shape);return r
   return self._with_replica(primary,one)
  t=time.perf_counter()
  try:
   with cf.ThreadPoolExecutor(max_workers=3) as ex:responses=list(ex.map(call,NODE_IDS))
  except Exception as e:raise RuntimeError(f'EXPERT_UNAVAILABLE: {e}') from e
  pieces=[]
  for r in responses:pieces.extend(r['pieces'])
  routed=np.zeros((len(X),2560),dtype=np.float32)
  for piece in sorted(pieces,key=lambda z:int(z['expertId'])):routed+=np.asarray(piece['weighted'],dtype=np.float32)
  return routed+self.shared_forward(X),(time.perf_counter()-t)*1000
 def forward_binary(self,X,profile,expected_epoch):
  X,delays,groups=self._prepare(X,profile,expected_epoch)
  def call(primary):
   raw=encode_worker_request(X,groups[primary],self.epoch,delays[primary])
   def one(node):
    data=post_binary(self._url(node,'/execute-bin'),raw);partial,ep=decode_worker_response(data)
    if ep!=self.epoch:raise RuntimeError('STALE_WORKER_RESPONSE')
    return validate_binary_partial(partial,X.shape,node)
   return self._with_replica(primary,one)
  t=time.perf_counter()
  try:
   with cf.ThreadPoolExecutor(max_workers=3) as ex:partials=list(ex.map(call,NODE_IDS))
  except Exception as e:raise RuntimeError(f'EXPERT_UNAVAILABLE: {e}') from e
  routed=np.zeros((len(X),2560),dtype=np.float32)
  for partial in partials:routed+=partial
  return routed+self.shared_forward(X),(time.perf_counter()-t)*1000
