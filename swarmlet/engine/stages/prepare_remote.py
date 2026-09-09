#!/usr/bin/env python3
"""File-only frozen source/shard preparation and two-job CUDA compile; never launches a model."""
import argparse, hashlib, pathlib, shlex, subprocess, tarfile
HERE=pathlib.Path(__file__).resolve().parent

def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  while b:=f.read(8<<20):h.update(b)
 return h.hexdigest()
def ssh(host,code):return subprocess.check_output(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,code],text=True)
def put(host,source,target):
 digest=sha(source)
 exists=ssh(host,'python3 -c '+shlex.quote('import pathlib;print(pathlib.Path('+repr(target)+').exists())')).strip()=='True'
 if exists:
  actual=ssh(host,'sha256sum '+shlex.quote(target)).split()[0]
  if actual!=digest:raise RuntimeError('existing remote file differs: '+target)
  print('ALREADY_VERIFIED',host,target,digest,flush=True);return
 temp=target+'.upload-'+digest[:12]
 ssh(host,'mkdir -p -m 700 '+shlex.quote(str(pathlib.PurePosixPath(target).parent)))
 subprocess.run(['scp','-q','-o','BatchMode=yes','-o','ConnectTimeout=10',str(source),host+':'+temp],check=True)
 if ssh(host,'sha256sum '+shlex.quote(temp)).split()[0]!=digest:raise RuntimeError('transfer hash mismatch')
 ssh(host,'python3 -c '+shlex.quote('import os,pathlib;src=pathlib.Path('+repr(temp)+');dst=pathlib.Path('+repr(target)+');os.link(src,dst);src.unlink()'))
 print('TRANSFER_VERIFIED',host,target,digest,flush=True)
def main():
 p=argparse.ArgumentParser();p.add_argument('--host',required=True);p.add_argument('--root',required=True);p.add_argument('--build',action='store_true');p.add_argument('--shard',action='append',default=[],type=pathlib.Path);a=p.parse_args()
 if a.build:
  archive=HERE.parent/'.build/stage-source-frozen.tar.gz'
  with tarfile.open(archive,'w:gz') as tar:
   for file in sorted(HERE.iterdir()):
    if file.is_file():tar.add(file,arcname='swarmlet/engine/stages/'+file.name)
   tar.add(HERE.parent/'patches/UPSTREAM_REF',arcname='swarmlet/engine/patches/UPSTREAM_REF')
  target=a.root+'/source-'+sha(archive)+'.tar.gz';put(a.host,archive,target)
  ssh(a.host,'tar -xf '+shlex.quote(target)+' -C '+shlex.quote(a.root))
  cmd='env CUDA=ON '+shlex.quote(a.root+'/swarmlet/engine/stages/build.sh')+' > '+shlex.quote(a.root+'/cuda-build.log')+' 2>&1'
  print('CUDA_BUILD_START',a.host,a.root,flush=True)
  subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',a.host,cmd],check=True)
  print('CUDA_BUILD_PASS',ssh(a.host,shlex.quote(a.root+'/swarmlet/engine/.build/stages-build/mesh-stage-worker')+' --identity').strip(),flush=True)
 for shard in a.shard:put(a.host,shard,'/home/lotar/swarmlet/models/stages/'+shard.name)
if __name__=='__main__':main()
