import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("idle_window", Path(__file__).with_name("idle-window.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IdleGateTests(unittest.TestCase):
    def metrics(self, active=0, queued=0, routed=0, tokens=10):
        return dict(requests_processing=active, requests_deferred=queued, router_inflight=routed, tokens_predicted_total=tokens)

    def test_needs_continuous_quiet_and_zero_queue(self):
        gate = module.QuietGate(60)
        self.assertFalse(gate.observe(self.metrics(), 0))
        self.assertFalse(gate.observe(self.metrics(), 59))
        self.assertTrue(gate.observe(self.metrics(), 60))
        self.assertFalse(gate.observe(self.metrics(queued=1), 61))
        self.assertFalse(gate.observe(self.metrics(), 62))
        self.assertFalse(gate.observe(self.metrics(), 121))
        self.assertTrue(gate.observe(self.metrics(), 122))

    def test_any_activity_or_counter_change_resets(self):
        for changed in [self.metrics(active=1), self.metrics(routed=1), self.metrics(tokens=11), self.metrics(tokens=0)]:
            gate = module.QuietGate(60)
            gate.observe(self.metrics(), 0)
            self.assertFalse(gate.observe(changed, 60))

    def test_unknown_resets_previous_idle(self):
        gate = module.QuietGate(60)
        gate.observe(self.metrics(), 0)
        gate.reset()
        self.assertFalse(gate.observe(self.metrics(), 100))

    def test_missing_metrics_fail_closed(self):
        with self.assertRaises(ValueError):
            module.parse_metrics("llamacpp:requests_processing 0\n")
        result = module.parse_metrics("llamacpp:requests_processing 0\nllamacpp:requests_deferred 0\nllamacpp:tokens_predicted_total 12\n")
        self.assertEqual(result["tokens_predicted_total"], 12)

    def test_failed_operator_still_restores_and_checks_production(self):
        commands = []
        def run(script, action):
            commands.append(action)
            return 0
        child = Mock()
        child.wait.return_value = 7
        child.poll.return_value = 7
        with patch.object(module.sys, "argv", ["idle-window.py", "--", "false"]), \
             patch.object(module, "sample", return_value=self.metrics()), \
             patch.object(module.QuietGate, "observe", return_value=True), \
             patch.object(module.signal, "signal"), \
             patch.object(module, "run_maintenance", side_effect=run), \
             patch.object(module.subprocess, "Popen", return_value=child):
            self.assertEqual(module.main(), 7)
        self.assertEqual(commands, ["stop", "start", "check-only"])

    def test_explicit_stopped_mode_preserves_stopped_production(self):
        child=Mock();child.wait.return_value=2;child.poll.return_value=2
        with patch.object(module.sys,'argv',['idle-window.py','--allow-stopped','--','true']), \
             patch.object(module,'stopped_sample',return_value=self.metrics()), \
             patch.object(module.QuietGate,'observe',return_value=True), \
             patch.object(module.signal,'signal'), \
             patch.object(module,'run_maintenance') as maintenance, \
             patch.object(module.subprocess,'Popen',return_value=child):
            self.assertEqual(module.main(),2)
            maintenance.assert_not_called()

    def test_stopped_mode_rejects_loaded_owner_or_listener(self):
        with patch.object(module.subprocess,'run',return_value=Mock(returncode=0)):
            with self.assertRaisesRegex(ValueError,'owner'):
                module.stopped_sample(Path('/unused'))
        with patch.object(module.subprocess,'run',return_value=Mock(returncode=113,stderr='Could not find service')), \
             patch.object(module.socket,'create_connection',return_value=Mock()):
            with self.assertRaisesRegex(ValueError,'listener'):
                module.stopped_sample(Path('/unused'))

    def test_hosted_url_keeps_authenticated_routing_check(self):
        config = Mock()
        config.read_text.return_value = '{"adminToken":"fixture-secret"}'
        with patch.object(module.subprocess, 'run', return_value=Mock(returncode=113, stderr='Could not find service')), \
             patch.object(module.socket, 'create_connection', side_effect=ConnectionRefusedError), \
             patch.object(module, 'read_json', return_value={'totals': {'inflight': 2}}) as read:
            result = module.stopped_sample(config, 'https://app.swarmlet.ai/')
            read.assert_called_once_with('https://app.swarmlet.ai/api/routing', {'Authorization': 'Bearer fixture-secret'})
            self.assertEqual(result['router_inflight'], 2)
            self.assertFalse(module.QuietGate(0).observe(result, 0))

    def test_hosted_cli_passes_url_to_read_only_check(self):
        with patch.object(module.sys, 'argv', ['idle-window.py', '--allow-stopped', '--check', '--control-url', 'https://app.swarmlet.ai']), \
             patch.object(module, 'stopped_sample', return_value=self.metrics()) as sample, \
             patch.object(module.signal, 'signal'):
            self.assertEqual(module.main(), 0)
            self.assertEqual(sample.call_args.args[1], 'https://app.swarmlet.ai')

    def test_interrupted_stop_attempt_restores(self):
        commands = []
        def run(script, action):
            commands.append(action)
            if action == "stop":
                raise KeyboardInterrupt()
            return 0
        with patch.object(module.sys, "argv", ["idle-window.py", "--", "true"]), \
             patch.object(module, "sample", return_value=self.metrics()), \
             patch.object(module.QuietGate, "observe", return_value=True), \
             patch.object(module.signal, "signal"), \
             patch.object(module, "run_maintenance", side_effect=run), \
             patch.object(module.subprocess, "Popen") as spawn:
            self.assertEqual(module.main(), 130)
            spawn.assert_not_called()
        self.assertEqual(commands, ["stop", "start", "check-only"])


if __name__ == "__main__":
    unittest.main()
