#!/usr/bin/env python3
"""Run a matched physical Qwen layer-0 expert placement matrix.

The matrix uses the existing content-addressed FP16 owner bundles. Every arm
executes the same ten selected experts, uses the same coordinator/reference,
and changes only which physical host owns each 4/3/3 expert group.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
NODES = ("n1", "n2", "n3", "n4")
PRIMARY_EXPERT_COUNTS = {"n1": 4, "n2": 3, "n3": 3, "n4": 0}
EVIDENCE_SOURCE_FILES = (
    "worker.py",
    "binary_protocol.py",
    "bundle_format.py",
    "cell.py",
    "export_bundles.py",
    "external_poc.py",
    "physical_matrix.py",
)

# n4 is the cold replica of n2 and is placed away from n2 in split arms.
# Normal benchmark traffic uses n1/n2/n3 concurrently.
TOPOLOGIES: dict[str, dict[str, str]] = {
    "local-control": {"n1": "mac", "n2": "mac", "n3": "mac", "n4": "mac"},
    "legion1-only": {"n1": "l1", "n2": "l1", "n3": "l1", "n4": "l1"},
    "legion2-only": {"n1": "l2", "n2": "l2", "n3": "l2", "n4": "l2"},
    "l1-7-l2-3": {"n1": "l1", "n2": "l1", "n3": "l2", "n4": "l2"},
    "l1-4-l2-6": {"n1": "l1", "n2": "l2", "n3": "l2", "n4": "l1"},
    "l1-3-l2-7": {"n1": "l2", "n2": "l2", "n3": "l1", "n4": "l1"},
    "l1-6-l2-4": {"n1": "l2", "n2": "l1", "n3": "l1", "n4": "l2"},
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def run(
    argv: list[str],
    *,
    input_text: str | None = None,
    timeout: float = 120,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if check and result.returncode:
        command = " ".join(shlex.quote(x) for x in argv)
        raise RuntimeError(
            f"command failed rc={result.returncode}: {command}\n"
            f"stdout:\n{result.stdout[-4000:]}\nstderr:\n{result.stderr[-4000:]}"
        )
    return result


def ssh(host: str, script: str, *, timeout: float = 60) -> subprocess.CompletedProcess[str]:
    return run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "bash", "-s"],
        input_text=script,
        timeout=timeout,
    )


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def local_port_free(port: int) -> bool:
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def wait_manifest(url: str, timeout: float = 30) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url + "/manifest", timeout=2) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = exc
            time.sleep(0.1)
    raise RuntimeError(f"worker did not become ready at {url}: {last}")


def production_state() -> dict[str, Any]:
    with urllib.request.urlopen("http://127.0.0.1:8099/health", timeout=5) as response:
        health = json.load(response)
    listener = run(
        ["lsof", "-nP", "-t", "-iTCP:8099", "-sTCP:LISTEN"], timeout=10
    ).stdout.strip().splitlines()
    if len(listener) != 1:
        raise RuntimeError(f"expected exactly one production listener, got {listener}")
    return {"health": health, "pid": int(listener[0])}


def local_resources() -> dict[str, Any]:
    pressure = run(["memory_pressure", "-Q"], timeout=10).stdout
    free_line = next(line for line in pressure.splitlines() if "free percentage" in line)
    free_percent = int(free_line.rsplit(" ", 1)[-1].rstrip("%"))
    swap = run(["sysctl", "vm.swapusage"], timeout=10).stdout.strip()
    return {"freePercent": free_percent, "swap": swap}


def remote_probe(host: str, python: str) -> dict[str, Any]:
    script = f"""
set -Eeuo pipefail
test -x {shlex.quote(python)}
{shlex.quote(python)} - <<'PY'
import json, os, platform
import numpy
mem={{}}
for line in open('/proc/meminfo'):
    key, value = line.split(':', 1)
    if key in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
        mem[key] = int(value.split()[0])
