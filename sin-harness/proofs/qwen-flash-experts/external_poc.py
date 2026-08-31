#!/usr/bin/env python3
"""Validate real Qwen layer-0 FFN through external plan-pinned bundle owners."""
from __future__ import annotations
import argparse,json,os,sys,time,urllib.parse
from pathlib import Path
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2]
ap=argparse.ArgumentParser();ap.add_argument('--shard',required=True);ap.add_argument('--endpoint',action='append',required=True);ap.add_argument('--out',required=True);ap.add_argument('--gguf-py',default=os.environ.get('GGUF_PY',str(REPO/'vendor/llama.cpp/gguf-py')));a=ap.parse_args();sys.path[:0]=[str(HERE),a.gguf_py]
import numpy as np
from cell import ALL_NODES,QwenExpertCell,deterministic_activation,softmax_top10,streamed_reference
def parse(x):
 node,sep,url=x.partition('=')
 if not sep or node not in ALL_NODES:raise SystemExit(f'invalid endpoint {x}')
 p=urllib.parse.urlparse(url)
 if p.scheme!='http' or p.hostname not in ('127.0.0.1','::1') or p.username or p.password or p.path not in ('','/') or p.query or p.fragment:raise SystemExit(f'endpoint must be loopback HTTP: {x}')
 return node,url.rstrip('/')
endpoints=dict(map(parse,a.endpoint))
if set(endpoints)!=set(ALL_NODES):raise SystemExit('endpoints must provide n1,n2,n3,n4 exactly')
cell=QwenExpertCell(a.shard,HERE/'worker.py',gguf_py=a.gguf_py,backend='numpy',external_endpoints=endpoints);cell.start();X=deterministic_activation()[None,:];ids,w=softmax_top10(X,cell.router);reference=streamed_reference(cell.T,X,ids,w)
actual,json_ms=cell.forward(X,'lan',cell.epoch);binary,binary_ms=cell.forward_binary(X,'lan',cell.epoch);max_abs=float(np.max(np.abs(actual-reference)));max_rel=float(np.max(np.abs(actual-reference)/np.maximum(np.abs(reference),1e-6)));binary_abs=float(np.max(np.abs(binary-reference)))
if max_abs>=1e-3 or max_rel>=5e-3 or binary_abs>=0.02:raise SystemExit(f'parity failed abs={max_abs} rel={max_rel} binary={binary_abs}')
benches={}
for B in (1,4,16):
 xb=X*np.linspace(.85,1.15,B,dtype=np.float32)[:,None];samples=[]
 for _ in range(3):_,ms=cell.forward_binary(xb,'lan',cell.epoch);samples.append(ms)
 med=float(np.median(samples));benches[str(B)]={'medianMs':med,'throughput':B*1000/med}
result={'schemaVersion':1,'proofId':'qwen-layer0-external-bundles-v1','outcome':'pass','timestampUtc':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'placementEpoch':cell.epoch,'selectedExperts':cell.selected,'placement':cell.placement,'replicas':cell.replicas,'endpoints':{n:'ssh-loopback-forward' for n in endpoints},'fullFfnParityMaxAbs':max_abs,'fullFfnParityMaxRel':max_rel,'binaryFp16ParityMaxAbs':binary_abs,'jsonMs':json_ms,'binaryMs':binary_ms,'binaryBenchmarks':benches,'scope':'actual Qwen layer-0 routed+shared FFN; excludes attention/SSM/residual/KV/logits/sampling and CUDA'}
out=Path(a.out);out.parent.mkdir(parents=True,exist_ok=True);tmp=out.with_suffix('.tmp');tmp.write_text(json.dumps(result,indent=2,sort_keys=True)+'\n');tmp.replace(out);print('RESULT_JSON='+json.dumps(result,separators=(',',':')))
