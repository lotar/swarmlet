#!/usr/bin/env python3
"""Owned remote process supervisor: stdin EOF/signals always retire its own process group."""
import json, os, pathlib, resource, select, signal, subprocess, sys, threading, time

def main():
 binary,model,digest,directory,port,gpu,ctx=sys.argv[1:]
 root=pathlib.Path(directory);root.mkdir(parents=True,mode=0o700,exist_ok=False)
 record=root/'ownership.json';log=(root/'worker.log').open('w')
 sampling_done=threading.Event();sampler=None
 child=None;state={'argv':[binary,model,digest,directory,port,gpu,ctx],'started_at':time.time(),'supervisor_pid':os.getpid(),'supervisor_start_ticks':pathlib.Path('/proc/self/stat').read_text().split()[21]}
 def stop(signum,frame):raise KeyboardInterrupt('signal '+str(signum))
 for signum in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(signum,stop)
 try:
  child=subprocess.Popen(state['argv'],stdout=log,stderr=log,start_new_session=True)
  state['pid']=child.pid;state['peak_sampled_gpu_mib']=0;state['gpu_sample_interval_seconds']=.25;state['gpu_sample_error']=None
  def sample_gpu():
   while not sampling_done.is_set():
    try:
     query=subprocess.run(['nvidia-smi','--query-compute-apps=pid,used_gpu_memory','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=2)
     for line in query.stdout.splitlines():
      pid,used=line.split(',')
      if int(pid.strip())==child.pid:state['peak_sampled_gpu_mib']=max(state['peak_sampled_gpu_mib'],int(used.strip()))
    except (OSError,ValueError,subprocess.TimeoutExpired) as ex:state['gpu_sample_error']=str(ex)
    sampling_done.wait(.25)
  sampler=threading.Thread(target=sample_gpu,daemon=True);sampler.start()
  state['start_ticks']=pathlib.Path(f'/proc/{child.pid}/stat').read_text().split()[21];record.write_text(json.dumps(state));print(json.dumps(state),flush=True)
  while child.poll() is None:
   ready,_,_=select.select([sys.stdin],[],[],.25)
   if ready and not os.read(sys.stdin.fileno(),1):break
 finally:
  for signum in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(signum,signal.SIG_IGN)
  if child and child.poll() is None:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
  sampling_done.set()
  if sampler:sampler.join(timeout=3)
  state.update(stopped_at=time.time(),returncode=child.returncode if child else None,max_rss_kib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
  record.write_text(json.dumps(state));log.close()
if __name__=='__main__':main()
