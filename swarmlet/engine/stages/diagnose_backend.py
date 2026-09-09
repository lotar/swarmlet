#!/usr/bin/env python3
"""Guarded diagnosis: compare full CUDA and CUDA shard against a saved Metal reference."""
import argparse, importlib.util, json, os, pathlib, signal
HERE=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('remote',HERE/'verify_remote.py');remote=importlib.util.module_from_spec(s);s.loader.exec_module(remote)
v=remote.local

def metrics(a,b):
 a=v.np.asarray(a,dtype=v.np.float32);b=v.np.asarray(b,dtype=v.np.float32)
 assert a.shape==b.shape
 return {'max_abs':float(v.np.max(v.np.abs(a-b))),'values':a.size,'outside_tolerance':int(v.np.count_nonzero(~v.np.isclose(a,b,atol=1e-3,rtol=1e-4)))}

def main(a):
 if os.environ.get('SWARMLET_IDLE_WINDOW')!='1':raise RuntimeError('idle-window guard required')
 def stop(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 a.out.mkdir(parents=True,exist_ok=False);evidence={'diagnostic':True,'qualified':False,'results':[]}
 def save():(a.out/'result.json').write_text(json.dumps(evidence,indent=2))
 try:
  metal=v.np.load(a.reference/'baseline.npz');cuda=[]
  expected=[int(v.np.argmax(metal[f'logits_3_{step}'])) for step in range(a.tokens+1)]
  with remote.remote_launch(a,a.l1,a.remote_model,a.sha,'cuda-full') as full:
   evidence['cuda_full_identity']=full.status();prompt=full.call('tokenize',text='The red box has three blue marbles. How many blue marbles are in the box?')['tokens'];position=0
   for step in range(a.tokens+1):
    r=full.call('eval',session='proof',position=position,tokens=prompt if step==0 else [expected[step-1]],capture_layer=2);cuda.append(r);position=r['position']
    evidence['results'].append({'test':'cuda-full-vs-metal','step':step,'boundary':metrics(r['boundary'],metal[f'boundary_3_{step}']),'logits':metrics(r['logits'],metal[f'logits_3_{step}']),'cuda_token':r['token'],'metal_token':expected[step]});save()
  v.np.savez_compressed(a.out/'cuda-full.npz',**{f'{field}_{i}':v.np.asarray(r[field],dtype=v.np.float32) for i,r in enumerate(cuda) for field in ['boundary','logits']})
  with remote.remote_launch(a,a.l1,a.remote_shard,a.shard_sha,'cuda-shard') as shard:
   evidence['cuda_shard_identity']=shard.status();position=0
   for step in range(a.tokens+1):
    r=shard.call('eval',session='proof',position=position,tokens=prompt if step==0 else [expected[step-1]]);position=r['position']
    v.np.save(a.out/f'cuda-shard-{step}.npy',v.np.asarray(r['activations'],dtype=v.np.float32))
    evidence['results'].append({'test':'cuda-shard-vs-cuda-full','step':step,'boundary':metrics(r['activations'],cuda[step]['boundary'])});save()
  evidence['complete']=True;save();print(json.dumps(evidence))
 except BaseException as ex:evidence['error']=str(ex);save();raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--reference',type=pathlib.Path,required=True);p.add_argument('--l1',default='lotar@192.168.1.243');p.add_argument('--remote-root',default='/home/lotar/.swarmlet/stage-lab/c1ba1477');p.add_argument('--remote-model',default='/home/lotar/swarmlet/models/Qwen3.5-2B-Q8_0.gguf');p.add_argument('--remote-shard',default='/home/lotar/swarmlet/models/stages/stage-0-3.gguf');p.add_argument('--sha',default='1b04acba824817554f4ce23639bc8495ff70453b8fcb047900c731521021f2c1');p.add_argument('--shard-sha',default='c57aea57890507cc8baf08691349ad6be21052fa1611f56974f41b2946c01e46');p.add_argument('--ctx',type=int,default=1024);p.add_argument('--tokens',type=int,default=8);main(p.parse_args())
