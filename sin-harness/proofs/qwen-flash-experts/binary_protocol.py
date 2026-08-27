"""Bounded little-endian FP16 frames for the Qwen expert service."""
import struct
import numpy as np
VERSION=1;HIDDEN=2560;MAX_BATCH=16
SREQ=struct.Struct('<4sBBHH32s');SRESP=struct.Struct('<4sBHH32s')
WREQ=struct.Struct('<4sBHHHH32s');WRESP=SRESP
PROFILES={'lan':0,'eu':1};PROFILE_IDS={v:k for k,v in PROFILES.items()}
def _epoch_bytes(epoch):
 b=bytes.fromhex(epoch)
 if len(b)!=32:raise ValueError('epoch must be 32-byte hex')
 return b
def encode_service_request(X,profile,epoch):
 X=np.asarray(X,dtype=np.float16)
 if X.ndim!=2 or X.shape[1]!=HIDDEN or not 1<=len(X)<=MAX_BATCH:raise ValueError('bad activation shape')
 return SREQ.pack(b'QFFN',VERSION,PROFILES[profile],len(X),HIDDEN,_epoch_bytes(epoch))+X.astype('<f2',copy=False).tobytes()
def decode_service_request(raw):
 if len(raw)<SREQ.size:raise ValueError('short frame')
 magic,v,p,b,h,e=SREQ.unpack_from(raw)
 if magic!=b'QFFN' or v!=VERSION or p not in PROFILE_IDS or h!=HIDDEN or not 1<=b<=MAX_BATCH:raise ValueError('bad service header')
 need=SREQ.size+b*h*2
 if len(raw)!=need:raise ValueError('bad service frame length')
 X=np.frombuffer(raw,dtype='<f2',offset=SREQ.size,count=b*h).astype(np.float32).reshape(b,h)
 return X,PROFILE_IDS[p],e.hex()
def encode_service_response(Y,epoch):
 Y=np.asarray(Y,dtype=np.float16);b,h=Y.shape
 return SRESP.pack(b'QFFR',VERSION,b,h,_epoch_bytes(epoch))+Y.astype('<f2',copy=False).tobytes()
def decode_service_response(raw):
 if len(raw)<SRESP.size:raise ValueError('short response')
 m,v,b,h,e=SRESP.unpack_from(raw)
 if m!=b'QFFR' or v!=VERSION or h!=HIDDEN:raise ValueError('bad response header')
 if len(raw)!=SRESP.size+b*h*2:raise ValueError('bad response length')
 return np.frombuffer(raw,dtype='<f2',offset=SRESP.size,count=b*h).astype(np.float32).reshape(b,h),e.hex()
def encode_worker_request(X,assignments,epoch,delay_ms=0):
 X=np.asarray(X,dtype=np.float16);b,h=X.shape;n=len(assignments)
 if not 0<=delay_ms<=100:raise ValueError('bad delay')
 out=bytearray(WREQ.pack(b'QEX1',VERSION,b,h,n,int(delay_ms),_epoch_bytes(epoch)))
 for item in assignments:
  w=np.asarray(item['weights'],dtype=np.float16)
  if w.shape!=(b,):raise ValueError('bad gate weights')
  out+=struct.pack('<H',int(item['expertId']));out+=w.astype('<f2',copy=False).tobytes()
 out+=X.astype('<f2',copy=False).tobytes();return bytes(out)
def decode_worker_request(raw):
 if len(raw)<WREQ.size:raise ValueError('short worker frame')
 m,v,b,h,n,delay,e=WREQ.unpack_from(raw)
 if m!=b'QEX1' or v!=VERSION or h!=HIDDEN or not 1<=b<=MAX_BATCH or not 1<=n<=10 or delay>100:raise ValueError('bad worker header')
 off=WREQ.size;assign=[]
 for _ in range(n):
  if off+2+2*b>len(raw):raise ValueError('short assignment')
  eid=struct.unpack_from('<H',raw,off)[0];off+=2;w=np.frombuffer(raw,dtype='<f2',offset=off,count=b).astype(np.float32);off+=2*b;assign.append({'expertId':eid,'weights':w})
 if len(raw)!=off+b*h*2:raise ValueError('bad worker length')
 X=np.frombuffer(raw,dtype='<f2',offset=off,count=b*h).astype(np.float32).reshape(b,h)
 return X,assign,e.hex(),delay
def encode_worker_response(partial,epoch):
 Y=np.asarray(partial,dtype=np.float16);b,h=Y.shape
 return WRESP.pack(b'QER1',VERSION,b,h,_epoch_bytes(epoch))+Y.astype('<f2',copy=False).tobytes()
def decode_worker_response(raw):
 m,v,b,h,e=WRESP.unpack_from(raw)
 if m!=b'QER1' or v!=VERSION or h!=HIDDEN or len(raw)!=WRESP.size+b*h*2:raise ValueError('bad worker response')
 return np.frombuffer(raw,dtype='<f2',offset=WRESP.size,count=b*h).astype(np.float32).reshape(b,h),e.hex()
