#!/usr/bin/env python3
"""One plan-pinned Qwen layer-0 expert owner (GGUF/NumPy, bundle, or MLX)."""
from __future__ import annotations
import argparse,hashlib,json,os,sys,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
os.environ.setdefault('OMP_NUM_THREADS','1');os.environ.setdefault('OPENBLAS_NUM_THREADS','1');os.environ.setdefault('VECLIB_MAXIMUM_THREADS','1')
import numpy as np
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
from binary_protocol import decode_worker_request,encode_worker_response
from bundle_format import array_key,load_bundle
ap=argparse.ArgumentParser();ap.add_argument('--id',required=True);ap.add_argument('--port',type=int,required=True);src=ap.add_mutually_exclusive_group(required=True);src.add_argument('--shard');src.add_argument('--bundle');ap.add_argument('--experts',required=True);ap.add_argument('--epoch',required=True);ap.add_argument('--backend',choices=['numpy','mlx'],default='numpy');ap.add_argument('--lazy',action='store_true');a=ap.parse_args();OWNED=sorted(int(x) for x in a.experts.split(',') if x)
if not OWNED or len(set(OWNED))!=len(OWNED):raise SystemExit('invalid --experts')
mx=None;reader=None;T=None;bundle_meta=None;bundle_arrays=None
N=['blk.0.ffn_gate_exps.weight','blk.0.ffn_up_exps.weight','blk.0.ffn_down_exps.weight']
if a.bundle:
 if a.backend!='numpy':raise SystemExit('portable bundles require --backend numpy')
 bundle_meta,bundle_arrays=load_bundle(a.bundle)
 if bundle_meta['nodeId']!=a.id or sorted(map(int,bundle_meta['expertIds']))!=OWNED or bundle_meta['placementEpoch']!=a.epoch:raise SystemExit('bundle identity/placement mismatch')
 for eid in OWNED:
  if bundle_arrays[array_key(eid,'gate')].shape!=(640,2560) or bundle_arrays[array_key(eid,'up')].shape!=(640,2560) or bundle_arrays[array_key(eid,'down')].shape!=(2560,640):raise SystemExit(f'bundle expert {eid} shape mismatch')
 expert_digests=dict(bundle_meta['rawExpertDigests']);owned_digest=str(bundle_meta['ownedContentDigest']);bundle_digest=str(bundle_meta['arrayDigest']);backend_name='numpy-bundle'
 if a.lazy:bundle_arrays=None
else:
 from gguf import GGUFReader
 from gguf.quants import dequantize
 reader=GGUFReader(a.shard,'r');T={t.name:t for t in reader.tensors}
 def harrays(eid):
  h=hashlib.sha256()
  for n in N:
   a0=T[n].data[eid];meta={'name':n,'tensorType':int(T[n].tensor_type),'fullShape':list(map(int,T[n].shape)),'sliceShape':list(map(int,np.asarray(a0).shape)),'selector':{'expertId':eid}}
   h.update(json.dumps(meta,sort_keys=True,separators=(',',':')).encode()+b'\0');h.update(memoryview(np.asarray(a0)).cast('B'))
  return h.hexdigest()
 expert_digests={str(e):harrays(e) for e in OWNED};owned_digest=hashlib.sha256(json.dumps(expert_digests,sort_keys=True,separators=(',',':')).encode()).hexdigest();bundle_digest=None;backend_name=a.backend
 if a.backend=='mlx':import mlx.core as mx
weights={};resident=0
def ensure_weights():
 global resident,bundle_arrays
 if weights:return
 if a.bundle:
  if bundle_arrays is None:_,bundle_arrays=load_bundle(a.bundle)
  for eid in OWNED:weights[eid]=tuple(np.asarray(bundle_arrays[array_key(eid,n)],dtype=np.float16) for n in ('gate','up','down'))
 else:
  for eid in OWNED:
   arr=tuple(dequantize(T[n].data[eid],T[n].tensor_type).astype(np.float32,copy=False) for n in N)
   if mx is not None:
    marr=tuple(mx.array(x) for x in arr);mx.eval(*marr);weights[eid]=marr
   else:weights[eid]=arr
 resident=sum(int(x.nbytes) for values in weights.values() for x in values)
if not a.lazy:ensure_weights()
def forward(eid,X):
 ensure_weights();gate,up,down=weights[eid]
 if mx is None:
  g=X@gate.T;u=X@up.T;return (g/(1+np.exp(-np.clip(g,-30,30),dtype=np.float32))*u)@down.T
 xx=mx.array(X);g=xx@gate.T;y=(g*mx.sigmoid(g)*(xx@up.T))@down.T;mx.eval(y);return np.asarray(y)
