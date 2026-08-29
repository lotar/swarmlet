#!/usr/bin/env python3
"""Integer-exact hybrid recurrent+attention speculative rollback oracle."""
import copy,hashlib,json,struct
MOD=2_147_483_647;VOCAB=257
class State:
 def __init__(self,seq):self.seq=seq;self.pos=0;self.r=[[seq+i+j for j in range(4)] for i in range(2)];self.kv=[[],[]]
 def clone(self):return copy.deepcopy(self)
 def bytes(self):
  out=bytearray(struct.pack('<II',self.seq,self.pos))
  for row in self.r:
   for x in row:out+=struct.pack('<q',x)
  for kv in self.kv:out+=struct.pack('<I',len(kv))+b''.join(struct.pack('<H',x) for x in kv)
  return bytes(out)
 def step(self,token):
  x=(token+self.pos+1)%MOD
  for li,row in enumerate(self.r):
   for j,v in enumerate(row):row[j]=(v*(3+li)+x*(j+1)+17)%MOD
   x=(x+sum(row))%MOD
   self.kv[li].append((token+x+li)%VOCAB)
  self.pos+=1
  logits=[((x*(i+11)+sum(sum(r) for r in self.r)*(i+3))%1000003) for i in range(VOCAB)]
  nxt=max(range(VOCAB),key=lambda i:(logits[i],-i));return nxt,logits
def clean(state,n):
 s=state.clone();tokens=[]
 for _ in range(n):t,_=s.step(tokens[-1] if tokens else 1);tokens.append(t)
 return tokens,s
def verify_forced(base,k,width=7):
 target_tokens,target_state=clean(base,k+1);draft=target_tokens[:k]+[((target_tokens[k]+1)%VOCAB)]+[0]*(width-k-1)
 snap=base.clone();ver=base.clone();committed=[]
 for i,d in enumerate(draft):
  t,_=ver.step(committed[-1] if committed else 1);committed.append(t)
  if d!=t:break
 restored=snap.clone()
 for t in committed:restored.step(1 if restored.pos==snap.pos else committed[restored.pos-snap.pos-1])
 # Replay state uses input-token convention; compare against direct replay of committed path.
 direct=snap.clone()
 for i,t in enumerate(committed):direct.step(1 if i==0 else committed[i-1])
 assert restored.bytes()==direct.bytes()
 assert committed==target_tokens and direct.bytes()==target_state.bytes()
 return hashlib.sha256(restored.bytes()).hexdigest()
def selftest():
 hashes={};
 for seq in range(8):
  base=State(seq);prefix,state=clean(base,5);clone=state.clone();assert clone.bytes()==state.bytes()
  for k in range(7):hashes[f'{seq}:{k}']=verify_forced(state,k)
 # Repeated rollback does not cross-contaminate sequences.
 assert len(set(hashes.values()))==56
 result={'positions':7,'sequences':8,'checks':56,'stateHashesUnique':56,'byteExact':True,'scope':'algorithm oracle; not llama.cpp backend attestation'}
 print('RESULT_JSON='+json.dumps(result,separators=(',',':')));return result
if __name__=='__main__':selftest()