print(json.dumps({{
    'home': os.path.expanduser('~'),
    'hostname': platform.node(),
    'python': platform.python_version(),
    'numpy': numpy.__version__,
    'memoryKiB': mem,
}}))
PY
"""
    data = json.loads(ssh(host, script, timeout=30).stdout)
    if data["memoryKiB"]["MemAvailable"] < 3 * 1024 * 1024:
        raise RuntimeError(f"{host} has less than 3 GiB available")
    return data


def validate_topologies() -> None:
    for name, placement in TOPOLOGIES.items():
        if set(placement) != set(NODES):
            raise ValueError(f"{name} does not place every node")
        if set(placement.values()) - {"mac", "l1", "l2"}:
            raise ValueError(f"{name} has an unknown host")
        if name.startswith("l1-"):
            l1_count = sum(PRIMARY_EXPERT_COUNTS[node] for node, host in placement.items() if host == "l1")
            l2_count = sum(PRIMARY_EXPERT_COUNTS[node] for node, host in placement.items() if host == "l2")
            expected = name.removeprefix("l1-").replace("-l2-", "/")
            if expected != f"{l1_count}/{l2_count}":
                raise ValueError(f"{name} says {expected} but places {l1_count}/{l2_count}")


class PhysicalMatrix:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.out = args.out.resolve()
        self.bundles = self.out / "bundles"
        self.campaign_id = "physical-expert-matrix-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.hosts = {"l1": args.legion1, "l2": args.legion2}
        self.pythons = {"l1": args.legion1_python, "l2": args.legion2_python}
        self.remote_dirs: dict[str, str] = {}
        self.local_processes: dict[str, subprocess.Popen[str]] = {}
        self.remote_processes: list[tuple[str, str, str, int]] = []
        self.tunnels: list[tuple[str, str]] = []
        self.arm_dir: Path | None = None
        self.manifest: dict[str, Any] = {}

    def prepare(self) -> dict[str, Any]:
        if self.out.exists():
            raise RuntimeError(f"output path already exists: {self.out}")
        self.out.mkdir(parents=True)
        before = {
            "timestampUtc": utc_now(),
            "production": production_state(),
            "localResources": local_resources(),
            "hosts": {alias: remote_probe(self.hosts[alias], self.pythons[alias]) for alias in ("l1", "l2")},
        }
        if before["localResources"]["freePercent"] < 8:
            raise RuntimeError("Mac free memory below 8%")
        run(
            [
                sys.executable,
                str(HERE / "export_bundles.py"),
                "--shard",
                str(self.args.shard),
                "--gguf-py",
                str(self.args.gguf_py),
                "--out",
                str(self.bundles),
            ],
            timeout=600,
        )
        self.manifest = json.loads((self.bundles / "manifest.json").read_text())
        if {entry["nodeId"] for entry in self.manifest["bundles"]} != set(NODES):
            raise RuntimeError("bundle manifest does not contain n1/n2/n3/n4")
        for entry in self.manifest["bundles"]:
            path = self.bundles / entry["path"]
            if path.stat().st_size != entry["bytes"] or sha256_file(path) != entry["sha256"]:
                raise RuntimeError(f"bundle verification failed: {path}")
        before["identity"] = {
            "shardSha256": sha256_file(self.args.shard),
            "bundleManifestSha256": sha256_file(self.bundles / "manifest.json"),
            "placementEpoch": self.manifest["placementEpoch"],
            "sourceSha256": {
                name: sha256_file(HERE / name)
                for name in EVIDENCE_SOURCE_FILES
            },
        }
        self.stage_remotes()
        return before

    def stage_remotes(self) -> None:
        files = [HERE / "worker.py", HERE / "binary_protocol.py", HERE / "bundle_format.py"]
        files.extend(self.bundles / f"{node}.npz" for node in NODES)
        selected = self.args.topology or list(TOPOLOGIES)
        required_aliases = sorted(
            {
                host
                for name in selected
                for host in TOPOLOGIES[name].values()
                if host != "mac"
            }
        )
        for alias in required_aliases:
            home = remote_probe(self.hosts[alias], self.pythons[alias])["home"]
            remote_dir = f"{home}/.cache/swarmlet-expert-matrix/{self.campaign_id}"
            if not remote_dir.startswith(home + "/.cache/swarmlet-expert-matrix/physical-expert-matrix-"):
                raise RuntimeError(f"unsafe remote staging path: {remote_dir}")
            ssh(
                self.hosts[alias],
                f"set -Eeuo pipefail\ntest ! -e {shlex.quote(remote_dir)}\nmkdir -p {shlex.quote(remote_dir)}\n",
            )
            self.remote_dirs[alias] = remote_dir
            run(["scp", "-q", *map(str, files), f"{self.hosts[alias]}:{remote_dir}/"], timeout=300)

    def start_local_worker(self, node: str, port: int, experts: list[int]) -> str:
        assert self.arm_dir is not None
        log = (self.arm_dir / f"{node}-mac.log").open("w")
        argv = [
            sys.executable,
            str(HERE / "worker.py"),
            "--id", node,
            "--port", str(port),
            "--bundle", str(self.bundles / f"{node}.npz"),
            "--experts", ",".join(map(str, experts)),
            "--epoch", self.manifest["placementEpoch"],
            "--backend", "numpy",
        ]
        if node == "n4":
            argv.append("--lazy")
        env = os.environ.copy()
        env.update({"OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "VECLIB_MAXIMUM_THREADS": "1"})
        proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, text=True, env=env)
        log.close()
        self.local_processes[node] = proc
        return f"http://127.0.0.1:{port}"

    def start_remote_worker(self, alias: str, node: str, port: int, experts: list[int]) -> str:
        assert self.arm_dir is not None
        remote_dir = self.remote_dirs[alias]
        arm_remote = f"{remote_dir}/{self.arm_dir.name}"
        python = self.pythons[alias]
        lazy = " --lazy" if node == "n4" else ""
        self.remote_processes.append((alias, node, arm_remote, port))
        script = f"""
