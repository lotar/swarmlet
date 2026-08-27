#!/usr/bin/env python3
"""Real-weight Qwen3.8 Flash Next true expert-sharding PoC.

Reads GGUF headers + layer-0 router, dequantizes only router-selected top-10
expert slices, distributes them 4/3/3 across three processes, and checks
numerical parity against a sequential monolithic routed-FFN reference.
No second model is loaded; attention/KV/shared expert are intentionally omitted.
"""
from __future__ import annotations
import concurrent.futures as cf, gc, json, math, os, signal, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path
# Keep the proof bounded and avoid competing with the user's live model.
os.environ.setdefault('OMP_NUM_THREADS','1'); os.environ.setdefault('OPENBLAS_NUM_THREADS','1'); os.environ.setdefault('VECLIB_MAXIMUM_THREADS','1')
import numpy as np

ROOT=Path(__file__).resolve().parents[2]
LLAMA=Path(os.environ.get('LLAMA_CPP','/Users/lotar/projects/local-llm/llama.cpp-rpc'))
sys.path.insert(0,str(LLAMA/'gguf-py'))
from gguf import GGUFReader
from gguf.quants import dequantize

SHARD=Path(os.environ.get('QWEN_SHARD','/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00005.gguf'))
WORKER=Path(__file__).with_name('worker.py'); PORTS=[9581,9582,9583]; NODE_IDS=['n1','n2','n3']

def rss_kb(pid):
    try:return int(subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True).strip() or 0)
    except:return 0
def swap_mb():
    import re
    s=subprocess.check_output(['sysctl','vm.swapusage'],text=True); m=re.search(r'used = ([\d.]+)M',s); return float(m.group(1)) if m else 0
def post(url,obj,timeout=120):
    raw=json.dumps(obj,separators=(',',':')).encode(); req=urllib.request.Request(url,data=raw,headers={'content-type':'application/json'})
    with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
def get(url,timeout=30):
    with urllib.request.urlopen(url,timeout=timeout) as r:return json.load(r)
def free_port(p):
    s=socket.socket();
    try:s.bind(('127.0.0.1',p)); return True
    except OSError:return False
    finally:s.close()
def softmax_top10(X,R):
    logits=X@R.T; idx=np.argsort(-logits,axis=1,kind='stable')[:,:10]
    vals=np.take_along_axis(logits,idx,axis=1); vals-=vals.max(axis=1,keepdims=True)
    w=np.exp(vals,dtype=np.float32); w/=w.sum(axis=1,keepdims=True)
    return idx,w
def ffn(X,gate,up,down):
    g=X@gate.T; u=X@up.T; h=(g/(1+np.exp(-np.clip(g,-30,30),dtype=np.float32)))*u
    return h@down.T

