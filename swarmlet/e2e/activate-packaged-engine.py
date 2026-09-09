#!/usr/bin/env python3
"""Activate an already installed, checksum-verified Linux package engine.

The outer idle-window owner must stop swarmlet-node.service first. This helper
checks stopped service/empty assignment ownership, verifies all packaged hashes,
backs up the existing config privately, and atomically changes only enginePath.
It neither installs packages nor restarts services. Use a fresh --backup directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REQUIRED_BINARIES = {'ggml-rpc-server', 'llama-server', 'llama-ring-bench', 'mesh-stage-worker'}


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_engine(engine):
    engine = Path(engine).resolve(strict=True)
    hashes = {}
    for line in (engine / 'sha256.txt').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})\s+\*?([A-Za-z0-9_.-]+)', line)
        if not match or match[2] in {'.', '..'} or match[2] in hashes:
            raise RuntimeError('invalid or duplicate packaged engine hash entry')
        hashes[match[2]] = match[1]
    if not REQUIRED_BINARIES.issubset(hashes):
        raise RuntimeError('packaged manifest is missing required engine binaries')
    for name, expected in hashes.items():
        binary = engine / name
        if not binary.is_file() or binary.is_symlink():
            raise RuntimeError('packaged engine entry must be a regular file: ' + name)
        if name in REQUIRED_BINARIES and not os.access(binary, os.X_OK):
            raise RuntimeError('packaged engine binary is not executable: ' + name)
        if sha256_file(binary) != expected:
            raise RuntimeError('packaged engine checksum mismatch: ' + name)
    return engine, hashes


def require_stopped_service(service):
    result = subprocess.run(['systemctl', '--user', 'show', '--property=ActiveState', '--property=MainPID', service],
                            check=True, capture_output=True, text=True, timeout=15)
    state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if state.get('ActiveState') not in ['inactive', 'failed'] or state.get('MainPID') != '0':
        raise RuntimeError('stop the node service before packaged engine activation')


def activate_packaged_engine(config, engine, backup, ownership):
    """Caller owns the stopped service. No config mutation until every hash passes."""
    config, backup, ownership = Path(config), Path(backup), Path(ownership)
    if json.loads(ownership.read_text()) != []:
        raise RuntimeError('native/legacy assignment ownership must be empty before activation')
    engine, hashes = verify_engine(engine)
    original = config.read_bytes()
    cfg = json.loads(original)
    if not isinstance(cfg, dict):
        raise RuntimeError('node configuration must be an object')
    previous = cfg.get('enginePath')
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(backup, 0o700)
    with (backup / 'node-before.json').open('xb') as handle:
        os.chmod(handle.fileno(), 0o600)
        handle.write(original)
    evidence = dict(previousEnginePath=previous, enginePath=str(engine), sha256=hashes,
                    originalConfigSha256=hashlib.sha256(original).hexdigest())
    with (backup / 'activation.json').open('x') as handle:
        os.chmod(handle.fileno(), 0o600)
        json.dump(evidence, handle, indent=2)
        handle.write('\n')
    cfg['enginePath'] = str(engine)
    descriptor, name = tempfile.mkstemp(prefix='.node-engine-', suffix='.json', dir=config.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(cfg, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        if config.read_bytes() != original:
            raise RuntimeError('node config changed during activation; refusing to overwrite it')
        os.replace(temporary, config)
    finally:
        temporary.unlink(missing_ok=True)
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path.home() / '.swarmlet/node.json')
    parser.add_argument('--engine', type=Path, default=Path('/usr/lib/Swarmlet Node/engine'))
    parser.add_argument('--ownership', type=Path, default=Path.home() / '.swarmlet/state/assignments.json')
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--service', default='swarmlet-node.service')
    args = parser.parse_args()
    require_stopped_service(args.service)
    print(json.dumps(activate_packaged_engine(args.config, args.engine, args.backup, args.ownership), indent=2))


if __name__ == '__main__':
    main()
