#!/usr/bin/env python3
"""Fail-fast DFlash target/draft GGUF compatibility gate (metadata only)."""
import argparse,json,os,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2];LLAMA=Path(os.environ.get('LLAMA_CPP',REPO/'vendor/llama.cpp'));sys.path.insert(0,str(LLAMA/'gguf-py'))
from gguf import GGUFReader

def value(r,key):
 f=r.fields[key];out=[]
 for i in f.data:
  x=f.parts[i]
  try:x=x.item()
  except:pass
  if hasattr(x,'tobytes') and str(getattr(x,'dtype',''))=='uint8':x=x.tobytes().decode(errors='replace')
  out.append(x)
 return out[0] if len(out)==1 else out
def vocab(r):return len(r.fields.get('tokenizer.ggml.tokens').data) if r.fields.get('tokenizer.ggml.tokens') else None
ap=argparse.ArgumentParser();ap.add_argument('--target',default=os.environ.get('QWEN_TARGET',str(REPO/'models/qwen3.8-flash-next/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00005.gguf')));ap.add_argument('--draft',default=os.environ.get('DFLASH_DRAFT',str(REPO/'models/dflash2-Q8_0.gguf')));ap.add_argument('--expect-incompatible',action='store_true');a=ap.parse_args();t=GGUFReader(a.target,'r');d=GGUFReader(a.draft,'r')
target={'arch':value(t,'general.architecture'),'layers':int(value(t,'qwen4exp.block_count')),'hidden':int(value(t,'qwen4exp.embedding_length')),'vocab':vocab(t)}
draft={'arch':value(d,'general.architecture'),'layers':int(value(d,'dflash.block_count')),'hidden':int(value(d,'dflash.embedding_length')),'targetLayers':list(map(int,value(d,'dflash.target_layers'))),'blockSize':int(value(d,'dflash.block_size')),'vocab':vocab(d)}
reasons=[]
if draft['arch']!='dflash':reasons.append('draft architecture is not dflash')
if target['hidden']!=draft['hidden']:reasons.append(f"hidden mismatch {target['hidden']} != {draft['hidden']}")
if max(draft['targetLayers'])>=target['layers']:reasons.append(f"draft target tap {max(draft['targetLayers'])} outside {target['layers']} layers")
if target['vocab'] and draft['vocab'] and target['vocab']!=draft['vocab']:reasons.append(f"vocab mismatch {target['vocab']} != {draft['vocab']}")
compatible=not reasons;result={'compatible':compatible,'target':target,'draft':draft,'reasons':reasons};print('RESULT_JSON='+json.dumps(result,separators=(',',':')))
if a.expect_incompatible:sys.exit(0 if not compatible else 3)
sys.exit(0 if compatible else 2)
