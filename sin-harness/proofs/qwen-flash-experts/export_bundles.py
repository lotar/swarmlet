#!/usr/bin/env python3
"""Export the plan-pinned Qwen layer-0 top-10 experts as portable FP16 bundles."""
from __future__ import annotations
import argparse,hashlib,json,os,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2]
ap=argparse.ArgumentParser();ap.add_argument('--shard',required=True);ap.add_argument('--out',required=True);ap.add_argument('--gguf-py',default=os.environ.get('GGUF_PY',str(REPO/'vendor/llama.cpp/gguf-py')));a=ap.parse_args();sys.path[:0]=[str(HERE),a.gguf_py]
import numpy as np
from gguf.quants import dequantize
from bundle_format import array_key,save_bundle
from cell import QwenExpertCell,NAMES
cell=QwenExpertCell(a.shard,HERE/'worker.py',gguf_py=a.gguf_py,backend='numpy');out=Path(a.out);out.mkdir(parents=True,exist_ok=True);bundles=[]
for node,expert_ids in cell.worker_experts.items():
 arrays={}
 for eid in expert_ids:
  for short,name in zip(('gate','up','down'),NAMES):arrays[array_key(eid,short)]=dequantize(cell.T[name].data[eid],cell.T[name].tensor_type).astype(np.float16)
 metadata={'formatVersion':1,'model':'Qwen3.8-Flash-Next-UD-Q4_K_XL','layer':0,'nodeId':node,'expertIds':sorted(expert_ids),'placementEpoch':cell.epoch,'ownedContentDigest':cell.node_digests[node],'rawExpertDigests':{str(e):cell.expert_digests[str(e)] for e in sorted(expert_ids)},'dtype':'float16','hidden':2560,'expertFfn':640,'lazyReplica':node=='n4'}
 path=out/f'{node}.npz';metadata=save_bundle(path,metadata,arrays);digest=hashlib.sha256()
 with open(path,'rb') as f:
  while chunk:=f.read(8*1024*1024):digest.update(chunk)
 h=digest.hexdigest();bundles.append({'nodeId':node,'path':path.name,'bytes':path.stat().st_size,'sha256':h,'arrayDigest':metadata['arrayDigest'],'expertIds':sorted(expert_ids)})
manifest={'schemaVersion':1,'model':'Qwen3.8-Flash-Next-UD-Q4_K_XL','layer':0,'placementEpoch':cell.epoch,'selectedExperts':cell.selected,'placement':cell.placement,'replicas':cell.replicas,'bundles':bundles};(out/'manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n');print('RESULT_JSON='+json.dumps(manifest,separators=(',',':')))
