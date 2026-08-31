#!/usr/bin/env python3
"""Wrap one proof artifact in an Ed25519-signed run manifest."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from run_manifest import create,sign,verify
ap=argparse.ArgumentParser();ap.add_argument('--artifact',required=True);ap.add_argument('--out',required=True);ap.add_argument('--key-dir',required=True);ap.add_argument('--trusted-fingerprint');a=ap.parse_args()
artifact=Path(a.artifact);proof=json.loads(artifact.read_text());manifest=create(['physical-proof'],{'proofId':proof.get('proofId'),'protocolVersion':proof.get('protocolVersion'),'placementEpoch':proof.get('placementEpoch')},{'outcome':proof.get('outcome'),'proof':proof},[artifact]);signed=sign(manifest,a.key_dir);fp=signed['signerFingerprint']
if a.trusted_fingerprint and fp!=a.trusted_fingerprint:raise SystemExit('signer fingerprint does not match pinned trust root')
if not verify(signed,a.trusted_fingerprint or fp):raise SystemExit('signed manifest failed immediate verification')
out=Path(a.out);out.parent.mkdir(parents=True,exist_ok=True);tmp=out.with_suffix(out.suffix+'.tmp');tmp.write_text(json.dumps(signed,indent=2,sort_keys=True)+'\n');tmp.replace(out)
print('RESULT_JSON='+json.dumps({'signed':True,'out':str(out),'signerFingerprint':fp,'pinned':bool(a.trusted_fingerprint)},separators=(',',':')))
