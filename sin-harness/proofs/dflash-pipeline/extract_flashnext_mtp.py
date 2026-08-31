#!/usr/bin/env python3
"""Resumable bounded extraction of Flash Next native MTP + embed/head."""
from __future__ import annotations
import argparse,concurrent.futures as cf,hashlib,json,os,re,shutil,struct,subprocess,threading,time,urllib.request
from pathlib import Path
HF_REPO='Qwen/Qwen3.8-Flash-Next';BASE='https://huggingface.co';PROJECT=Path(__file__).resolve().parents[3]
KEEP={'model.language_model.embed_tokens.weight','lm_head.weight'}
ap=argparse.ArgumentParser();ap.add_argument('--meta',default=os.environ.get('QWEN_HF_META',str(PROJECT/'models/qwen3.8-flash-next-hf')));ap.add_argument('--out',default=os.environ.get('QWEN_MTP_SOURCE',str(PROJECT/'models/qwen3.8-flash-next-mtp-source')));ap.add_argument('--workers',type=int,default=2);ap.add_argument('--chunk-mib',type=int,default=64);ap.add_argument('--plan',action='store_true');a=ap.parse_args();META=Path(a.meta);OUT=Path(a.out);PARTS=OUT/'parts';OUT.mkdir(parents=True,exist_ok=True);PARTS.mkdir(exist_ok=True);lock=threading.Lock()
if shutil.disk_usage(OUT).free<40*2**30:raise SystemExit('need >=40GiB free')
api=json.load(urllib.request.urlopen(f'{BASE}/api/models/{HF_REPO}'));rev=api['sha'];local_idx=json.load(open(META/'model.safetensors.index.json'));remote_raw=urllib.request.urlopen(f'{BASE}/{HF_REPO}/resolve/{rev}/model.safetensors.index.json').read();remote_idx=json.loads(remote_raw)
if local_idx!=remote_idx:raise SystemExit('local/remote index mismatch at pinned revision')
selected={k:v for k,v in local_idx['weight_map'].items() if k.startswith('mtp.') or k in KEEP}
if len(selected)!=33:raise SystemExit(f'expected 33 tensors, got {len(selected)}')

def curl_range(url,start,end,out,hdr):
 subprocess.run(['curl','--fail','--silent','--show-error','--location','--retry','8','--retry-all-errors','--range',f'{start}-{end}','--dump-header',str(hdr),'--output',str(out),url],check=True)
 if out.stat().st_size!=end-start+1:raise RuntimeError(f'range length mismatch {url} {start}-{end}: {out.stat().st_size}')
 text=hdr.read_text(errors='replace').lower();matches=re.findall(r'content-range:\s*bytes\s+(\d+)-(\d+)/(\d+)',text)
 if not matches:raise RuntimeError(f'server ignored Range {start}-{end}')
 if tuple(map(int,matches[-1][:2]))!=(start,end):raise RuntimeError(f'content-range mismatch {matches[-1]} != {start}-{end}')

def header_for(shard):
 url=f'{BASE}/{HF_REPO}/resolve/{rev}/{shard}';tmp=OUT/f'.hdr-{shard}'
 curl_range(url,0,7,tmp,tmp.with_suffix('.http'));n=struct.unpack('<Q',tmp.read_bytes())[0];curl_range(url,8,7+n,tmp,tmp.with_suffix('.http'));h=json.loads(tmp.read_bytes());tmp.unlink(missing_ok=True);tmp.with_suffix('.http').unlink(missing_ok=True);return n,h
headers={}
for shard in sorted(set(selected.values())):headers[shard]=header_for(shard)
specs={}
for name,shard in selected.items():
 n,h=headers[shard];info=h[name];lo,hi=map(int,info['data_offsets']);specs[name]={'name':name,'shard':shard,'dtype':info['dtype'],'shape':info['shape'],'start':8+n+lo,'end':8+n+hi-1,'bytes':hi-lo}
