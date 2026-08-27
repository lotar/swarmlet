#!/usr/bin/env python3
"""Eight-stage speculative pipeline feasibility model.

Separates per-stream latency from saturated aggregate throughput. No model load.
"""
from dataclasses import dataclass,asdict
import json
@dataclass(frozen=True)
class Config:
 stages:int=8;streams:int=8;acceptance:float=4.8;draft_ms:float=10;stage_ms:float=8;one_way_ms:float=.25
@dataclass(frozen=True)
class Result:
 block_latency_ms:float;stage_interval_ms:float;latency_tps:float;aggregate_capacity_tps:float;per_stream_capacity_tps:float;per_stream_tps:float

def evaluate(c:Config)->Result:
 block=c.draft_ms+c.stages*c.stage_ms+(c.stages-1)*c.one_way_ms
 interval=c.stage_ms+c.one_way_ms
 latency=c.acceptance*1000/block
 aggregate=c.acceptance*1000/interval
 percap=aggregate/c.streams
 return Result(block,interval,latency,aggregate,percap,min(latency,percap))
def max_stage_ms(acceptance,draft_ms,one_way_ms,target=50):
 lo,hi=0.,30.
 for _ in range(80):
  mid=(lo+hi)/2
  if evaluate(Config(acceptance=acceptance,draft_ms=draft_ms,stage_ms=mid,one_way_ms=one_way_ms)).per_stream_tps>=target:lo=mid
  else:hi=mid
 return lo

def main():
 scenarios=[
  ('rack-best',Config(stage_ms=8,one_way_ms=.25)),
  ('rack-limit',Config(stage_ms=10.5,one_way_ms=.25)),
  ('metro-1ms',Config(stage_ms=8,one_way_ms=1)),
  ('eu-8ms',Config(stage_ms=8,one_way_ms=8)),
  ('eu-10x-80ms',Config(stage_ms=8,one_way_ms=80)),
 ]
 out={}
 for name,c in scenarios:
  r=evaluate(c);out[name]={**asdict(c),**asdict(r)}
  print(f'{name:14s} block={r.block_latency_ms:7.2f}ms stream={r.per_stream_tps:6.2f}tok/s aggregateCap={r.aggregate_capacity_tps:7.1f}tok/s')
 # Hard design gates.
 assert out['rack-best']['per_stream_tps']>=50 and out['rack-best']['aggregate_capacity_tps']>=400
 assert out['rack-limit']['per_stream_tps']>=49
 assert out['eu-8ms']['per_stream_tps']<50
 assert out['eu-10x-80ms']['per_stream_tps']<10
 gates={}
 for A in [4.10,4.80,5.46]:
  for L in [.25,.5,1,8,80]:gates[f'A{A}_L{L}']=max_stage_ms(A,10,L)
 print('stage gates (ms):',json.dumps(gates,sort_keys=True))
 # Memory feasibility model from local GGUF inventory.
 target=103.688;ple=26.85;gpu_target=(target-ple)/8;state=1.06;headroom=16-gpu_target-state
 memory={'targetGiB':target,'pleSystemRamGiB':ple,'gpuTargetGiBPerStage':gpu_target,'rollbackKvGiBPerStage':state,'remainingGiBPerStage':headroom}
 assert headroom>4
 summary={'scenarios':out,'stageGatesMs':gates,'memory':memory,'meaning':'one 8-node shared model; 8 concurrent streams, not 8 independent replicas'}
 print('RESULT_JSON='+json.dumps(summary,separators=(',',':')))
if __name__=='__main__':main()
