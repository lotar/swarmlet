"""Pure classifier/retry regressions; no engines, network, services, or signals."""
import copy
import importlib.util
from pathlib import Path
import subprocess
import unittest
import urllib.error

spec = importlib.util.spec_from_file_location('real_rig_faults', Path(__file__).with_name('real-rig-faults.py'))
rig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rig)
helpers = {}
exec(rig.AUDIT_HELPERS, helpers)
classify = helpers['classify_processes']


def row(**changes):
    value = {'pid': 200, 'ppid': 100, 'executable': '/some/Swarmlet Node.app/engine/llama-server', 'ports': []}
    value['argv'] = [value['executable'], '--list-devices']
    value.update(changes)
    return value


class ClassifierTests(unittest.TestCase):
    def run_classify(self, candidate, expected=None, parents=None, agent=100):
        return classify([copy.deepcopy(candidate)], expected or [], parents or {200: 100}, agent)

    def test_linux_device_probe_is_recorded_separately(self):
        result = self.run_classify(row())
        self.assertEqual(result['processes'], [])
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['deviceProbes'][0]['pid'], 200)

    def test_macos_exact_prefix_handles_unquoted_spaces(self):
        candidate = row(); del candidate['argv']
        candidate['command'] = candidate['executable'] + ' --list-devices'
        self.assertEqual(len(self.run_classify(candidate)['deviceProbes']), 1)

    def test_extra_flags_cannot_hide_server(self):
        for extra in (['--port', '8100'], ['-m', 'model.gguf'], ['--list-devices']):
            with self.subTest(extra=extra):
                candidate = row(); candidate['argv'] += extra
                result = self.run_classify(candidate)
                self.assertEqual(result['deviceProbes'], [])
                self.assertEqual(len(result['errors']), 1)

    def test_macos_extra_flags_cannot_hide_server(self):
        candidate = row(); del candidate['argv']
        candidate['command'] = candidate['executable'] + ' --list-devices --port 8100'
        self.assertEqual(len(self.run_classify(candidate)['errors']), 1)

    def test_wrong_parent_listener_and_rpc_binary_remain_orphans(self):
        for candidate in (row(ppid=99), row(ports=[8100]), row(executable='/some/engine/ggml-rpc-server')):
            with self.subTest(candidate=candidate):
                self.assertEqual(len(self.run_classify(candidate)['errors']), 1)
                self.assertEqual(self.run_classify(candidate)['deviceProbes'], [])

    def test_expected_pid_is_checked_before_probe_classification(self):
        assignment = {'id': 'expected', 'pid': 200, 'expectedEnginePorts': [8100]}
        result = self.run_classify(row(), [assignment])
        self.assertEqual(len(result['processes']), 1)
        self.assertEqual(result['deviceProbes'], [])
        self.assertIn('missing engine listening ports', result['errors'][0])

    def test_systemd_descendant_matches_and_port_is_required(self):
        assignment = {'id': 'worker', 'pid': 150, 'expectedEnginePorts': [51000]}
        candidate = row(ppid=150, ports=[51000], argv=['engine', '--port', '51000'])
        result = self.run_classify(candidate, [assignment], {200: 150, 150: 100})
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['processes'][0]['snapshotPid'], 150)
        self.assertEqual(result['processes'][0]['assignmentId'], 'worker')

    def test_two_actual_engines_under_one_snapshot_fail(self):
        assignment = {'id': 'worker', 'pid': 150, 'expectedEnginePorts': [51000]}
        rows = [row(ppid=150, ports=[51000]), row(pid=201, ppid=150, ports=[51001])]
        result = classify(rows, [assignment], {200: 150, 201: 150, 150: 100}, 100)
        self.assertTrue(any('has 2 engine processes' in error for error in result['errors']))


class RetryTests(unittest.TestCase):
    def test_timeout_recollects_everything_and_preserves_failure(self):
        calls, failures = [], []
        def collect():
            calls.append(('fresh-control-and-nodes', len(calls)))
            if len(calls) == 1: raise subprocess.TimeoutExpired(['ssh'], 30)
            return {'fresh': 2}
        self.assertEqual(rig.audit_with_retry(collect, lambda *event: failures.append(event)), {'fresh': 2})
        self.assertEqual(len(calls), 2)
        self.assertEqual(failures, [(1, {'kind': 'transport-timeout', 'type': 'TimeoutExpired', 'timeout': 30})])

    def test_disappearing_process_preserves_stage_evidence_then_retries(self):
        failures, count = [], []
        details = {'kind': 'process-disappeared', 'stage': 'argv:200', 'nodeId': 'legion1'}
        def collect():
            count.append(1)
            if len(count) == 1: raise rig.AuditTransient(details)
            return []
        self.assertEqual(rig.audit_with_retry(collect, lambda *event: failures.append(event)), [])
        self.assertEqual(failures, [(1, details)])

    def test_second_timeout_fails_without_third_attempt(self):
        failures = []
        def collect(): raise TimeoutError('offline')
        with self.assertRaises(TimeoutError):
            rig.audit_with_retry(collect, lambda *event: failures.append(event))
        self.assertEqual([event[0] for event in failures], [1, 2])

    def test_live_orphan_and_command_failures_are_never_retried(self):
        for error in (AssertionError('unaccounted managed engine'), subprocess.CalledProcessError(1, 'ps'), urllib.error.URLError('connection refused'), rig.AuditTransient({'kind': 'unaccounted-process'})):
            calls, failures = [], []
            def collect():
                calls.append(1); raise error
            with self.subTest(error=error), self.assertRaises(type(error)):
                rig.audit_with_retry(collect, lambda *event: failures.append(event))
            self.assertEqual(len(calls), 1)
            self.assertEqual(failures, [])

    def test_urllib_timeout_is_retryable(self):
        calls = []
        def collect():
            calls.append(1)
            if len(calls) == 1: raise urllib.error.URLError(TimeoutError('timed out'))
            return True
        self.assertTrue(rig.audit_with_retry(collect, lambda *_: None))
        self.assertEqual(len(calls), 2)

    def test_remote_programs_compile_without_execution(self):
        compile(rig.PROCESS_AUDIT, '<process-audit>', 'exec')
        compile(rig.AGENT_SIGNAL, '<agent-signal>', 'exec')


if __name__ == '__main__':
    unittest.main()
