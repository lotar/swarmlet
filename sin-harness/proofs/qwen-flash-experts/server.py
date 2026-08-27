#!/usr/bin/env python3
"""Loopback Qwen expert-cell service boundary for llama.cpp integration."""
import argparse,json,os,signal,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import numpy as np
from cell import QwenExpertCell,ALL_NODES
from binary_protocol import decode_service_request,encode_service_response
from signing import sign_manifest
ap=argparse.ArgumentParser();ap.add_argument('--port',type=int,default=9590);ap.add_argument('--shard',required=True);ap.add_argument('--backend',choices=['numpy','mlx'],default='numpy');a=ap.parse_args();cell=QwenExpertCell(a.shard,Path(__file__).with_name('worker.py'),backend=a.backend)
base_manifest=cell.manifest();base_manifest['epochSigned']=True;signed_manifest=sign_manifest(base_manifest,os.environ.get('QWEN_SIGNING_DIR',str(Path(__file__).resolve().parents[2]/'data/qwen-expert-service')))
class H(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def sendj(self,status,obj):
  raw=json.dumps(obj,separators=(',',':')).encode();self.send_response(status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def sendb(self,status,raw):
  self.send_response(status);self.send_header('content-type','application/octet-stream');self.send_header('content-length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if self.path=='/health':return self.sendj(200,{'status':'ok','placementEpoch':cell.epoch})
  if self.path=='/manifest':return self.sendj(200,signed_manifest)
  return self.sendj(404,{'error':'NOT_FOUND'})
 def do_POST(self):
  try:
   n=int(self.headers.get('content-length','0'))
   if n<=0 or n>4*1024*1024:return self.sendj(413,{'error':'BODY_TOO_LARGE'})
   raw=self.rfile.read(n)
   if self.path=='/v1/ffn-bin':
    X,profile,epoch=decode_service_request(raw);out,_=cell.forward_binary(X,profile,epoch);return self.sendb(200,encode_service_response(out,cell.epoch))
   body=json.loads(raw)
   if not isinstance(body,dict):return self.sendj(400,{'error':'BAD_REQUEST','detail':'JSON body must be object'})
   if self.path=='/v1/ffn':
    out,ms=cell.forward(np.asarray(body.get('activations'),dtype=np.float32),body.get('profile'),body.get('placementEpoch'));return self.sendj(200,{'placementEpoch':cell.epoch,'output':out.tolist(),'durationMs':ms})
   if self.path in ('/admin/stop-owner','/admin/start-owner'):
    node=body.get('nodeId')
    if node not in ALL_NODES:return self.sendj(400,{'error':'BAD_NODE'})
    if body.get('placementEpoch')!=cell.epoch:return self.sendj(409,{'error':'STALE_PLACEMENT_EPOCH'})
    if self.path.endswith('stop-owner'):cell.stop_owner(node);return self.sendj(200,{'stopped':node})
    cell.start_owner(node);return self.sendj(200,{'started':node})
   if self.path=='/shutdown':threading.Thread(target=srv.shutdown,daemon=True).start();return self.sendj(200,{'stopping':True})
   return self.sendj(404,{'error':'NOT_FOUND'})
  except ValueError as e:return self.sendj(400,{'error':'BAD_REQUEST','detail':str(e)[:200]})
  except RuntimeError as e:
   code=409 if 'NOT_RESIDENT' in str(e) or 'STALE_' in str(e) else 503;return self.sendj(code,{'error':str(e),'placementEpoch':cell.epoch})
  except (TypeError,KeyError,AttributeError,json.JSONDecodeError) as e:return self.sendj(400,{'error':'BAD_REQUEST','detail':str(e)[:200]})
srv=ThreadingHTTPServer(('127.0.0.1',a.port),H)
def stop(*_):threading.Thread(target=srv.shutdown,daemon=True).start()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
try:
 cell.start();print('RESULT_SERVICE='+json.dumps({'port':a.port,**signed_manifest},separators=(',',':')),flush=True);srv.serve_forever()
finally:cell.close();srv.server_close()
