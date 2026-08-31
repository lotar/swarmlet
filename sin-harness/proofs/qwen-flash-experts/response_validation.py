#!/usr/bin/env python3
"""Fail-closed validation for untrusted Qwen expert-owner responses."""
import numpy as np
def validate_json_response(response,node,epoch,expected_experts,shape):
 if not isinstance(response,dict) or response.get('nodeId')!=node or response.get('placementEpoch')!=epoch or not isinstance(response.get('pieces'),list):raise ValueError(f'{node} response identity mismatch')
 pieces=response['pieces'];ids=[]
 for piece in pieces:
  if not isinstance(piece,dict):raise ValueError(f'{node} response expert set mismatch')
  eid=piece.get('expertId')
  if isinstance(eid,bool) or not isinstance(eid,int):raise ValueError(f'{node} invalid expert identifier')
  ids.append(eid)
 if len(set(ids))!=len(ids) or sorted(ids)!=sorted(map(int,expected_experts)):raise ValueError(f'{node} response expert set mismatch')
 for piece in pieces:
  weighted=np.asarray(piece.get('weighted'),dtype=np.float32)
  if weighted.shape!=tuple(shape) or not np.isfinite(weighted).all():raise ValueError(f'{node} invalid weighted output')
 return pieces
def validate_binary_partial(partial,shape,node='worker'):
 partial=np.asarray(partial,dtype=np.float32)
 if partial.shape!=tuple(shape) or not np.isfinite(partial).all():raise ValueError(f'{node} invalid binary partial')
 return partial
def selftest():
 epoch='a'*64;good={'nodeId':'n1','placementEpoch':epoch,'pieces':[{'expertId':1,'weighted':[[0.0]*2560]}]};validate_json_response(good,'n1',epoch,[1],(1,2560));validate_binary_partial(np.zeros((1,2560),np.float32),(1,2560))
 bad=[]
 for response in ({**good,'nodeId':'n2'},{**good,'pieces':[]},{**good,'pieces':good['pieces']*2},{**good,'pieces':[{'expertId':1,'weighted':[[float('nan')]*2560]}]},{**good,'pieces':[{'expertId':'1','weighted':[[0.0]*2560]}]}):
  try:validate_json_response(response,'n1',epoch,[1],(1,2560))
  except ValueError:bad.append(True)
 try:validate_binary_partial(np.zeros((1,2560),np.float32),(16,2560))
 except ValueError:bad.append(True)
 assert len(bad)==6;return {'verified':True,'invalidCasesRejected':len(bad)}
if __name__=='__main__':
 import json;print('RESULT_JSON='+json.dumps(selftest(),separators=(',',':')))
