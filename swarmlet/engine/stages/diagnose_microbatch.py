#!/usr/bin/env python3
"""Guarded single-token prefill comparison to isolate backend batch arithmetic."""
import argparse, importlib.util, json, os, pathlib, signal
HERE=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('diagnosis',HERE/'diagnose_backend.py');d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
r=d.remote;v=d.v

def main(a):
 if os.environ.get('SWARMLET_IDLE_WINDOW')!='1':raise RuntimeError('idle-window guard required')
 def stop(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 a.out.mkdir(parents=True,exist_ok=False);evidence={'diagnostic':True,'qualified':False,'results':[]};reference=[]
 def save():(a.out/'result.json').write_text(json.dumps(evidence,indent=2))
 try:
  with v.launch(a.binary,a.model,a.sha,a.out/'metal-full',999,a.ctx) as metal:
   evidence['metal_identity']=metal.status();prompt=metal.call('tokenize',text='The red box has three blue marbles. How many blue marbles are in the box?')['tokens'];prompt=prompt[:a.prompt_limit] if a.prompt_limit else prompt;position=0
   for token in prompt:
    value=metal.call('eval',session='proof',position=position,tokens=[token],capture_layer=a.capture_layer);reference.append(value);position=value['position']
   for _ in range(a.tokens):
    value=metal.call('eval',session='proof',position=position,tokens=[value['token']],capture_layer=a.capture_layer);reference.append(value);position=value['position']
  v.np.savez_compressed(a.out/'metal-full.npz',**{f'{field}_{i}':v.np.asarray(x[field],dtype=v.np.float32) for i,x in enumerate(reference) for field in ['boundary','logits']})
  with r.remote_launch(a,a.l1,a.remote_model,a.sha,'cuda-full') as cuda:
   evidence['cuda_identity']=cuda.status();position=0
   for step,ref in enumerate(reference):
    token=prompt[step] if step<len(prompt) else reference[step-1]['token']
    value=cuda.call('eval',session='proof',position=position,tokens=[token],capture_layer=a.capture_layer);position=value['position']
    evidence['results'].append({'phase':'prefill' if step<len(prompt) else 'decode','step':step,'boundary':d.metrics(value['boundary'],ref['boundary']),'logits':d.metrics(value['logits'],ref['logits']),'cuda_token':value['token'],'metal_token':ref['token']});save()
    v.np.savez_compressed(a.out/f'cuda-{step}.npz',boundary=v.np.asarray(value['boundary'],dtype=v.np.float32),logits=v.np.asarray(value['logits'],dtype=v.np.float32))
    if a.stop_on_mismatch and any(evidence['results'][-1][field]['outside_tolerance'] for field in ['boundary','logits']):raise AssertionError('fixed precision gate failed at step '+str(step))
  evidence['complete']=True;save();print(json.dumps(evidence))
 except BaseException as ex:evidence['error']=str(ex);save();raise
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--binary',type=pathlib.Path,required=True);p.add_argument('--model',type=pathlib.Path,required=True);p.add_argument('--l1',default='lotar@192.168.1.243');p.add_argument('--remote-root',default='/home/lotar/.swarmlet/stage-lab/6d74bab0');p.add_argument('--remote-model',default='/home/lotar/swarmlet/models/Qwen3.5-2B-Q8_0.gguf');p.add_argument('--sha',default='1b04acba824817554f4ce23639bc8495ff70453b8fcb047900c731521021f2c1');p.add_argument('--ctx',type=int,default=1024);p.add_argument('--tokens',type=int,default=8);p.add_argument('--capture-layer',type=int,default=2);p.add_argument('--prompt-limit',type=int,default=0);p.add_argument('--stop-on-mismatch',action='store_true');main(p.parse_args())
