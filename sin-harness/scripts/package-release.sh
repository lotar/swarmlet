#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd);cd "$ROOT"
test -z "$(git status --porcelain=v1)" || { echo 'package requires a clean tree' >&2;exit 2; }
VERSION=$(bun -e 'console.log(require("./sin-harness/package.json").version)')
COMMIT=$(git rev-parse HEAD);OUT="$ROOT/dist";mkdir -p "$OUT";ARCHIVE="$OUT/swarmlet-$VERSION.tar.gz"
git archive --format=tar.gz --prefix="swarmlet-$VERSION/" -o "$ARCHIVE" HEAD
python3 - "$ROOT" "$OUT" "$VERSION" "$COMMIT" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);version=sys.argv[3];commit=sys.argv[4]
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
package=json.loads((root/'sin-harness/package.json').read_text());requirements=[x.strip() for x in (root/'sin-harness/requirements-proofs.txt').read_text().splitlines() if x.strip() and not x.startswith('#')]
sbom={'schemaVersion':1,'name':'swarmlet','version':version,'gitCommit':commit,'license':'Swarmlet Community License 1.0','runtimeDependencies':[],'developmentDependencies':package.get('devDependencies',{}),'optionalPythonProofDependencies':requirements,'modelsIncluded':False}
p=out/f'swarmlet-{version}.sbom.json';p.write_text(json.dumps(sbom,indent=2,sort_keys=True)+'\n')
archive=out/f'swarmlet-{version}.tar.gz';checks={archive.name:sha(archive),p.name:sha(p)};(out/f'swarmlet-{version}.sha256').write_text(''.join(f'{v}  {k}\n' for k,v in checks.items()))
PY
cat "$OUT/swarmlet-$VERSION.sha256"
