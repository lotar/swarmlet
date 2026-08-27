#!/usr/bin/env python3
"""One true Qwen3.8 Flash Next expert owner (layer 0 only).

Loads/dequantizes only explicitly assigned expert slices from the existing GGUF.
No router, attention, KV, shared expert, or foreign expert weights are resident.
"""
from __future__ import annotations
import argparse, hashlib, json, os, signal, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
os.environ.setdefault('OMP_NUM_THREADS','1'); os.environ.setdefault('OPENBLAS_NUM_THREADS','1'); os.environ.setdefault('VECLIB_MAXIMUM_THREADS','1')
import numpy as np
from gguf import GGUFReader
from gguf.quants import dequantize

ap=argparse.ArgumentParser(); ap.add_argument('--id',required=True); ap.add_argument('--port',type=int,required=True)
ap.add_argument('--shard',required=True); ap.add_argument('--experts',required=True)
a=ap.parse_args(); OWNED=sorted(int(x) for x in a.experts.split(',') if x)
reader=GGUFReader(a.shard,'r')
tensors={t.name:t for t in reader.tensors}
required=['blk.0.ffn_gate_exps.weight','blk.0.ffn_up_exps.weight','blk.0.ffn_down_exps.weight']
for n in required:
    if n not in tensors: raise RuntimeError(f'missing {n}')
weights={}
for eid in OWNED:
    gate=dequantize(tensors[required[0]].data[eid],tensors[required[0]].tensor_type).astype(np.float32,copy=False)
    up=dequantize(tensors[required[1]].data[eid],tensors[required[1]].tensor_type).astype(np.float32,copy=False)
    down=dequantize(tensors[required[2]].data[eid],tensors[required[2]].tensor_type).astype(np.float32,copy=False)
    weights[eid]=(gate,up,down)
resident=sum(x.nbytes for trio in weights.values() for x in trio)
digest=hashlib.sha256((a.id+':' + ','.join(map(str,OWNED))).encode()).hexdigest()

def forward(eid:int,X:np.ndarray)->np.ndarray:
    gate,up,down=weights[eid]
    g=X @ gate.T; u=X @ up.T
    h=(g/(1.0+np.exp(-np.clip(g,-30,30),dtype=np.float32)))*u
    return h @ down.T

class H(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def sendj(self,status,obj):
        raw=json.dumps(obj,separators=(',',':')).encode(); self.send_response(status)
        self.send_header('content-type','application/json'); self.send_header('content-length',str(len(raw)))
        self.end_headers(); self.wfile.write(raw)
    def do_GET(self):
        if self.path=='/health': return self.sendj(200,{'status':'ok','nodeId':a.id})
        if self.path=='/manifest': return self.sendj(200,{'nodeId':a.id,'layer':0,'expertIds':OWNED,'residentBytes':resident,'digest':digest})
        return self.sendj(404,{'error':'NOT_FOUND'})
    def do_POST(self):
        n=int(self.headers.get('content-length','0')); body=json.loads(self.rfile.read(n) or b'{}')
        if self.path!='/execute': return self.sendj(404,{'error':'NOT_FOUND'})
        assigns=body.get('assignments',[]); foreign=sorted({int(x['expertId']) for x in assigns if int(x['expertId']) not in weights})
        if foreign: return self.sendj(409,{'error':'NOT_OWNER','expertIds':foreign})
        delay=float(body.get('delayMs',0));
        if delay>0: time.sleep(delay/1000)
        X=np.asarray(body['activations'],dtype=np.float32)
        if X.ndim!=2 or X.shape[1]!=2560: return self.sendj(400,{'error':'BAD_ACTIVATION_SHAPE'})
        pieces=[]
        for item in sorted(assigns,key=lambda z:int(z['expertId'])):
            eid=int(item['expertId']); gw=np.asarray(item['weights'],dtype=np.float32)
            Y=forward(eid,X)
            pieces.append({'expertId':eid,'weighted':(Y*gw[:,None]).tolist()})
        return self.sendj(200,{'nodeId':a.id,'pieces':pieces})

srv=ThreadingHTTPServer(('127.0.0.1',a.port),H)
print(json.dumps({'nodeId':a.id,'experts':OWNED,'residentBytes':resident}),flush=True)
srv.serve_forever()
