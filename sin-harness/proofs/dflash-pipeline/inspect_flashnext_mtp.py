#!/usr/bin/env python3
"""Measure upstream Flash Next MTP tensors using range headers only."""
import argparse,json,os,struct,subprocess
from collections import defaultdict
from pathlib import Path
PROJECT=Path(__file__).resolve().parents[3]
ap=argparse.ArgumentParser();ap.add_argument('--index',default=os.environ.get('QWEN_HF_INDEX',str(PROJECT/'models/qwen3.8-flash-next-hf/model.safetensors.index.json')));ap.add_argument('--repo',default='https://huggingface.co/Qwen/Qwen3.8-Flash-Next/resolve/main/');a=ap.parse_args()
idx=json.load(open(a.index))['weight_map'];files=defaultdict(list)
for k,f in idx.items():
 if k.startswith('mtp.'):files[f].append(k)
total=0;rows=[]
for f,keys in sorted(files.items()):
 url=a.repo.rstrip('/')+'/'+f;n=struct.unpack('<Q',subprocess.check_output(['curl','-fsSL','-r','0-7',url]))[0]
 h=json.loads(subprocess.check_output(['curl','-fsSL','-r',f'8-{7+n}',url]));size=sum(h[k]['data_offsets'][1]-h[k]['data_offsets'][0] for k in keys);total+=size;rows.append({'file':f,'tensors':len(keys),'bytes':size})
result={'tensors':sum(len(x) for x in files.values()),'files':len(files),'bytes':total,'GiB':total/2**30,'rows':rows};print('RESULT_JSON='+json.dumps(result,separators=(',',':')));assert result['tensors']==31 and 4.8<result['GiB']<4.9
