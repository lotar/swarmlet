"""OpenSSL-backed Ed25519 manifest signing with out-of-band fingerprint pinning."""
import base64,binascii,hashlib,json,os,subprocess,tempfile
from pathlib import Path
def canonical(obj):return json.dumps(obj,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def fingerprint(pem):return hashlib.sha256(pem.encode()).hexdigest()
def ensure_keys(directory):
 d=Path(directory);d.mkdir(parents=True,exist_ok=True);os.chmod(d,0o700);priv=d/'private.pem';pub=d/'public.pem'
 if not priv.exists():subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(priv)],check=True,capture_output=True)
 os.chmod(priv,0o600);derived=subprocess.check_output(['openssl','pkey','-in',str(priv),'-pubout'],text=True)
 if pub.exists() and pub.read_text()!=derived:raise RuntimeError('public/private signing key mismatch')
 if not pub.exists():pub.write_text(derived)
 os.chmod(pub,0o644);return priv,pub
def sign_manifest(manifest,directory):
 priv,pub=ensure_keys(directory);pem=pub.read_text();body={**manifest,'signerFingerprint':fingerprint(pem)}
 with tempfile.NamedTemporaryFile() as data:
  data.write(canonical(body));data.flush();sig=subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(priv),'-in',data.name],check=True,capture_output=True).stdout
 return {**body,'signature':base64.b64encode(sig).decode(),'publicKeyPem':pem}
def verify_manifest(signed,trusted_fingerprint):
 try:
  obj=dict(signed);sig=base64.b64decode(obj.pop('signature'),validate=True);pub=obj.pop('publicKeyPem')
  if not isinstance(trusted_fingerprint,str) or fingerprint(pub)!=trusted_fingerprint or obj.get('signerFingerprint')!=trusted_fingerprint:return False
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'pub.pem').write_text(pub);(p/'sig').write_bytes(sig);(p/'data').write_bytes(canonical(obj));return subprocess.run(['openssl','pkeyutl','-verify','-rawin','-pubin','-inkey',str(p/'pub.pem'),'-sigfile',str(p/'sig'),'-in',str(p/'data')],capture_output=True).returncode==0
 except (KeyError,TypeError,ValueError,binascii.Error,subprocess.SubprocessError,OSError):return False

def selftest():
 with tempfile.TemporaryDirectory() as d:
  signed=sign_manifest({'epoch':'a'*64},Path(d)/'trusted');fp=signed['signerFingerprint'];assert verify_manifest(signed,fp);tampered=dict(signed);tampered['epoch']='b'*64;assert not verify_manifest(tampered,fp);replacement=sign_manifest({'epoch':'a'*64},Path(d)/'other');assert not verify_manifest(replacement,fp);assert not verify_manifest(signed,'0'*64);return {'verified':True,'tamperRejected':True,'keyReplacementRejected':True,'wrongPinRejected':True}
if __name__=='__main__':print('RESULT_JSON='+json.dumps(selftest(),separators=(',',':')))
