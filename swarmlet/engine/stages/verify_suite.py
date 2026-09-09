#!/usr/bin/env python3
"""Run local and physical proofs sequentially inside one owned rig window."""
import argparse, os, pathlib, signal, subprocess, sys
HERE=pathlib.Path(__file__).resolve().parent

def main():
 p=argparse.ArgumentParser()
 for name in ['binary','model','sha','two','three','local-out','remote-out','remote-root']:p.add_argument('--'+name,required=True)
 p.add_argument('--ctx',type=int,default=1024);p.add_argument('--tokens',type=int,default=8);a=p.parse_args()
 if os.environ.get('SWARMLET_IDLE_WINDOW')!='1':raise RuntimeError('idle-window guard required')
 common=[]
 for name in ['binary','model','sha','two','three','ctx','tokens']:common+=['--'+name,str(getattr(a,name))]
 child=None
 def stop(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 try:
  for script,out,extra in [('verify.py',a.local_out,[]),('verify_remote.py',a.remote_out,['--remote-root',a.remote_root])]:
   child=subprocess.Popen([sys.executable,str(HERE/script),*common,'--out',out,*extra]);rc=child.wait()
   if rc:raise RuntimeError(script+' failed with exit '+str(rc))
 finally:
  if child and child.poll() is None:
   child.terminate()
   try:child.wait(timeout=45)
   except subprocess.TimeoutExpired:child.kill();child.wait()
if __name__=='__main__':main()
