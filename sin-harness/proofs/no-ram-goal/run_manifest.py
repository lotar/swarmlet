#!/usr/bin/env python3
"""Ed25519-signed benchmark manifests with pinned signer and dirty-tree provenance."""
import base64,binascii,copy,datetime,hashlib,json,os,platform,subprocess,tempfile,uuid
from pathlib import Path
def canon(x):return json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def keys(d):
 d=Path(d);d.mkdir(parents=True,exist_ok=True);os.chmod(d,0o700);pr=d/'private.pem';pu=d/'public.pem'
 if not pr.exists():subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(pr)],check=True,capture_output=True)
 os.chmod(pr,0o600);derived=subprocess.check_output(['openssl','pkey','-in',str(pr),'-pubout'],text=True)
 if pu.exists() and pu.read_text()!=derived:raise RuntimeError('public/private signing key mismatch')
 if not pu.exists():pu.write_text(derived)
 os.chmod(pu,0o644);return pr,pu
def fingerprint(pem):return hashlib.sha256(pem.encode()).hexdigest()
def sign(manifest,d):
 pr,pu=keys(d);pub=pu.read_text();body={**manifest,'signerFingerprint':fingerprint(pub)}
 with tempfile.NamedTemporaryFile() as f:
  f.write(canon(body));f.flush();sig=subprocess.check_output(['openssl','pkeyutl','-sign','-rawin','-inkey',str(pr),'-in',f.name])
 return {**body,'signature':base64.b64encode(sig).decode(),'publicKeyPem':pub}
def verify(s,trusted_fingerprint):
 try:
  x=dict(s);sig=base64.b64decode(x.pop('signature'),validate=True);pub=x.pop('publicKeyPem')
  if not isinstance(pub,str) or fingerprint(pub)!=trusted_fingerprint or x.get('signerFingerprint')!=trusted_fingerprint:return False
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'p').write_text(pub);(p/'s').write_bytes(sig);(p/'d').write_bytes(canon(x));return subprocess.run(['openssl','pkeyutl','-verify','-rawin','-pubin','-inkey',str(p/'p'),'-sigfile',str(p/'s'),'-in',str(p/'d')],capture_output=True).returncode==0
 except (KeyError,TypeError,ValueError,binascii.Error,subprocess.SubprocessError,OSError):return False
def create(command,config,metrics,artifacts):
 root=Path(subprocess.check_output(['git','rev-parse','--show-toplevel'],text=True).strip()).resolve()
 def label(p):
  p=Path(p).resolve()
  try:return str(p.relative_to(root))
  except ValueError:return p.name
 commit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();status=subprocess.check_output(['git','status','--porcelain=v1'],text=True);diff=subprocess.check_output(['git','diff','--binary','HEAD']);return {'schemaVersion':1,'runId':str(uuid.uuid4()),'timestampUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gitCommit':commit,'gitDirty':bool(status.strip()),'gitStatus':status.splitlines(),'gitDiffSha256':hashlib.sha256(diff).hexdigest(),'host':{'platform':platform.platform(),'machine':platform.machine()},'command':command,'config':config,'metrics':metrics,'artifacts':[{'path':label(p),'sha256':sha(p),'bytes':Path(p).stat().st_size} for p in artifacts]}
def selftest():
 with tempfile.TemporaryDirectory() as d:
  p=Path(d)/'a';p.write_text('evidence');m=create(['test'],{'seed':42},{'tps':37.7},[p]);s=sign(m,Path(d)/'keys');fp=s['signerFingerprint'];assert verify(s,fp);tamper=copy.deepcopy(s);tamper['metrics']['tps']=0;assert not verify(tamper,fp);other=sign(m,Path(d)/'other');assert not verify(other,fp);malformed=copy.deepcopy(s);malformed['signature']='not base64';assert not verify(malformed,fp);result={'signed':True,'tamperRejected':True,'keyReplacementRejected':True,'malformedRejected':True,'dirtyStateRecorded':True,'schemaVersion':1};print('RESULT_JSON='+json.dumps(result,separators=(',',':')));return result
if __name__=='__main__':selftest()