class H(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def sendj(self,status,obj):
  raw=json.dumps(obj,separators=(',',':')).encode();self.send_response(status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def sendb(self,status,raw):
  self.send_response(status);self.send_header('content-type','application/octet-stream');self.send_header('content-length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if self.path=='/health':return self.sendj(200,{'status':'ok','nodeId':a.id})
  if self.path=='/manifest':return self.sendj(200,{'nodeId':a.id,'layer':0,'expertIds':OWNED,'residentBytes':resident,'placementEpoch':a.epoch,'ownedContentDigest':owned_digest,'bundleContentDigest':bundle_digest,'backend':backend_name,'lazyReplica':a.lazy})
  return self.sendj(404,{'error':'NOT_FOUND'})
 def do_POST(self):
  try:
   n=int(self.headers.get('content-length','0'))
   if n<=0 or n>4*1024*1024:return self.sendj(413,{'error':'BODY_TOO_LARGE'})
   raw=self.rfile.read(n)
   if self.path=='/execute-bin':
    X,assigns,epoch,delay=decode_worker_request(raw)
    if epoch!=a.epoch:return self.sendj(409,{'error':'STALE_PLACEMENT_EPOCH'})
    ids=[int(x['expertId']) for x in assigns];foreign=sorted(set(ids)-set(OWNED))
    if foreign:return self.sendj(409,{'error':'NOT_OWNER','expertIds':foreign})
    if len(set(ids))!=len(ids):return self.sendj(400,{'error':'DUPLICATE_EXPERT'})
    if delay:time.sleep(delay/1000)
    partial=np.zeros((len(X),2560),dtype=np.float32)
    for item in sorted(assigns,key=lambda z:int(z['expertId'])):partial+=forward(int(item['expertId']),X)*np.asarray(item['weights'],dtype=np.float32)[:,None]
    return self.sendb(200,encode_worker_response(partial,a.epoch))
   body=json.loads(raw)
   if not isinstance(body,dict):return self.sendj(400,{'error':'BAD_REQUEST','detail':'JSON body must be object'})
   if self.path!='/execute':return self.sendj(404,{'error':'NOT_FOUND'})
   if body.get('placementEpoch')!=a.epoch:return self.sendj(409,{'error':'STALE_PLACEMENT_EPOCH'})
   assigns=body.get('assignments');delay=float(body.get('delayMs',0));X=np.asarray(body.get('activations'),dtype=np.float32)
   if not isinstance(assigns,list) or not 1<=len(assigns)<=10 or not all(isinstance(x,dict) for x in assigns):return self.sendj(400,{'error':'BAD_ASSIGNMENTS'})
   if X.ndim!=2 or X.shape[1]!=2560 or not 1<=len(X)<=16 or not np.isfinite(X).all():return self.sendj(400,{'error':'BAD_ACTIVATIONS'})
   if not 0<=delay<=100:return self.sendj(400,{'error':'BAD_DELAY'})
   ids=[int(x['expertId']) for x in assigns]
   if len(set(ids))!=len(ids):return self.sendj(400,{'error':'DUPLICATE_EXPERT'})
   foreign=sorted(set(ids)-set(OWNED))
   if foreign:return self.sendj(409,{'error':'NOT_OWNER','expertIds':foreign})
   for item in assigns:
    ws=np.asarray(item.get('weights'),dtype=np.float32)
    if ws.shape!=(len(X),) or not np.isfinite(ws).all():return self.sendj(400,{'error':'BAD_WEIGHTS'})
   if delay:time.sleep(delay/1000)
   pieces=[]
   for item in sorted(assigns,key=lambda z:int(z['expertId'])):
    eid=int(item['expertId']);gw=np.asarray(item['weights'],dtype=np.float32);pieces.append({'expertId':eid,'weighted':(forward(eid,X)*gw[:,None]).tolist()})
   return self.sendj(200,{'nodeId':a.id,'placementEpoch':a.epoch,'pieces':pieces})
  except (ValueError,TypeError,KeyError,AttributeError,json.JSONDecodeError) as e:return self.sendj(400,{'error':'BAD_REQUEST','detail':str(e)[:200]})
srv=ThreadingHTTPServer(('127.0.0.1',a.port),H);print(json.dumps({'nodeId':a.id,'experts':OWNED,'residentBytes':resident,'epoch':a.epoch,'backend':backend_name,'lazyReplica':a.lazy,'bundleContentDigest':bundle_digest}),flush=True);srv.serve_forever()
