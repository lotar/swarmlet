#!/usr/bin/env python3
# Copied from the session scratchpad operator toolkit (2026-09-04): the client every ring report measured with.
"""Speculative-aware client: N prompts, C concurrent streams, greedy, no n_probs (n_probs disables speculation in llama-server).
Reports per-stream tok/s, draft proposed/accepted, tokens per decode step, and (optionally) content parity vs a baseline summary."""
import argparse, json, time, urllib.request, statistics, os, concurrent.futures as cf
PROMPTS=['Solve: 17*23. Explain briefly.','Write a Python binary search function and one test.','Return minified JSON: country of Zagreb and confidence.',
 'Explain speculative decoding in Croatian in four sentences.','List three prime numbers above 100 and why they are prime.','Describe a Wi-Fi power-save bug in two sentences.',
 'Write a haiku about latency.','Give the SI unit of inductance and one use.','Write a bash script that renames all .txt files in a directory to .md and prints each rename.',
 'Summarize the plot of Hamlet in five sentences.','Implement a Python function that checks whether a string is a palindrome, ignoring punctuation and case, with three tests.',
 'What are the tradeoffs between TCP and UDP for real-time video? Answer in one paragraph.']
ap=argparse.ArgumentParser(); ap.add_argument('--url',required=True); ap.add_argument('--out',required=True); ap.add_argument('--concurrency',type=int,default=1)
ap.add_argument('--prompts',type=int,default=8); ap.add_argument('--tokens',type=int,default=96); ap.add_argument('--baseline'); ap.add_argument('--label',default='run'); a=ap.parse_args()
os.makedirs(a.out,exist_ok=True)
def one(i):
    body={'prompt':PROMPTS[i%len(PROMPTS)],'n_predict':a.tokens,'temperature':0,'top_k':1,'top_p':1.0,'seed':42,'cache_prompt':False,'ignore_eos':True}
    req=urllib.request.Request(a.url+'/completion',data=json.dumps(body).encode(),headers={'content-type':'application/json'}); t0=time.perf_counter()
    with urllib.request.urlopen(req,timeout=900) as r: d=json.load(r)
    t=d.get('timings',{}); return {'index':i,'content':d.get('content'),'wall_s':time.perf_counter()-t0,'predicted_n':t.get('predicted_n'),'tps':t.get('predicted_per_second'),
        'draft_n':t.get('draft_n',0) or 0,'draft_acc':t.get('draft_n_accepted',0) or 0,'prompt_ms':t.get('prompt_ms')}
t0=time.perf_counter(); rows=[]
with cf.ThreadPoolExecutor(max_workers=a.concurrency) as ex: rows=list(ex.map(one,range(a.prompts)))
wall=time.perf_counter()-t0; pn=sum(r['predicted_n'] or 0 for r in rows); dn=sum(r['draft_n'] for r in rows); da=sum(r['draft_acc'] for r in rows)
steps=max(1,pn-da); tps=[r['tps'] for r in rows if r['tps']]; par=''
if a.baseline and os.path.exists(a.baseline):
    b={r['index']:r['content'] for r in json.load(open(a.baseline))['rows']}; same=sum(1 for r in rows if b.get(r['index'])==r['content'])
    def pref(x,y):
        n=0
        for c1,c2 in zip(x or '',y or ''):
            if c1!=c2: break
            n+=1
        return n/max(1,len(y or ''))
    fr=[pref(r['content'],b.get(r['index'])) for r in rows if r['index'] in b]; par=f' | identical to baseline {same}/{len(rows)}, common prefix median {statistics.median(fr)*100:.0f}% min {min(fr)*100:.0f}%'
res={'label':a.label,'concurrency':a.concurrency,'prompts':a.prompts,'tokens':a.tokens,'wallSeconds':wall,'aggregateTps':pn/wall,'perStreamMedianTps':statistics.median(tps) if tps else 0,
     'perStreamMinTps':min(tps) if tps else 0,'draftProposed':dn,'draftAccepted':da,'acceptRate':(da/dn if dn else 0),'tokensPerStep':pn/steps,'rows':rows}
json.dump(res,open(f'{a.out}/summary.json','w'),indent=1)
print(f"RESULT {a.label} c{a.concurrency}: per-stream median {res['perStreamMedianTps']:.2f} tok/s (min {res['perStreamMinTps']:.2f}) aggregate {res['aggregateTps']:.2f} | draft {dn}/{da} acc {res['acceptRate']*100:.0f}% tokens/step {res['tokensPerStep']:.2f}{par} | wall {wall:.1f}s")
