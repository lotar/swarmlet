#!/usr/bin/env python3
"""Dependency-free validator for the committed JSON-Schema subset."""
import json,sys
from pathlib import Path
def check(v,s,path='$'):
 if 'const' in s:assert v==s['const'],f'{path}: const'
 if 'enum' in s:assert v in s['enum'],f'{path}: enum'
 types=s.get('type');types=[types] if isinstance(types,str) else types
 if types:
  ok=any((t=='null' and v is None)or(t=='object' and isinstance(v,dict))or(t=='array' and isinstance(v,list))or(t=='string' and isinstance(v,str))or(t=='integer' and isinstance(v,int)and not isinstance(v,bool))or(t=='number' and isinstance(v,(int,float))and not isinstance(v,bool))or(t=='boolean' and isinstance(v,bool)) for t in types);assert ok,f'{path}: type {types}'
 if v is None:return
 if isinstance(v,str) and 'minLength'in s:assert len(v)>=s['minLength'],f'{path}: minLength'
 if isinstance(v,(int,float)) and not isinstance(v,bool):
  if 'minimum'in s:assert v>=s['minimum'],f'{path}: minimum'
  if 'maximum'in s:assert v<=s['maximum'],f'{path}: maximum'
  if 'exclusiveMinimum'in s:assert v>s['exclusiveMinimum'],f'{path}: exclusiveMinimum'
 if isinstance(v,list):
  if 'minItems'in s:assert len(v)>=s['minItems'],f'{path}: minItems'
  if 'maxItems'in s:assert len(v)<=s['maxItems'],f'{path}: maxItems'
  if 'items'in s:
   for i,x in enumerate(v):check(x,s['items'],f'{path}[{i}]')
 if isinstance(v,dict):
  for k in s.get('required',[]):assert k in v,f'{path}: missing {k}'
  props=s.get('properties',{})
  if s.get('additionalProperties') is False:assert not(set(v)-set(props)),f'{path}: additional {set(v)-set(props)}'
  for k,x in v.items():
   if k in props:check(x,props[k],f'{path}.{k}')
def validate(p,schema_path=None):
 p=Path(p);schema=Path(schema_path or Path(__file__).parent/'schemas/dflash2-training.schema.json');d=json.load(open(p));s=json.load(open(schema));check(d,s);unknown=[f'target.{k}' for k in ('modelHash','tokenizerHash') if d['target'][k] is None]+(['dataset.manifestHash'] if d['dataset']['manifestHash'] is None else [])+[f'training.{k}' for k,v in d['training'].items() if v is None];return {'valid':True,'status':d['status'],'unknownFields':unknown,'schemaId':s['$id']}
if __name__=='__main__':print('RESULT_JSON='+json.dumps(validate(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else None),separators=(',',':')))
