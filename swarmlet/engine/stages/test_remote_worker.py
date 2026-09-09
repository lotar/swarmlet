import json, os, pathlib, signal, subprocess, sys, tempfile, time, unittest

HERE = pathlib.Path(__file__).resolve().parent

class RemoteOwnership(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'remote supervisor uses Linux /proc identity')
    def test_eof_and_term_retire_only_owned_worker(self):
        for mode in ['eof', 'term']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as td:
                root = pathlib.Path(td)
                fake = root / 'fake-worker'
                fake.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(120)\n')
                fake.chmod(0o700)
                run = root / 'run'
                process = subprocess.Popen([sys.executable, str(HERE / 'remote_worker.py'), str(fake), 'model', 'sha', str(run), '0', '0', '64'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    ownership = json.loads(process.stdout.readline())
                    if mode == 'eof': process.stdin.close()
                    else: process.send_signal(signal.SIGTERM)
                    process.wait(timeout=20)
                    state = json.loads((run / 'ownership.json').read_text())
                    self.assertEqual(ownership['pid'], state['pid'])
                    self.assertGreater(state['stopped_at'], state['started_at'])
                    self.assertIsNotNone(state['returncode'])
                    with self.assertRaises(ProcessLookupError): os.kill(state['pid'], 0)
                finally:
                    if process.poll() is None: process.kill(); process.wait()
                    for stream in [process.stdin, process.stdout, process.stderr]: stream.close()

if __name__ == '__main__': unittest.main()