if sum(s['bytes'] for s in specs.values())!=7757098496:raise SystemExit(f'unexpected payload {sum(s["bytes"] for s in specs.values())}')
if a.plan:
 print('RESULT_JSON='+json.dumps({'revision':rev,'tensors':len(specs),'files':len(headers),'bytes':sum(s['bytes'] for s in specs.values())},separators=(',',':')));raise SystemExit(0)

def part_path(name):return PARTS/(hashlib.sha256(name.encode()).hexdigest()+'.part')
def download(name):
 s=specs[name];p=part_path(name);have=p.stat().st_size if p.exists() else 0
 if have>s['bytes']:
  bad=p.with_suffix(f'.bad.{int(time.time())}');p.rename(bad);raise RuntimeError(f'oversize part quarantined {bad}')
 url=f'{BASE}/{HF_REPO}/resolve/{rev}/{s["shard"]}';chunk=a.chunk_mib*2**20
 while have<s['bytes']:
  n=min(chunk,s['bytes']-have);start=s['start']+have;end=start+n-1;ct=p.with_suffix('.chunk');hd=p.with_suffix('.headers')
  curl_range(url,start,end,ct,hd)
  with open(p,'ab') as dst,open(ct,'rb') as src:
   shutil.copyfileobj(src,dst,8*2**20);dst.flush();os.fsync(dst.fileno())
  ct.unlink();hd.unlink();have+=n
 h=hashlib.sha256()
 with open(p,'rb') as f:
  while b:=f.read(8*2**20):h.update(b)
 with lock:print(f'DONE {name} {s["bytes"]/2**20:.1f}MiB {h.hexdigest()[:12]}',flush=True)
 return name,h.hexdigest()
with cf.ThreadPoolExecutor(max_workers=max(1,min(a.workers,2))) as ex:hashes=dict(ex.map(download,sorted(specs)))
# Consolidate atomically in lexical tensor order.
ordered=sorted(specs);offset=0;head={'__metadata__':{'format':'pt','source':HF_REPO,'revision':rev,'scope':'mtp+embed+head'}}
for name in ordered:
 s=specs[name];head[name]={'dtype':s['dtype'],'shape':s['shape'],'data_offsets':[offset,offset+s['bytes']]};offset+=s['bytes']
raw=json.dumps(head,separators=(',',':')).encode();raw+=b' '*((8-len(raw)%8)%8);tmp=OUT/'model-00001-of-00001.safetensors.tmp';final=OUT/'model-00001-of-00001.safetensors'
with open(tmp,'wb') as out:
 out.write(struct.pack('<Q',len(raw)));out.write(raw)
 for name in ordered:
  with open(part_path(name),'rb') as src:shutil.copyfileobj(src,out,8*2**20)
 out.flush();os.fsync(out.fileno())
if tmp.stat().st_size!=8+len(raw)+offset:raise RuntimeError('consolidated length mismatch')
os.replace(tmp,final)
for f in META.iterdir():
 if f.is_file() and f.name not in ('model.safetensors.index.json',):shutil.copy2(f,OUT/f.name)
idx={'metadata':{'total_size':offset},'weight_map':{k:final.name for k in ordered}};(OUT/'model.safetensors.index.json').write_text(json.dumps(idx,indent=2,sort_keys=True))
manifest={'repo':HF_REPO,'revision':rev,'bytes':offset,'tensors':[{**specs[k],'sha256':hashes[k],'part':part_path(k).name} for k in ordered],'consolidated':final.name,'consolidatedSha256':None}
# Stream the 7.2-GiB digest; never materialize the consolidated file.
h=hashlib.sha256()
with open(final,'rb') as f:
 while b:=f.read(8*2**20):h.update(b)
manifest['consolidatedSha256']=h.hexdigest();(OUT/'mtp-extract-manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True))
print('RESULT_JSON='+json.dumps({'out':str(final),'revision':rev,'tensors':len(ordered),'bytes':offset,'sha256':h.hexdigest()},separators=(',',':')))
