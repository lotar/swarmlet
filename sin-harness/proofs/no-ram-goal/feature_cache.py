#!/usr/bin/env python3
"""Append-only content-addressed hidden-feature cache with crash recovery."""
import hashlib,json,os,shutil,struct,tempfile
from pathlib import Path
import numpy as np
MAGIC=b'DFHC0001';HDR=struct.Struct('<IQ')
def scan_detail(path):
 rows=[];last=len(MAGIC)
 with open(path,'rb') as f:
  if f.read(8)!=MAGIC:raise ValueError('bad cache magic')
  while True:
   off=f.tell();h=f.read(HDR.size)
   if not h:break
   if len(h)<HDR.size:break
   ml,pl=HDR.unpack(h);m=f.read(ml);p=f.read(pl);d=f.read(32)
   if len(m)!=ml or len(p)!=pl or len(d)!=32:break
   if hashlib.sha256(m+p).digest()!=d:raise ValueError(f'checksum mismatch at {off}')
   meta=json.loads(m);a=np.frombuffer(p,dtype='<f2').reshape(meta['shape']);last=f.tell();rows.append((meta,a.copy(),off,d.hex(),last-off))
 return rows,last
def scan(path):return [(m,a,o,d) for m,a,o,d,_ in scan_detail(path)[0]]
class Writer:
 def __init__(self,path,index):
  self.path=Path(path);self.index=Path(index);new=not self.path.exists()
  if new:
   with open(self.path,'wb') as f:f.write(MAGIC);f.flush();os.fsync(f.fileno())
  else:
   rows,last=scan_detail(self.path)
   with open(self.path,'r+b') as f:f.truncate(last);f.flush();os.fsync(f.fileno())
   with open(self.index,'w') as ix:
    for meta,_,off,digest,size in rows:ix.write(json.dumps({**meta,'offset':off,'recordBytes':size,'sha256':digest},sort_keys=True)+'\n')
    ix.flush();os.fsync(ix.fileno())
  self.f=open(self.path,'ab')
 def append(self,sample_id,features,taps,target_hash):
  a=np.asarray(features,dtype='<f2');meta={'sampleId':sample_id,'dtype':'f16','shape':list(a.shape),'taps':list(taps),'targetHash':target_hash};m=json.dumps(meta,sort_keys=True,separators=(',',':')).encode();p=a.tobytes();digest=hashlib.sha256(m+p).digest();off=self.f.tell();self.f.write(HDR.pack(len(m),len(p)));self.f.write(m);self.f.write(p);self.f.write(digest);self.f.flush();os.fsync(self.f.fileno());row={**meta,'offset':off,'recordBytes':HDR.size+len(m)+len(p)+32,'sha256':digest.hex()}
  with open(self.index,'a') as ix:ix.write(json.dumps(row,sort_keys=True)+'\n');ix.flush();os.fsync(ix.fileno())
  return row
 def close(self):self.f.close()
def selftest():
 with tempfile.TemporaryDirectory() as d:
  p=Path(d)/'cache.bin';i=Path(d)/'index.jsonl';w=Writer(p,i)
  for n in range(3):w.append(f's{n}',np.arange(2*5*8,dtype=np.float16).reshape(2,5,8)+n,[3,15,27,39,47],'target-sha')
  w.close();assert len(scan(p))==3
  q=Path(d)/'truncated.bin';qi=Path(d)/'truncated.jsonl';shutil.copy2(p,q);shutil.copy2(i,qi);q.write_bytes(q.read_bytes()[:-17]);assert len(scan(q))==2
  w=Writer(q,qi);w.append('s3',np.ones((2,5,8),dtype=np.float16),[3,15,27,39,47],'target-sha');w.close();rows=scan(q);assert len(rows)==3 and rows[-1][0]['sampleId']=='s3';idx=[json.loads(x) for x in qi.read_text().splitlines()];assert len(idx)==3
  result={'records':3,'recoveredAfterTruncation':2,'appendAfterRecovery':True,'hashVerified':True,'dtype':'f16','formatVersion':1};print('RESULT_JSON='+json.dumps(result,separators=(',',':')));return result
if __name__=='__main__':selftest()
