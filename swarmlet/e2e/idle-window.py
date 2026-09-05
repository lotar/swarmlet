#!/usr/bin/env python3
"""Run an operator only inside a verified idle Flash-Next maintenance window.

No activity is inferred from CPU use or open socket age. Both request counters
must be present and zero, the token counter must stay unchanged, and the existing
maintenance script retains its final connected-client guard. Production is
restored in finally after the owned command exits, including on TERM/INT.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.request


def read_json(url, headers=None):
    req = urllib.request.Request(url, headers={"Connection": "close", **(headers or {})})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)


def parse_metrics(text):
    values = {}
    for name in ("requests_processing", "requests_deferred", "tokens_predicted_total"):
        match = re.search(r"^llamacpp:" + name + r"(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$", text, re.M)
        if not match:
            raise ValueError("missing metric " + name)
        value = float(match[1])
        if not (0 <= value < float("inf")):
            raise ValueError("invalid metric " + name)
        values[name] = value
    return values


def sample(base, control_config):
    if read_json(base + "/health").get("status") != "ok":
        raise ValueError("production health is not ok")
    req = urllib.request.Request(base + "/metrics", headers={"Connection": "close"})
    with urllib.request.urlopen(req, timeout=5) as response:
        metrics = parse_metrics(response.read().decode())
    cfg = json.loads(control_config.read_text())
    routing = read_json("http://127.0.0.1:47900/api/routing", {"Authorization": "Bearer " + cfg["adminToken"]})
    metrics["router_inflight"] = routing["totals"]["inflight"]
    return metrics


class QuietGate:
    def __init__(self, seconds):
        self.seconds = seconds
        self.since = None
        self.tokens = None

    def observe(self, metrics, now):
        tokens = metrics["tokens_predicted_total"]
        busy = any(metrics[k] != 0 for k in ("requests_processing", "requests_deferred", "router_inflight"))
        if busy or tokens != self.tokens:
            self.since = None if busy else now
        elif self.since is None:
            self.since = now
        self.tokens = tokens
        return self.since is not None and now - self.since >= self.seconds

    def reset(self):
        self.since = None
        self.tokens = None


def run_maintenance(script, action):
    process = subprocess.Popen([str(script), action])
    try:
        return process.wait()
    except BaseException:
        # Never race restoration against a still-running stop operator.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        process.wait()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet-seconds", type=float, default=60)
    parser.add_argument("--timeout", type=float, default=43200)
    parser.add_argument("--poll", type=float, default=10)
    parser.add_argument("--check", action="store_true", help="one read-only observation; never stops production")
    parser.add_argument("--maintenance", type=Path, default=Path(__file__).resolve().parents[2] / "sin-harness/scripts/flashnext-maintenance.sh")
    parser.add_argument("--control-config", type=Path, default=Path.home() / ".swarmlet/control/control.json")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.quiet_seconds < 30 or not 1 <= args.poll <= 60 or args.timeout <= 0:
        parser.error("quiet-seconds must be >=30, poll 1..60, timeout positive")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not args.check and not command:
        parser.error("supply an operator command after --")
    def interrupted(signum, frame):
        raise KeyboardInterrupt("signal " + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    gate = QuietGate(args.quiet_seconds)
    deadline = time.monotonic() + args.timeout
    stopped = False
    child = None
    result = 1
    try:
        while time.monotonic() < deadline:
            try:
                metrics = sample("http://127.0.0.1:8099", args.control_config)
                ready = gate.observe(metrics, time.monotonic())
                print("IDLE_SAMPLE " + json.dumps(metrics) + " quiet=" + str(ready), flush=True)
            except Exception as exc:
                gate.reset()
                ready = False
                print("IDLE_UNKNOWN " + type(exc).__name__, flush=True)
                if args.check:
                    return 2
            if args.check:
                return 0 if all(metrics[k] == 0 for k in ("requests_processing", "requests_deferred", "router_inflight")) else 1
            if ready:
                # Never override this script's open-client/PID ownership checks.
                # A signal or partial stop must still trigger restoration.
                stopped = True
                stop_code = run_maintenance(args.maintenance, "stop")
                if stop_code == 0:
                    stopped = True
                    print("MAINTENANCE_WINDOW_OPEN", flush=True)
                    env = dict(os.environ, SWARMLET_IDLE_WINDOW="1")
                    child = subprocess.Popen(command, env=env, start_new_session=True)
                    result = child.wait()
                    break
                gate.reset()
                if stop_code != 65:
                    raise RuntimeError("maintenance stop failed: " + str(stop_code))
                stopped = False
                print("IDLE_WAIT connected clients remain; production unchanged", flush=True)
            time.sleep(args.poll)
        else:
            print("IDLE_TIMEOUT production was not stopped", flush=True)
            result = 3
    except KeyboardInterrupt:
        result = 130
    finally:
        if stopped or child is not None:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
        # Let only our operator clean itself up before restoring production.
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait()
        if stopped:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            restored = run_maintenance(args.maintenance, "start")
            checked = run_maintenance(args.maintenance, "check-only")
            if restored or checked:
                print("PRODUCTION_RESTORE_FAILED", flush=True)
                result = 4
            else:
                print("PRODUCTION_RESTORED", flush=True)
    return result


if __name__ == "__main__":
    sys.exit(main())
