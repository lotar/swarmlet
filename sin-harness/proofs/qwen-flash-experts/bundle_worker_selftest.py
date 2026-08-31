#!/usr/bin/env python3
"""No-model smoke test for the portable Linux selected-expert worker."""
import json,socket,struct,subprocess,sys,tempfile,time,urllib.error,urllib.request
from pathlib import Path
import numpy as np
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
from bundle_format import array_key,save_bundle
from binary_protocol import WREQ,decode_worker_request,encode_worker_request

def request(url,body=None):
 if body is None:r=urllib.request.urlopen(url,timeout=10)
 else:r=urllib.request.urlopen(urllib.request.Request(url,data=json.dumps(body).encode(),headers={'content-type':'application/json'}),timeout=30)
 with r:return json.load(r)
def selftest():
 with tempfile.TemporaryDirectory() as d:
  p=Path(d)/'n1.npz';epoch='a'*64;arrays={array_key(7,'gate'):np.zeros((640,2560),np.float16),array_key(7,'up'):np.zeros((640,2560),np.float16),array_key(7,'down'):np.zeros((2560,640),np.float16)};meta=save_bundle(p,{'formatVersion':1,'model':'test','layer':0,'nodeId':'n1','expertIds':[7],'placementEpoch':epoch,'ownedContentDigest':'b'*64,'rawExpertDigests':{'7':'c'*64},'dtype':'float16','hidden':2560,'expertFfn':640,'lazyReplica':False},arrays)
  sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
  proc=subprocess.Popen([sys.executable,str(HERE/'worker.py'),'--id','n1','--port',str(port),'--bundle',str(p),'--experts','7','--epoch',epoch,'--backend','numpy'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
  try:
   for _ in range(200):
    if proc.poll() is not None:raise RuntimeError(proc.stderr.read())
    try:manifest=request(f'http://127.0.0.1:{port}/manifest');break
    except urllib.error.URLError:time.sleep(.02)
   else:raise RuntimeError('bundle worker startup timeout')
   assert manifest['backend']=='numpy-bundle' and manifest['bundleContentDigest']==meta['arrayDigest'] and manifest['expertIds']==[7]
   body={'placementEpoch':epoch,'activations':[([0.0]*2560)],'assignments':[{'expertId':7,'weights':[1.0]}],'delayMs':0};out=request(f'http://127.0.0.1:{port}/execute',body);weighted=out['pieces'][0]['weighted'][0];assert len(weighted)==2560 and max(map(abs,weighted))==0
   try:request(f'http://127.0.0.1:{port}/execute',{**body,'placementEpoch':'0'*64});raise AssertionError('stale epoch accepted')
   except urllib.error.HTTPError as e:assert e.code==409
   try:encode_worker_request(np.full((1,2560),np.nan,np.float32),[{'expertId':7,'weights':[1.0]}],epoch);raise AssertionError('non-finite encode accepted')
   except ValueError:pass
   frame=bytearray(encode_worker_request(np.zeros((1,2560),np.float32),[{'expertId':7,'weights':[1.0]}],epoch));frame[WREQ.size+4:WREQ.size+6]=struct.pack('<H',0x7e00)
   try:decode_worker_request(bytes(frame));raise AssertionError('non-finite decode accepted')
   except ValueError:pass
   result={'verified':True,'backend':'numpy-bundle','outputWidth':len(weighted),'staleEpochRejected':True,'nonFiniteRejected':True,'bundleDigest':meta['arrayDigest']};print('RESULT_JSON='+json.dumps(result,separators=(',',':')));return result
  finally:
   proc.kill();proc.wait(timeout=10)
if __name__=='__main__':selftest()
