#!/usr/bin/env python3
"""Refresh the existing three-node rig inside idle-window.py, with private backups.

Run only from a committed, verified worktree. Source, identities and model files
are separate: this replaces code/binaries and enginePath, never enrollment/offers.
The parent idle-window operator owns production restoration on every exit.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import time
import urllib.request


def interrupt_refresh(signum, _frame):
    raise KeyboardInterrupt('refresh interrupted by signal ' + str(signum))


def require_empty_ownership(text):
    if json.loads(text) != []:
        raise RuntimeError('old agent did not clear ownership; refusing binary replacement')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live-root', type=Path, default=Path('/Users/lotar/projects/ai-mesh'))
    parser.add_argument('--sudo-password-file', required=True, type=Path)
    parser.add_argument('--deployment-id', default='dep-65bedf5278d1')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    if os.environ.get('SWARMLET_IDLE_WINDOW') != '1':
        parser.error('requires idle-window.py maintenance ownership')
    try:
        conn = socket.create_connection(('127.0.0.1', 8099), timeout=2)
    except OSError:
        pass
    else:
        conn.close()
        raise RuntimeError('production still listens; refusing refresh')
    tag = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path.home() / '.swarmlet/backups' / tag
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup, 0o700)
    record = {'startedAt': tag, 'steps': [], 'success': False}
    def run(argv, *, cwd=None, env=None, capture=False, input=None):
        print('RUN ' + shlex.join(map(str, argv)), flush=True)
        return subprocess.run(list(map(str, argv)), cwd=cwd, env=env, input=input,
            check=True, stdout=subprocess.PIPE if capture else None, text=capture)
    def step(name):
        record['steps'].append({'name': name, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        (backup / 'refresh.json').write_text(json.dumps(record, indent=2) + '\n')
        print('REFRESH ' + name, flush=True)
    def ssh(host, command, **kwargs):
        return run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], **kwargs)
    def scp(source, destination):
        run(['scp', '-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', source, destination])
    def wait_http(url, seconds=120):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=3) as r:
                    if r.status == 200:
                        return json.load(r)
            except OSError:
                pass
            time.sleep(1)
        raise RuntimeError('service health timeout: ' + url)
    def hash_file(path):
        return hashlib.file_digest(open(path, 'rb'), 'sha256').hexdigest()
    hosts = ['lotar@192.168.1.243', 'lotar@192.168.1.220']
    remote = '/home/lotar/swarmlet/releases/' + tag
    live = args.live_root
    domain = 'gui/' + str(os.getuid())
    revision = run(['git', 'rev-parse', 'HEAD'], cwd=root, capture=True).stdout.strip()
    if run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=root, capture=True).stdout.strip():
        raise RuntimeError('commit the intended source before building release manifests')
    record['revision'] = revision
    services_stopped = False
    signal.signal(signal.SIGTERM, interrupt_refresh)
    signal.signal(signal.SIGINT, interrupt_refresh)
    try:
        # These are isolated simulated end-to-end tests, but still honour the user's idle gate.
        run(['bun', 'run', 'typecheck'], cwd=root / 'swarmlet')
        run(['bun', 'test', 'protocol', 'control', 'node-agent'], cwd=root / 'swarmlet')
        run(['bun', 'test', 'e2e'], cwd=root / 'swarmlet')
        step('simulated-e2e-passed')
        for name in ['node.json', 'control/control.json']:
            dst = backup / name
            dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(Path.home() / '.swarmlet' / name, dst)
        with sqlite3.connect(Path.home() / '.swarmlet/control/control.sqlite') as src, sqlite3.connect(backup / 'control/control.sqlite') as dst:
            src.backup(dst)
        for label in ['ai.swarmlet.control', 'ai.swarmlet.node']:
            shutil.copy2(Path.home() / 'Library/LaunchAgents' / (label + '.plist'), backup / (label + '.plist'))
        shutil.copy2(live / 'swarmlet/dist/agent/darwin/swarmlet-node', backup / 'swarmlet-node-mac')
        for name in ['control', 'protocol']:
            shutil.copytree(live / 'swarmlet' / name, backup / 'old-source/swarmlet' / name)
        previous_app = live / 'swarmlet/node-shell/src-tauri/target/release/bundle/macos/Swarmlet Node.app'
        if previous_app.exists():
            shutil.copytree(previous_app, backup / 'Swarmlet Node.app', symlinks=True)
        for host in hosts:
            ssh(host, 'mkdir -p -m 700 ' + shlex.quote(remote))
            ssh(host, "cp /home/lotar/.swarmlet/node.json " + shlex.quote(remote + '/node-before.json')
                + " && cp /home/lotar/swarmlet/swarmlet-node " + shlex.quote(remote + '/agent-before')
                + " && cp /home/lotar/.config/systemd/user/swarmlet-node.service " + shlex.quote(remote + '/service-before'))
        step('private-backups-created')
        # Graceful old-agent shutdown clears legacy PID-only snapshots before upgrading.
        services_stopped = True
        run(['launchctl', 'bootout', domain + '/ai.swarmlet.node'])
        for host in hosts:
            ssh(host, 'systemctl --user stop swarmlet-node.service')
        run(['launchctl', 'bootout', domain + '/ai.swarmlet.control'])
        require_empty_ownership((Path.home() / '.swarmlet/state/assignments.json').read_text())
        for host in hosts:
            require_empty_ownership(ssh(host, 'cat /home/lotar/.swarmlet/state/assignments.json', capture=True).stdout)
        step('old-services-stopped')
        # Fast-forward only: never overwrite another checkout's uncommitted or divergent work.
        run(['git', 'merge', '--ff-only', revision], cwd=live)
        archive = backup / 'source.tar'
        with archive.open('wb') as out:
            subprocess.run(['git', 'archive', revision, 'swarmlet', 'sin-harness/core/sign.ts'], cwd=root, stdout=out, check=True)
        record['sourceArchiveSha256'] = hash_file(archive)
        scp(str(archive), hosts[0] + ':' + remote + '/source.tar')
        remote_hash = ssh(hosts[0], 'sha256sum ' + shlex.quote(remote + '/source.tar'), capture=True).stdout.split()[0]
        if remote_hash != record['sourceArchiveSha256']:
            raise AssertionError('transferred source archive hash mismatch')
        ssh(hosts[0], 'tar -xf ' + shlex.quote(remote + '/source.tar') + ' -C ' + shlex.quote(remote))
        mac_env = dict(os.environ, SWARMLET_BUILD_REVISION=revision, SWARMLET_ENGINE_DIST=str(live / 'swarmlet/engine/dist/darwin'),
            CARGO_TARGET_DIR=str(live / 'swarmlet/node-shell/src-tauri/target'), CARGO_BUILD_JOBS='2')
        linux_command = shlex.join(['env', 'PATH=/home/lotar/.cargo/bin:/home/lotar/.bun/bin:/usr/local/bin:/usr/bin:/bin',
            'SWARMLET_ENGINE_DIST=/home/lotar/swarmlet-engine/dist/linux',
            'SWARMLET_BUILD_REVISION=' + revision,
            'CARGO_TARGET_DIR=/home/lotar/swarmlet-shell/src-tauri/target', 'CARGO_BUILD_JOBS=2',
            remote + '/swarmlet/node-shell/scripts/build-release.sh'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            mac = pool.submit(run, [root / 'swarmlet/node-shell/scripts/build-release.sh'], env=mac_env)
            linux = pool.submit(ssh, hosts[0], linux_command)
            mac.result()
            linux.result()
        step('native-packages-built')
        app = root / 'swarmlet/dist/shell/darwin/Swarmlet Node.app'
        installed_app = Path.home() / 'Applications/Swarmlet Node.app'
        installed_app.parent.mkdir(exist_ok=True)
        if installed_app.exists():
            shutil.move(installed_app, backup / 'Installed Swarmlet Node.app')
        shutil.copytree(app, installed_app, symlinks=True)
        final_mac = installed_app / 'Contents/MacOS/swarmlet-node'
        mac_binary = live / 'swarmlet/dist/agent/darwin/swarmlet-node'
        shutil.copy2(final_mac, mac_binary.with_suffix('.new'))
        os.replace(mac_binary.with_suffix('.new'), mac_binary)
        stable_engine = Path.home() / '.swarmlet/runtime/engine'
        stable_engine.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(root / 'swarmlet/dist/agent/darwin/engine', stable_engine, dirs_exist_ok=True)
        node_config = Path.home() / '.swarmlet/node.json'
        cfg = json.loads(node_config.read_text())
        cfg['enginePath'] = str(stable_engine)
        temporary_config = node_config.with_suffix('.new')
        temporary_config.write_text(json.dumps(cfg, indent=2) + '\n')
        os.chmod(temporary_config, 0o600)
        os.replace(temporary_config, node_config)
        # Copy the actual packaged sidecar as service binary, preserving post-signing identity.
        manifest = json.loads((root / 'swarmlet/dist/agent/darwin/agent-build.json').read_text())
        manifest.update(compiledSha256=manifest['sha256'], sha256=hash_file(final_mac))
        (mac_binary.parent / 'agent-build.json').write_text(json.dumps(manifest, indent=2) + '\n')
        record['macAgentSha256'] = hash_file(mac_binary)
        if hash_file(final_mac) != record['macAgentSha256']:
            raise AssertionError('Mac service and GUI sidecar differ')
        deb_name = 'swarmlet-node_0.1.0_amd64.deb'
        scp(hosts[0] + ':' + remote + '/swarmlet/dist/shell/linux/' + deb_name, str(backup / deb_name))
        scp(hosts[0] + ':' + remote + '/swarmlet/dist/agent/linux/agent-build.json', str(backup / 'linux-agent-build.json'))
        linux_manifest = json.loads((backup / 'linux-agent-build.json').read_text())
        if linux_manifest['revision'] != revision:
            raise AssertionError('Linux source revision differs from the reviewed source')
        record['linuxAgentSha256'] = linux_manifest['sha256']
        record['linuxPackageSha256'] = hash_file(backup / deb_name)
        for host in hosts:
            scp(str(backup / deb_name), host + ':' + remote + '/' + deb_name)
            with args.sudo_password_file.open('rb') as password:
                subprocess.run(['ssh', '-o', 'BatchMode=yes', host,
                    'sudo -S -p "" dpkg -i ' + shlex.quote(remote + '/' + deb_name)], stdin=password, check=True)
            ssh(host, 'cp /usr/bin/swarmlet-node /home/lotar/swarmlet/swarmlet-node.new && chmod 755 /home/lotar/swarmlet/swarmlet-node.new && mv /home/lotar/swarmlet/swarmlet-node.new /home/lotar/swarmlet/swarmlet-node && cmp /usr/bin/swarmlet-node /home/lotar/swarmlet/swarmlet-node')
            hashes = ssh(host, 'sha256sum /usr/bin/swarmlet-node /home/lotar/swarmlet/swarmlet-node', capture=True).stdout.splitlines()
            if len(hashes) != 2 or any(line.split()[0] != linux_manifest['sha256'] for line in hashes):
                raise AssertionError('installed Linux sidecar/service differ from canonical build: ' + host)
        step('matching-service-and-gui-binaries-installed')
        run(['launchctl', 'bootstrap', domain, Path.home() / 'Library/LaunchAgents/ai.swarmlet.control.plist'])
        wait_http('http://127.0.0.1:47900/health')
        run(['launchctl', 'bootstrap', domain, Path.home() / 'Library/LaunchAgents/ai.swarmlet.node.plist'])
        for host in hosts:
            ssh(host, 'systemctl --user start swarmlet-node.service')
        wait_http('http://127.0.0.1:47800/api/status')
        deadline = time.monotonic() + 180
        while wait_http('http://127.0.0.1:47900/health')['nodes'] != 3:
            if time.monotonic() > deadline:
                raise RuntimeError('three agents did not reconnect after refresh')
            time.sleep(2)
        step('three-refreshed-agents-online')
        run(['python3', root / 'swarmlet/e2e/real-rig-faults.py', '--out', backup / 'real-faults.json', '--deployment-id', args.deployment_id])
        record['success'] = True
        step('real-fault-acceptance-passed')
    finally:
        # idle-window sends TERM to this operator's process group, including its
        # synchronous build/install children. Unwind rather than skipping restore.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if services_stopped:
            # Build/install/test failures must not leave the rig's service managers unloaded.
            # The existing plists point at stable paths containing either old or new verified code.
            for label in ['ai.swarmlet.control', 'ai.swarmlet.node']:
                loaded = subprocess.run(['launchctl', 'print', domain + '/' + label], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if loaded.returncode:
                    result = subprocess.run(['launchctl', 'bootstrap', domain, str(Path.home() / 'Library/LaunchAgents' / (label + '.plist'))])
                    if result.returncode:
                        record.setdefault('restoreErrors', []).append(label)
            for host in hosts:
                result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'systemctl --user start swarmlet-node.service'])
                if result.returncode:
                    record.setdefault('restoreErrors', []).append(host)
        (backup / 'refresh.json').write_text(json.dumps(record, indent=2) + '\n')
        # Production restore belongs to idle-window.py; preserve backups and failure evidence.
        print('REFRESH_EVIDENCE ' + str(backup), flush=True)


if __name__ == '__main__':
    main()