set -Eeuo pipefail
mkdir -p {shlex.quote(arm_remote)}
if ss -ltn | grep -q ':{port} '; then
  echo 'refusing occupied worker port {port}' >&2
  exit 80
fi
pid=''
cleanup_failed_start() {{
  rc=$?
  if test "$rc" -ne 0 && test -n "$pid" && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  exit "$rc"
}}
trap cleanup_failed_start EXIT
nohup env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 \
  {shlex.quote(python)} {shlex.quote(remote_dir + '/worker.py')} \
  --id {shlex.quote(node)} --port {port} \
  --bundle {shlex.quote(remote_dir + '/' + node + '.npz')} \
  --experts {shlex.quote(','.join(map(str, experts)))} \
  --epoch {shlex.quote(self.manifest['placementEpoch'])} --backend numpy{lazy} \
  >{shlex.quote(arm_remote + '/' + node + '.log')} 2>&1 </dev/null &
pid=$!
for _ in $(seq 1 100); do
  if ss -ltn | grep -q ':{port} '; then
    listener_pid=$(ss -H -ltnp 'sport = :{port}' | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p')
    case "$listener_pid" in (''|*[!0-9]*) exit 83;; esac
    cmd=$(tr '\\0' ' ' <"/proc/$listener_pid/cmdline")
    case "$cmd" in (*{shlex.quote(remote_dir + '/worker.py')}*--id\\ {node}*--port\\ {port}*) :;; (*) exit 84;; esac
    pid=$listener_pid
    echo "$pid" >{shlex.quote(arm_remote + '/' + node + '.pid')}
    trap - EXIT
    exit 0
  fi
  kill -0 "$pid" 2>/dev/null || exit 81
  sleep .1
done
exit 82
"""
        ssh(self.hosts[alias], script, timeout=30)
        local_port = self.args.port_base + NODES.index(node)
        sock = f"/tmp/swem-{os.getpid()}-{node}.sock"
        Path(sock).unlink(missing_ok=True)
        run(
            [
                "ssh", "-M", "-S", sock, "-fnNT",
                "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ExitOnForwardFailure=yes",
                "-L", f"127.0.0.1:{local_port}:127.0.0.1:{port}",
                self.hosts[alias],
            ],
            timeout=30,
        )
        self.tunnels.append((self.hosts[alias], sock))
        return f"http://127.0.0.1:{local_port}"

    def cleanup_arm(self) -> None:
        errors: list[str] = []
        for host, sock in reversed(self.tunnels):
            try:
                run(["ssh", "-S", sock, "-O", "exit", host], timeout=10, check=False)
            except Exception as exc:
                errors.append(f"tunnel {host} {sock}: {exc}")
            finally:
                Path(sock).unlink(missing_ok=True)
        self.tunnels.clear()
        for node, proc in list(self.local_processes.items()):
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
            except Exception as exc:
                errors.append(f"local worker {node}: {exc}")
            finally:
                self.local_processes.pop(node, None)
        for alias, node, arm_remote, port in reversed(self.remote_processes):
            pid_file = arm_remote + "/" + node + ".pid"
            worker_path = self.remote_dirs[alias] + "/worker.py"
            script = f"""
set -Eeuo pipefail
if test -f {shlex.quote(pid_file)}; then
  pid=$(cat {shlex.quote(pid_file)})
  case "$pid" in (''|*[!0-9]*) exit 91;; esac
  if test -e "/proc/$pid"; then
    cmd=$(tr '\\0' ' ' <"/proc/$pid/cmdline")
    case "$cmd" in (*{shlex.quote(worker_path)}*--id\\ {node}*--port\\ {port}*) kill -TERM "$pid";; (*) exit 92;; esac
    for _ in $(seq 1 50); do test ! -e "/proc/$pid" && break; sleep .1; done
    test ! -e "/proc/$pid"
  fi
fi
listener_pid=$(ss -H -ltnp 'sport = :{port}' | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p')
if test -n "$listener_pid"; then
  case "$listener_pid" in (*[!0-9]*) exit 93;; esac
  cmd=$(tr '\\0' ' ' <"/proc/$listener_pid/cmdline")
  case "$cmd" in (*{shlex.quote(worker_path)}*--id\\ {node}*--port\\ {port}*) kill -TERM "$listener_pid";; (*) exit 94;; esac
  for _ in $(seq 1 50); do test ! -e "/proc/$listener_pid" && break; sleep .1; done
  if test -e "/proc/$listener_pid"; then
    kill -KILL "$listener_pid"
    for _ in $(seq 1 20); do test ! -e "/proc/$listener_pid" && break; sleep .1; done
  fi
  test ! -e "/proc/$listener_pid"
fi
if ss -ltn | grep -q ':{port} '; then exit 95; fi
if test -d {shlex.quote(arm_remote)}; then
  find {shlex.quote(arm_remote)} -type f -delete
  rmdir {shlex.quote(arm_remote)}
fi
"""
            try:
                ssh(self.hosts[alias], script, timeout=30)
            except Exception as exc:
                errors.append(f"remote worker {alias}/{node}: {exc}")
        self.remote_processes.clear()
        if errors:
            raise RuntimeError("arm cleanup failed: " + " | ".join(errors))

    def run_arm(self, name: str, placement: dict[str, str]) -> dict[str, Any]:
        if local_resources()["freePercent"] < 8:
            raise RuntimeError("Mac free memory below 8% before arm")
        for alias in {host for host in placement.values() if host != "mac"}:
            remote_probe(self.hosts[alias], self.pythons[alias])
        for offset in range(len(NODES)):
            if not local_port_free(self.args.port_base + offset):
                raise RuntimeError(f"local matrix port is busy: {self.args.port_base + offset}")
        self.arm_dir = self.out / "arms" / name
        self.arm_dir.mkdir(parents=True)
        bundle_by_node = {entry["nodeId"]: entry for entry in self.manifest["bundles"]}
        endpoints: dict[str, str] = {}
        started = time.monotonic()
        active_error: BaseException | None = None
        try:
            for index, node in enumerate(NODES):
                owner = placement[node]
                experts = list(map(int, bundle_by_node[node]["expertIds"]))
                if owner == "mac":
                    endpoints[node] = self.start_local_worker(node, self.args.port_base + index, experts)
                else:
                    endpoints[node] = self.start_remote_worker(
                        owner, node, self.args.remote_port_base + index, experts
                    )
            manifests = {node: wait_manifest(url) for node, url in endpoints.items()}
            output = self.arm_dir / "result.json"
            argv = [
                sys.executable, str(HERE / "external_poc.py"),
                "--shard", str(self.args.shard),
                "--gguf-py", str(self.args.gguf_py),
                "--out", str(output),
                "--samples", str(self.args.samples),
            ]
            for node in NODES:
                argv.extend(["--endpoint", f"{node}={endpoints[node]}"])
            completed = run(argv, timeout=self.args.arm_timeout)
            (self.arm_dir / "console.log").write_text(completed.stdout + completed.stderr)
            result = json.loads(output.read_text())
            result.update(
                {
                    "topology": name,
                    "physicalPlacement": placement,
                    "activeExpertCountByHost": {
                        host: sum(
                            PRIMARY_EXPERT_COUNTS[node]
                            for node, actual_host in placement.items()
                            if actual_host == host
                        )
                        for host in ("mac", "l1", "l2")
                    },
                    "startupManifests": manifests,
                    "armWallSeconds": time.monotonic() - started,
                }
            )
            output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
            return result
        except BaseException as exc:
            active_error = exc
            raise
        finally:
            try:
                self.cleanup_arm()
            except Exception as cleanup_error:
                if active_error is None:
                    raise
                active_error.add_note(f"additional cleanup failure: {cleanup_error}")

    def cleanup_remote_staging(self) -> None:
        errors: list[str] = []
        for alias, remote_dir in list(self.remote_dirs.items()):
            try:
                home = remote_probe(self.hosts[alias], self.pythons[alias])["home"]
                prefix = home + "/.cache/swarmlet-expert-matrix/physical-expert-matrix-"
                if not remote_dir.startswith(prefix):
                    raise RuntimeError(f"refusing to delete unsafe path: {remote_dir}")
                script = f"""
set -Eeuo pipefail
if test -d {shlex.quote(remote_dir)}; then
  test -z "$(find {shlex.quote(remote_dir)} -type f -name '*.pid' -print -quit)"
  find {shlex.quote(remote_dir)} -type f -delete
  find {shlex.quote(remote_dir)} -depth -type d -exec rmdir {{}} \\;
fi
test ! -e {shlex.quote(remote_dir)}
"""
                ssh(self.hosts[alias], script, timeout=60)
                self.remote_dirs.pop(alias, None)
            except Exception as exc:
                errors.append(f"remote staging {alias}: {exc}")
        if errors:
            raise RuntimeError("remote staging cleanup failed: " + " | ".join(errors))

    def execute(self) -> dict[str, Any]:
        before: dict[str, Any] | None = None
        arms: list[dict[str, Any]] = []
        failure: str | None = None
        try:
            before = self.prepare()
            for name in self.args.topology or list(TOPOLOGIES):
                arms.append(self.run_arm(name, TOPOLOGIES[name]))
        except Exception as exc:
            failure = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            try:
                self.cleanup_arm()
            finally:
                if self.remote_dirs:
                    self.cleanup_remote_staging()
                if self.out.exists():
                    after = {
                        "timestampUtc": utc_now(),
                        "production": production_state(),
                        "localResources": local_resources(),
                        "hosts": {
                            alias: remote_probe(self.hosts[alias], self.pythons[alias])
                            for alias in ("l1", "l2")
                        },
                    }
                    state = {"before": before, "after": after, "failure": failure}
                    (self.out / "state.json").write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
        if before is None:
            raise RuntimeError("campaign preparation did not complete")
        after_state = json.loads((self.out / "state.json").read_text())["after"]
        if before["production"] != after_state["production"]:
            raise RuntimeError("production identity or health changed during matrix")
        rows = []
        for arm in arms:
            for batch, metrics in arm["binaryBenchmarks"].items():
                rows.append(
                    {
                        "topology": arm["topology"],
                        "batch": int(batch),
                        "medianMs": metrics["medianMs"],
                        "p95Ms": metrics["p95Ms"],
                        "throughput": metrics["throughput"],
                        "parityMaxAbs": arm["binaryFp16ParityMaxAbs"],
                    }
                )
        winners = {
            str(batch): max((row for row in rows if row["batch"] == batch), key=lambda row: row["throughput"])
            for batch in (1, 4, 16)
        }
        result = {
            "schemaVersion": 1,
            "proofId": "qwen-layer0-physical-expert-placement-matrix-v1",
            "outcome": "pass",
            "timestampUtc": utc_now(),
            "scope": "real Qwen layer-0 top-10 routed experts in parallel portable CPU owners; not full-model inference or CUDA",
            "topologies": list(self.args.topology or TOPOLOGIES),
            "samplesPerBatch": self.args.samples,
            "rows": rows,
            "winners": winners,
            "identity": before["identity"],
            "productionUnchanged": True,
            "ownedProcessesCleaned": True,
            "remoteStagingCleaned": True,
        }
        (self.out / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        print("RESULT_JSON=" + json.dumps(result, separators=(",", ":")))
        return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", type=Path, required=True)
    parser.add_argument(
        "--gguf-py",
        type=Path,
        default=Path("/Users/lotar/projects/local-llm/llama.cpp-pr27739/gguf-py"),
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--legion1", default="lotar@192.168.1.243")
    parser.add_argument("--legion2", default="lotar@192.168.1.220")
    parser.add_argument("--legion1-python", default="/home/lotar/ai-mesh/.venv/bin/python")
    parser.add_argument("--legion2-python", default="/home/lotar/projects/ai-mesh/.venv/bin/python")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--arm-timeout", type=float, default=600)
    parser.add_argument("--port-base", type=int, default=54381)
    parser.add_argument("--remote-port-base", type=int, default=54381)
    parser.add_argument("--topology", action="append", choices=tuple(TOPOLOGIES))
    args = parser.parse_args()
    if not args.shard.is_file():
        parser.error(f"shard not found: {args.shard}")
    if not args.gguf_py.is_dir():
        parser.error(f"gguf-py not found: {args.gguf_py}")
    if not 1 <= args.samples <= 20:
        parser.error("--samples must be between 1 and 20")
    for port in (args.port_base, args.remote_port_base):
        if not 1024 <= port <= 65531:
            parser.error("port bases must allow four consecutive non-privileged ports")
    return args


def main() -> int:
    validate_topologies()
    PhysicalMatrix(parse_args()).execute()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
