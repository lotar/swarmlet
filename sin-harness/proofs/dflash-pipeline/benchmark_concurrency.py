#!/usr/bin/env python3
import argparse,concurrent.futures as cf,hashlib,json,statistics,time,urllib.request
from pathlib import Path
PROMPTS=[
'Solve: 17*23. Explain briefly.','Write a Python binary search function and one test.','Return minified JSON: country of Zagreb and confidence.','Explain speculative decoding in Croatian in four sentences.','Give three causes of cache thrashing in MoE inference.','Prove the sum of the first n odd integers equals n squared.','Write SQL selecting the latest order per customer.','Explain why European WAN latency hurts serial transformer layers.'
]
def pct(x,p):s=sorted(x);return s[min(len(s)-1,max(0,int((len(s)-1)*p)))]
ap=argparse.ArgumentParser();ap.add_argument('--url',default='http://127.0.0.1:8095');ap.add_argument('--out',required=True);ap.add_argument('--concurrency',type=int,required=True);ap.add_argument('--tokens',type=int,default=128);ap.add_argument('--baseline');a=ap.parse_args();out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
def one(i):
 body={'prompt':PROMPTS[i],'n_predict':a.tokens,'temperature':0,'top_k':1,'top_p':1.0,'seed':42+i,'cache_prompt':False,'ignore_eos':True,'n_probs':1};raw=json.dumps(body).encode();req=urllib.request.Request(a.url+'/completion',data=raw,headers={'content-type':'application/json'});t=time.perf_counter()
 with urllib.request.urlopen(req,timeout=1800) as r:d=json.load(r)
 return {'index':i,'promptSha':hashlib.sha256(PROMPTS[i].encode()).hexdigest(),'content':d.get('content'),'ids':[x['id'] for x in d.get('completion_probabilities',[])],'timings':d.get('timings',{}),'wallSeconds':time.perf_counter()-t}
start=time.perf_counter()
with cf.ThreadPoolExecutor(max_workers=a.concurrency) as ex:rows=list(ex.map(one,range(a.concurrency)))
wall=time.perf_counter()-start;tps=[r['timings']['predicted_per_second'] for r in rows];n=sum(r['timings']['predicted_n'] for r in rows);parity=None
if a.baseline:
 base={r['index']:r for r in json.load(open(a.baseline))['rows']};parity={'sameIds':sum(base[r['index']]['ids']==r['ids'] for r in rows),'sameContent':sum(base[r['index']]['content']==r['content'] for r in rows),'total':len(rows)}
result={'concurrency':a.concurrency,'rows':rows,'wallSeconds':wall,'aggregateTps':n/wall,'perStreamMedianTps':statistics.median(tps),'perStreamP95FloorTps':pct(tps,.05),'perStreamMinTps':min(tps),'parity':parity};(out/'summary.json').write_text(json.dumps(result,indent=2,sort_keys=True));print('RESULT_JSON='+json.dumps({k:v for k,v in result.items() if k!='rows'},separators=(',',':')))
