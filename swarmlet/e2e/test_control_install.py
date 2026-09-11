"""Exercise the real installer text with all service/network commands confined to shims."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest


class ControllerInstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="swarmlet-install-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.plist = self.root / 'control.plist'
        self.calls = self.root / 'service-calls'
        self.script = self.root / 'A&B <checkout>' / 'install-launchd.sh'
        self.script.parent.mkdir()
        source = (Path(__file__).parents[1] / 'control/install-launchd.sh').read_text()
        # Confinement only: never write to the actual account's LaunchAgents directory.
        source = source.replace('PLIST=$HOME/Library/LaunchAgents/$LABEL.plist', 'PLIST="$INSTALL_TEST_PLIST"')
        source = source.replace('"$HOME/Library/LaunchAgents"', '"$INSTALL_TEST_AGENTS"')
        self.script.write_text(source)
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        INSTALL_TEST_PLIST=str(self.plist), INSTALL_TEST_AGENTS=str(self.root / 'agents'),
                        INSTALL_TEST_CALLS=str(self.calls), INSTALL_TEST_HEALTH='0',
                        SWARMLET_CONTROL_DIR=str(self.root / 'A&B <data> "quoted"'),
                        SWARMLET_CONTROL_HOST='127.0.0.1', SWARMLET_CONTROL_URL='http://127.0.0.1:47900')
        for name, body in {
            'launchctl': 'echo "$*" >> "$INSTALL_TEST_CALLS"\nexit 0',
            'curl': 'exit "$INSTALL_TEST_HEALTH"',
            'sleep': 'exit 0',
            'bun': 'exit 0',
        }.items():
            self.shim(name, '#!/bin/sh\n' + body + '\n')
        self.shim('plutil', '#!' + sys.executable + '\nimport os, plistlib, sys\n'
                  'if os.environ.get("INSTALL_TEST_REJECT_PLIST"): sys.exit(1)\n'
                  'with open(sys.argv[-1], "rb") as stream: plistlib.load(stream)\n')

    def shim(self, name, contents):
        path = self.bin / name
        path.write_text(contents)
        path.chmod(0o755)

    def run_installer(self):
        return subprocess.run(['/bin/bash', str(self.script)], env=self.env, text=True,
                              capture_output=True, timeout=10)

    def test_success_serializes_custom_paths(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('installed ai.swarmlet.control', result.stdout)
        plist = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(plist['EnvironmentVariables']['SWARMLET_CONTROL_DIR'], self.env['SWARMLET_CONTROL_DIR'])
        self.assertEqual(plist['WorkingDirectory'], str(self.script.parent.parent))
        self.assertIn('bootstrap', self.calls.read_text())

    def test_exhausted_health_checks_fail_instead_of_reporting_installed(self):
        self.env['INSTALL_TEST_HEALTH'] = '22'
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('installed ai.swarmlet.control', result.stdout)
        self.assertIn('control health check failed', result.stderr)

    def test_invalid_replacement_preserves_previous_plist_and_loaded_service(self):
        old = plistlib.dumps({'Label': 'old-service'})
        self.plist.write_bytes(old)
        self.env['INSTALL_TEST_REJECT_PLIST'] = '1'
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.plist.read_bytes(), old)
        self.assertFalse(self.calls.exists())
        self.assertEqual(list(self.root.glob('control.plist.*')), [])


if __name__ == '__main__':
    unittest.main()
