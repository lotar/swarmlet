import importlib.util
from pathlib import Path
import signal
import unittest

spec = importlib.util.spec_from_file_location("refresh_rig", Path(__file__).with_name("refresh-rig.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RefreshPreconditions(unittest.TestCase):
    def test_legacy_ownership_must_be_empty_before_upgrade(self):
        module.require_empty_ownership('[]')
        for text in ['[{"pid":123}]', '{}', 'bad json']:
            with self.assertRaises((RuntimeError, ValueError)):
                module.require_empty_ownership(text)

    def test_term_unwinds_finally_instead_of_terminating_python(self):
        old = signal.signal(signal.SIGTERM, module.interrupt_refresh)
        restored = []
        try:
            with self.assertRaises(KeyboardInterrupt):
                try:
                    signal.raise_signal(signal.SIGTERM)
                finally:
                    restored.append('restore services')
            self.assertEqual(restored, ['restore services'])
        finally:
            signal.signal(signal.SIGTERM, old)


if __name__ == '__main__':
    unittest.main()
