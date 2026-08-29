#!/usr/bin/env python3
"""Deterministic discrete-event eight-stage speculative scheduler simulation."""
import heapq,json,math,random,statistics
def pct(xs,p):
 s=sorted(xs);return s[min(len(s)-1,max(0,math.ceil(p*len(s))-1))]
def simulate(name,stage_ms,link_ms,draft_ms=10,streams=8,blocks=200,acceptance=4.8,cv=.08,seed=42):
 rng=random.Random(seed);free=[0.0]*8;busy=[0.0]*8;heap=[];done=[[] for _ in range(streams)];tokens=[0.0]*streams;queues=[]
 for sid in range(streams):heapq.heappush(heap,(draft_ms,sid,0))
 while heap:
  ready,sid,b=heapq.heappop(heap);arrival=ready
  for st in range(8):
   start=max(arrival,free[st]);queues.append(start-arrival);service=max(.05,rng.gauss(stage_ms,stage_ms*cv));busy[st]+=service;finish=start+service;free[st]=finish;arrival=finish+(link_ms if st<7 else 0)
  accepted=max(1.0,min(8.0,rng.gauss(acceptance,.45)));tokens[sid]+=accepted;done[sid].append(arrival)
  if b+1<blocks:heapq.heappush(heap,(arrival+max(.1,rng.gauss(draft_ms,draft_ms*.05)),sid,b+1))
 total=max(x[-1] for x in done);per=[];inter=[]
 for sid in range(streams):
  per.append(tokens[sid]/(done[sid][-1]/1000));inter.extend([b-a for a,b in zip(done[sid],done[sid][1:])])
 return {'name':name,'stageMs':stage_ms,'linkMs':link_ms,'draftMs':draft_ms,'streams':streams,'blocksPerStream':blocks,'perStreamMedianTps':statistics.median(per),'perStreamP95FloorTps':pct(per,.05),'perStreamMinTps':min(per),'aggregateTps':sum(tokens)/(total/1000),'interBlockP50Ms':statistics.median(inter),'interBlockP95Ms':pct(inter,.95),'interBlockP99Ms':pct(inter,.99),'queueP50Ms':statistics.median(queues),'queueP95Ms':pct(queues,.95),'queueP99Ms':pct(queues,.99),'stageUtilization':[x/total for x in busy]}
def selftest():
 scenarios=[simulate('rack-best',7,.25),simulate('rack-limit',9,.25),simulate('metro-1ms',7,1),simulate('eu-8ms',7,8),simulate('10x-eu',7,80)]
 for r in scenarios:print(f"{r['name']:12} stream={r['perStreamMedianTps']:.2f} agg={r['aggregateTps']:.1f} p99block={r['interBlockP99Ms']:.1f}ms queuep99={r['queueP99Ms']:.1f}ms")
 assert scenarios[0]['perStreamMedianTps']>45 and scenarios[3]['perStreamMedianTps']<40 and scenarios[4]['perStreamMedianTps']<10
 assert all(all(k in r for k in ('queueP50Ms','queueP95Ms','queueP99Ms','interBlockP50Ms','interBlockP95Ms','interBlockP99Ms')) for r in scenarios)
 print('RESULT_JSON='+json.dumps({'scenarios':scenarios},separators=(',',':')));return scenarios
if __name__=='__main__':selftest()
