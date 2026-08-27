#!/usr/bin/env python3
"""One true Qwen3.8 Flash Next expert owner (layer 0 only)."""
from __future__ import annotations
import argparse,hashlib,json,os,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
os.environ.setdefault('OMP_NUM_THREADS','1');os.environ.setdefault('OPENBLAS_NUM_THREADS','1');os.environ.setdefault('VECLIB_MAXIMUM_THREADS','1')
import numpy as np
from gguf import GGUFReader
from gguf.quants import dequantize
from binary_protocol import decode_worker_request,encode_worker_response
ap=argparse.ArgumentParser();ap.add_argument('--id',required=True);ap.add_argument('--port',type=int,required=True);ap.add_argument('--shard',required=True);ap.add_argument('--experts',required=True);ap.add_argument('--epoch',required=True);ap.add_argument('--backend',choices=['numpy','mlx'],default='numpy');ap.add_argument('--lazy',action='store_true');a=ap.parse_args();OWNED=sorted(int(x) for x in a.experts.split(',') if x)
mx=None
if a.backend=='mlx':import mlx.core as mx
reader=GGUFReader(a.shard,'r');T={t.name:t for t in reader.tensors};N=['blk.0.ffn_gate_exps.weight','blk.0.ffn_up_exps.weight','blk.0.ffn_down_exps.weight']
def harrays(eid):
 h=hashlib.sha256()
 for n in N:
  a0=T[n].data[eid];meta={'name':n,'tensorType':int(T[n].tensor_type),'fullShape':list(map(int,T[n].shape)),'sliceShape':list(map(int,np.asarray(a0).shape)),'selector':{'expertId':eid}}
  h.update(json.dumps(meta,sort_keys=True,separators=(',',':')).encode()+b'\0');h.update(memoryview(np.asarray(a0)).cast('B'))
 return h.hexdigest()
expert_digests={str(e):harrays(e) for e in OWNED};owned_digest=hashlib.sha256(json.dumps(expert_digests,sort_keys=True,separators=(',',':')).encode()).hexdigest();weights={};resident=0
def ensure_weights():
 global resident
 if weights:return
 for eid in OWNED:
  arr=tuple(dequantize(T[n].data[eid],T[n].tensor_type).astype(np.float32,copy=False) for n in N);resident+=sum(x.nbytes for x in arr)
  if mx is not None:
   marr=tuple(mx.array(x) for x in arr);mx.eval(*marr);weights[eid]=marr
  else:weights[eid]=arr
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
  if self.path=='/manifest':return self.sendj(200,{'nodeId':a.id,'layer':0,'expertIds':OWNED,'residentBytes':resident,'placementEpoch':a.epoch,'ownedContentDigest':owned_digest,'backend':a.backend,'lazyReplica':a.lazy})
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
srv=ThreadingHTTPServer(('127.0.0.1',a.port),H);print(json.dumps({'nodeId':a.id,'experts':OWNED,'residentBytes':resident,'epoch':a.epoch,'backend':a.backend,'lazyReplica':a.lazy}),flush=True);srv.serve_forever()
