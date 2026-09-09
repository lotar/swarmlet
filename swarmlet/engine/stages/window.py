#!/usr/bin/env python3
"""Run a native proof inside existing managed-baseline stop/restore + global rig lock."""
import argparse, fcntl, importlib.util, pathlib, signal, subprocess, sys
HERE=pathlib.Path(__file__).resolve().parent
loader=importlib.util.spec_from_file_location('placement',HERE.parents[1]/'e2e/placement-qualify.py');placement=importlib.util.module_from_spec(loader);loader.loader.exec_module(placement)
class NativeWindow(placement.PlacementRunner):
 def arm(self,case):
  command=self.args.child
  process=subprocess.Popen(command)
  try:
   rc=process.wait()
   self.results[case['id']]={'complete':True,'status':'pass' if rc==0 else 'fail','exit_code':rc,'command':command};self.save()
   if rc:raise RuntimeError('native verifier failed with exit '+str(rc))
  finally:
   if process.poll() is None:
    process.terminate()
    try:process.wait(timeout=60)
    except subprocess.TimeoutExpired:process.kill();process.wait()
def main():
 p=argparse.ArgumentParser();p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--control-url',default='http://127.0.0.1:47900');p.add_argument('--config',type=pathlib.Path,default=pathlib.Path.home()/'.swarmlet/control/control.json');p.add_argument('--deployment-id',default='dep-65bedf5278d1');p.add_argument('--nodes',nargs=3,default=placement.matrix.NODES);p.add_argument('--request-timeout',type=int,default=300);p.add_argument('child',nargs=argparse.REMAINDER);a=p.parse_args()
 if a.child and a.child[0]=='--':a.child=a.child[1:]
 if not a.child:p.error('child command required')
 placement.guard();a.out=a.out.resolve();a.out.mkdir(parents=True,exist_ok=True)
 with (pathlib.Path.home()/'.swarmlet/mesh-matrix.lock').open('w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  runner=NativeWindow(a,[{'id':'native-proof','specs':[]}])
  def stop(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
  signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
  runner.run()
  if runner.results.get('native-proof',{}).get('status')!='pass':raise RuntimeError('native proof is not passing; use a fresh output directory')
if __name__=='__main__':main()
