"""OpenSSL-backed Ed25519 manifest signing; no Python dependency."""
import base64,json,subprocess,tempfile
from pathlib import Path
def canonical(obj):return json.dumps(obj,sort_keys=True,separators=(',',':')).encode()
def ensure_keys(directory):
 d=Path(directory);d.mkdir(parents=True,exist_ok=True);priv=d/'private.pem';pub=d/'public.pem'
 if not priv.exists():subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(priv)],check=True,stdout=subprocess.DEVNULL)
 if not pub.exists():subprocess.run(['openssl','pkey','-in',str(priv),'-pubout','-out',str(pub)],check=True,stdout=subprocess.DEVNULL)
 return priv,pub
def sign_manifest(manifest,directory):
 priv,pub=ensure_keys(directory)
 with tempfile.NamedTemporaryFile() as data:
  data.write(canonical(manifest));data.flush();sig=subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(priv),'-in',data.name],check=True,capture_output=True).stdout
 return {**manifest,'signature':base64.b64encode(sig).decode(),'publicKeyPem':pub.read_text()}
def verify_manifest(signed):
 obj=dict(signed);sig=base64.b64decode(obj.pop('signature'));pub=obj.pop('publicKeyPem')
 with tempfile.TemporaryDirectory() as d:
  p=Path(d);(p/'pub.pem').write_text(pub);(p/'sig').write_bytes(sig);(p/'data').write_bytes(canonical(obj))
  r=subprocess.run(['openssl','pkeyutl','-verify','-rawin','-pubin','-inkey',str(p/'pub.pem'),'-sigfile',str(p/'sig'),'-in',str(p/'data')],capture_output=True)
  return r.returncode==0