def main():
    if not SHARD.exists(): raise SystemExit(f'missing {SHARD}')
    for p in PORTS:
        if not free_port(p): raise SystemExit(f'safety: port {p} occupied')
    baseline_rss=rss_kb(os.getpid()); baseline_swap=swap_mb(); peak_delta=0
    reader=GGUFReader(str(SHARD),'r'); T={t.name:t for t in reader.tensors}
    names=['blk.0.ffn_gate_exps.weight','blk.0.ffn_up_exps.weight','blk.0.ffn_down_exps.weight']
    router=np.asarray(T['blk.0.ffn_gate_inp.weight'].data,dtype=np.float32)
    rng=np.random.default_rng(380); x=rng.standard_normal(2560,dtype=np.float32); x/=np.sqrt(np.mean(x*x,dtype=np.float32))
    X=x[None,:]; top,w=softmax_top10(X,router); selected=[int(i) for i in top[0]]
    placement={NODE_IDS[i]:selected[i::3] for i in range(3)}
    owner={eid:n for n,ids in placement.items() for eid in ids}
    print('[qwen-poc] selected top10',selected,'placement',placement,flush=True)

    # Monolithic reference, streamed one real expert at a time: peak ~20MB arrays.
    reference=np.zeros((1,2560),dtype=np.float32)
    for rank,eid in sorted(enumerate(selected),key=lambda z:z[1]):
        gate=dequantize(T[names[0]].data[eid],T[names[0]].tensor_type).astype(np.float32,copy=False)
        up=dequantize(T[names[1]].data[eid],T[names[1]].tensor_type).astype(np.float32,copy=False)
        down=dequantize(T[names[2]].data[eid],T[names[2]].tensor_type).astype(np.float32,copy=False)
        reference+=ffn(X,gate,up,down)*w[0,rank]
        peak_delta=max(peak_delta,rss_kb(os.getpid())-baseline_rss)
        del gate,up,down; gc.collect()

    procs={}
    env=os.environ.copy(); env['PYTHONPATH']=str(LLAMA/'gguf-py')
    env.update({'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','VECLIB_MAXIMUM_THREADS':'1'})
    def start(node):
        i=NODE_IDS.index(node); cmd=[sys.executable,str(WORKER),'--id',node,'--port',str(PORTS[i]),'--shard',str(SHARD),'--experts',','.join(map(str,placement[node]))]
        p=subprocess.Popen(cmd,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True); procs[node]=p
        for _ in range(300):
            if p.poll() is not None: raise RuntimeError(f'{node} died: {p.stderr.read()}')
            try:get(f'http://127.0.0.1:{PORTS[i]}/health'); return
            except:time.sleep(.02)
        raise RuntimeError(f'{node} startup timeout')
    def stop(node):
        p=procs.pop(node,None)
        if p and p.poll() is None:
            p.kill(); p.wait(timeout=10)
    def distributed(Xb,delay=0):
        idx,weights=softmax_top10(Xb,router)
        if any(set(map(int,row))!=set(selected) for row in idx): raise RuntimeError('batch changed selected expert set')
        groups={n:[] for n in NODE_IDS}
        for eid in selected:
            ranks=[int(np.where(idx[b]==eid)[0][0]) for b in range(len(Xb))]
            groups[owner[eid]].append({'expertId':eid,'weights':[float(weights[b,ranks[b]]) for b in range(len(Xb))]})
        def call(n):
            i=NODE_IDS.index(n); return post(f'http://127.0.0.1:{PORTS[i]}/execute',{'activations':Xb.tolist(),'assignments':groups[n],'delayMs':delay})
        t=time.perf_counter()
        with cf.ThreadPoolExecutor(max_workers=3) as ex: responses=list(ex.map(call,NODE_IDS))
        pieces=[]
        for r in responses: pieces.extend(r['pieces'])
        out=np.zeros((len(Xb),2560),dtype=np.float32)
        for piece in sorted(pieces,key=lambda z:int(z['expertId'])): out+=np.asarray(piece['weighted'],dtype=np.float32)
        return out,(time.perf_counter()-t)*1000

    try:
        for n in NODE_IDS:start(n)
        manifests=[get(f'http://127.0.0.1:{PORTS[i]}/manifest') for i in range(3)]
        assert sorted(e for m in manifests for e in m['expertIds'])==sorted(selected)
        assert sum(m['residentBytes'] for m in manifests)==len(selected)*3*640*2560*4
        # Negative capability: n1 must reject an expert owned by n2.
        foreign=placement['n2'][0]
        try:post(f'http://127.0.0.1:{PORTS[0]}/execute',{'activations':X.tolist(),'assignments':[{'expertId':foreign,'weights':[1.0]}]}); raise AssertionError('foreign accepted')
        except urllib.error.HTTPError as e: assert e.code==409

        actual,layer_lan=distributed(X,0); max_abs=float(np.max(np.abs(actual-reference))); denom=np.maximum(np.abs(reference),1e-6)
        max_rel=float(np.max(np.abs(actual-reference)/denom)); assert max_abs<2e-5 and max_rel<2e-4,(max_abs,max_rel)
        results={}
        for delay in [0,10]:
            for B in [1,4,16]:
                scales=np.linspace(.85,1.15,B,dtype=np.float32)[:,None]; Xb=X*scales
                samples=[]
                for _ in range(3): _,ms=distributed(Xb,delay); samples.append(ms)
                med=float(np.median(samples)); results[f'd{delay}_b{B}']={'medianMs':med,'throughput':B*1000/med}
                print(f'[qwen-poc bench] delay={delay}ms batch={B} median={med:.1f}ms throughput={B*1000/med:.2f}tok/s',flush=True)

        # Owner loss must fail; restart exact owner and restore parity.
        stop('n2'); failed=False
        try:distributed(X,0)
        except Exception:failed=True
        assert failed,'owner loss produced output'
        start('n2'); retry,_=distributed(X,0); assert float(np.max(np.abs(retry-reference)))<2e-5

        proof_rss=sum(rss_kb(p.pid) for p in procs.values())+rss_kb(os.getpid())-baseline_rss
        peak_delta=max(peak_delta,proof_rss); swap_delta=max(0,swap_mb()-baseline_swap)
        assert proof_rss<900*1024,(proof_rss/1024); assert swap_delta<512,swap_delta
        eu_layer=results['d10_b1']['medianMs']; summary={
          'model':'Qwen3.8-Flash-Next-UD-Q4_K_XL','layer':0,'expertsTotal':512,'topK':10,
          'selectedExperts':selected,'placement':placement,'residentExpertBytes':sum(m['residentBytes'] for m in manifests),
          'parityMaxAbs':max_abs,'parityMaxRel':max_rel,'benchmarks':results,
          'projected48LayerEuMsPerToken':eu_layer*48,'projected48LayerEuTokPerSec':1000/(eu_layer*48),
          'proofIncrementalRssMiB':proof_rss/1024,'peakObservedDeltaMiB':peak_delta/1024,'swapDeltaMiB':swap_delta,
          'churnFailClosed':True,'restartParity':True}
        print('RESULT_JSON='+json.dumps(summary,separators=(',',':')),flush=True)
    finally:
        for n in list(procs):stop(n)

if __name__=='__main__':main()
