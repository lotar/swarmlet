#!/usr/bin/env python3
"""Write exact contiguous Qwen35 layer shards, preserving recurrence and quantized bytes."""
import argparse, hashlib, json, pathlib, re, sys

def digest(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  while b:=f.read(8<<20): h.update(b)
 return h.hexdigest()

def extract(source, out, cuts, engine):
 sys.path.insert(0,str(engine/'gguf-py'))
 import gguf
 r=gguf.GGUFReader(source)
 def val(k,default=None):
  f=r.get_field(k); return f.contents() if f else default
 arch=val('general.architecture')
 if arch!='qwen35': raise ValueError('only qwen35 is qualified by this extractor')
 total=val('qwen35.block_count')
 if cuts[0]!=0 or cuts[-1]!=total or any(a>=b for a,b in zip(cuts,cuts[1:])): raise ValueError('cuts must exactly cover all layers')
 if val('qwen35.nextn_predict_layers',0): raise ValueError('MTP layers are outside this stage proof')
 recurring=val('qwen35.attention.recurrent_layers')
 if recurring is None:
  interval=val('qwen35.attention.full_attention_interval',4)
  recurring=[(i+1)%interval!=0 for i in range(total)]
 out.mkdir(parents=True,exist_ok=True); source_hash=digest(source); manifests=[]
 for start,end in zip(cuts,cuts[1:]):
  path=out/f'stage-{start}-{end}.gguf'
  if path.exists(): raise FileExistsError(path)
  w=gguf.GGUFWriter(path,arch)
  overrides={'qwen35.block_count':end-start,'qwen35.attention.recurrent_layers':recurring[start:end]}
  for field in r.fields.values():
   if field.name.startswith('GGUF.') or field.name=='general.architecture' or field.name.startswith('split.'): continue
   if field.name in overrides: continue
   value=field.contents()
   if value is not None: w.add_key_value(field.name,value,field.types[0],sub_type=field.types[-1] if field.types[0]==gguf.GGUFValueType.ARRAY else None)
  w.add_uint32('qwen35.block_count',end-start)
  w.add_array('qwen35.attention.recurrent_layers',recurring[start:end])
  for k,v in [('start',start),('end',end),('total',total)]: w.add_uint32('mesh.stage.'+k,v)
  w.add_string('mesh.stage.source_sha256',source_hash)
  selected=[]
  for t in r.tensors:
   match=re.match(r'blk\.(\d+)\.(.+)',t.name); name=t.name
   if match:
    idx=int(match[1])
    if not start<=idx<end: continue
    name=f'blk.{idx-start}.{match[2]}'
   elif name=='token_embd.weight':
    if start!=0 and not (end==total and not any(x.name=='output.weight' for x in r.tensors)): continue
   elif name in ('output.weight','output_norm.weight'):
    if end!=total: continue
   else: raise ValueError(f'unexpected global tensor {name}')
   w.add_tensor_info(name,t.data.shape,t.data.dtype,t.data.nbytes,t.tensor_type); selected.append(t)
  w.write_header_to_file(); w.write_kv_data_to_file(); w.write_ti_data_to_file()
  for t in selected: w.write_tensor_data(t.data,tensor_endianess=r.endianess)
  w.close()
  m={'schema':1,'source_sha256':source_hash,'sha256':digest(path),'start':start,'end':end,'total':total,'tensor_count':len(selected),'path':str(path.resolve())}
  path.with_suffix('.json').write_text(json.dumps(m,indent=2)); manifests.append(m)
 (out/'manifest.json').write_text(json.dumps(manifests,indent=2)); return manifests
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('source',type=pathlib.Path);p.add_argument('out',type=pathlib.Path);p.add_argument('--cuts',required=True);p.add_argument('--engine',type=pathlib.Path,required=True);a=p.parse_args()
 print(json.dumps(extract(a.source,a.out,list(map(int,a.cuts.split(','))),a.engine)))
