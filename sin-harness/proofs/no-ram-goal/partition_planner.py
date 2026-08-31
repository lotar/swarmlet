#!/usr/bin/env python3
"""Contiguous Qwen layer partition planner using actual GGUF tensor bytes."""
import json,math,os,re,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2];LLAMA=Path(os.environ.get('LLAMA_CPP',REPO/'vendor/llama.cpp'));sys.path.insert(0,str(LLAMA/'gguf-py'))
from gguf import GGUFReader
MODEL=Path(os.environ.get('QWEN_MODEL_DIR',REPO/'models/qwen3.8-flash-next/UD-Q4_K_XL'))
def inventory():
 layer=[0]*48;ple=0;token=0;output=0;other=0
 for p in sorted(MODEL.glob('*.gguf')):
  r=GGUFReader(str(p),'r')
  for t in r.tensors:
   m=re.match(r'blk\.(\d+)\.',t.name)
   if m:
    if 'ple_ngram_embd' in t.name:ple+=t.n_bytes
    else:layer[int(m.group(1))]+=t.n_bytes
   elif t.name=='token_embd.weight':token+=t.n_bytes
   elif t.name=='output.weight':output+=t.n_bytes
   else:other+=t.n_bytes
 return layer,ple,token,output,other
def plan(stages=8,cap_gib=12):
 layer,ple,token,output,other=inventory();cap=cap_gib*2**30;avg=sum(layer)/48;compute=[b/avg*(1.15 if (i+1)%4==0 else 1.0) for i,b in enumerate(layer)];prefix=[0];cp=[0]
 for b,c in zip(layer,compute):prefix.append(prefix[-1]+b);cp.append(cp[-1]+c)
 inf=(1e99,None);dp=[[inf]*(49) for _ in range(stages+1)];dp[0][0]=(0,None)
 for k in range(1,stages+1):
  for j in range(k,49):
   best=inf
   for i in range(k-1,j):
    prev=dp[k-1][i][0]
    if prev>=1e99:continue
    mem=prefix[j]-prefix[i]+(token+other if k==1 else 0)+(output if k==stages and j==48 else 0)
    if mem>cap:continue
    cost=cp[j]-cp[i];score=max(prev,cost)
    if score<best[0]:best=(score,i)
   dp[k][j]=best
 if dp[stages][48][0]>=1e99:raise RuntimeError('no feasible partition')
 cuts=[48];j=48
 for k in range(stages,0,-1):j=dp[k][j][1];cuts.append(j)
 cuts=sorted(cuts);parts=[]
 for k,(i,j) in enumerate(zip(cuts,cuts[1:]),1):
  mem=prefix[j]-prefix[i]+(token+other if k==1 else 0)+(output if k==stages else 0);parts.append({'stage':k-1,'layers':[i,j-1],'layerCount':j-i,'weightBytes':mem,'weightGiB':mem/2**30,'computeScore':cp[j]-cp[i]})
 result={'stages':stages,'capGiB':cap_gib,'parts':parts,'pleSystemRamGiB':ple/2**30,'tokenGiB':token/2**30,'outputGiB':output/2**30,'otherGlobalGiB':other/2**30,'gpuWeightGiB':sum(x['weightBytes'] for x in parts)/2**30,'maxStageGiB':max(x['weightGiB'] for x in parts),'maxComputeScore':max(x['computeScore'] for x in parts)}
 assert len(parts)==8 and all(x['layerCount']==6 for x in parts)
 assert parts[0]['layers'][0]==0 and parts[-1]['layers'][1]==47 and all(x['weightGiB']<=cap_gib for x in parts)
 assert all(parts[i]['layers'][1]+1==parts[i+1]['layers'][0] for i in range(7))
 print('RESULT_JSON='+json.dumps(result,separators=(',',':')));return result
if __name__=='__main__':plan()
