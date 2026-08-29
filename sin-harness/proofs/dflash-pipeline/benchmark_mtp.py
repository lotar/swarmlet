#!/usr/bin/env python3
"""Controlled Flash Next target/MTP benchmark client."""
import argparse,json,statistics,time,urllib.request
from pathlib import Path
PROMPTS=[
 'Solve carefully: A store marks an item down 20%, then raises the discounted price 25%. If the original price was 80, what is the final price? Explain briefly.',
 'Write a Python function that returns the longest strictly increasing contiguous run in a list. Include two examples.',
 'Return only minified JSON with keys city, country, confidence for the question: What country is Zagreb in?',
 'Explain in Croatian, in three short sentences, why deterministic rollback matters in speculative language-model decoding.',
]
ap=argparse.ArgumentParser();ap.add_argument('--url',default='http://127.0.0.1:8095');ap.add_argument('--out',required=True);ap.add_argument('--baseline');ap.add_argument('--allow-output-drift',action='store_true');ap.add_argument('--tokens',type=int,default=128);a=ap.parse_args();out=Path(a.out);out.mkdir(parents=True,exist_ok=True);rows=[]
for i,prompt in enumerate(PROMPTS):
 body={'prompt':prompt,'n_predict':a.tokens,'temperature':0,'top_k':1,'top_p':1.0,'seed':42,'cache_prompt':False,'ignore_eos':True,'n_probs':1}
 raw=json.dumps(body).encode();req=urllib.request.Request(a.url+'/completion',data=raw,headers={'content-type':'application/json'});t=time.perf_counter()
 with urllib.request.urlopen(req,timeout=1800) as r:data=json.load(r)
 wall=time.perf_counter()-t;row={'index':i,'prompt':prompt,'promptSha':__import__('hashlib').sha256(prompt.encode()).hexdigest(),'tokens':data.get('tokens'),'content':data.get('content'),'completionProbabilities':data.get('completion_probabilities'),'timings':data.get('timings',{}),'wallSeconds':wall};rows.append(row);(out/f'{i}.json').write_text(json.dumps(row,indent=2,sort_keys=True))
comparisons=[]
if a.baseline:
 base=json.loads(Path(a.baseline).read_text())['rows']
 for b,r in zip(base,rows):
  same_tokens=b['tokens']==r['tokens'];same_content=b['content']==r['content'];comparisons.append({'index':r['index'],'sameTokens':same_tokens,'sameContent':same_content})
  if not a.allow_output_drift:
   assert same_tokens,f'token mismatch prompt {r["index"]}'
   assert same_content,f'content mismatch prompt {r["index"]}'
summary={'rows':rows,'comparisons':comparisons,'medianDecodeTps':statistics.median(r['timings'].get('predicted_per_second',0) for r in rows),'medianWallSeconds':statistics.median(r['wallSeconds'] for r in rows)};(out/'summary.json').write_text(json.dumps(summary,indent=2,sort_keys=True));print('RESULT_JSON='+json.dumps({'medianDecodeTps':summary['medianDecodeTps'],'medianWallSeconds':summary['medianWallSeconds'],'prompts':len(rows)},separators=(',',':')))
