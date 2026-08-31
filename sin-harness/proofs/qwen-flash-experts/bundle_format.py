#!/usr/bin/env python3
"""Portable FP16 selected-expert bundle format (NumPy NPZ, no pickle)."""
from __future__ import annotations
import hashlib,json
from pathlib import Path
import numpy as np
NAMES=('gate','up','down')
def canon(x):return json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def array_key(eid,name):return f'expert_{int(eid)}_{name}'
def content_digest(metadata,arrays):
 body={k:v for k,v in metadata.items() if k!='arrayDigest'};h=hashlib.sha256(canon(body)+b'\0')
 for eid in sorted(map(int,metadata['expertIds'])):
  for name in NAMES:
   key=array_key(eid,name);a=np.ascontiguousarray(arrays[key]);h.update(key.encode()+b'\0');h.update(canon({'dtype':a.dtype.str,'shape':list(a.shape)})+b'\0');h.update(memoryview(a).cast('B'))
 return h.hexdigest()
def save_bundle(path,metadata,arrays):
 arrays={k:np.ascontiguousarray(v,dtype=np.float16) for k,v in arrays.items()};metadata={**metadata,'arrayDigest':content_digest(metadata,arrays)};payload={**arrays,'__metadata__':np.frombuffer(canon(metadata),dtype=np.uint8)};path=Path(path);tmp=path.with_suffix(path.suffix+'.tmp')
 with open(tmp,'wb') as f:np.savez_compressed(f,**payload)
 tmp.replace(path);return metadata
def load_bundle(path):
 with np.load(path,allow_pickle=False) as z:
  metadata=json.loads(bytes(np.asarray(z['__metadata__'],dtype=np.uint8)).decode());arrays={k:np.asarray(z[k],dtype=np.float16) for k in z.files if k!='__metadata__'}
 if metadata.get('formatVersion')!=1 or not isinstance(metadata.get('expertIds'),list):raise ValueError('unsupported expert bundle')
 expected={array_key(e,n) for e in metadata['expertIds'] for n in NAMES}
 if set(arrays)!=expected:raise ValueError('bundle array set mismatch')
 if content_digest(metadata,arrays)!=metadata.get('arrayDigest'):raise ValueError('bundle content digest mismatch')
 return metadata,arrays

def selftest():
 import tempfile
 with tempfile.TemporaryDirectory() as d:
  p=Path(d)/'owner.npz';arrays={array_key(7,n):np.arange(24,dtype=np.float16).reshape(4,6) for n in NAMES};meta=save_bundle(p,{'formatVersion':1,'nodeId':'n1','expertIds':[7],'placementEpoch':'a'*64},arrays);loaded,values=load_bundle(p);assert loaded['arrayDigest']==meta['arrayDigest'] and set(values)==set(arrays)
  return {'formatVersion':1,'verified':True,'arrays':3,'digest':meta['arrayDigest']}
if __name__=='__main__':
 print('RESULT_JSON='+json.dumps(selftest(),separators=(',',':')))
