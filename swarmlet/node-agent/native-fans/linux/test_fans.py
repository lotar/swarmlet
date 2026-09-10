"""Recovery tests use a temporary fake hwmon tree; never touch real hardware."""
import importlib.machinery
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('fans', str(pathlib.Path(__file__).with_name('swarmlet-fans')))
spec = importlib.util.spec_from_loader(loader.name, loader)
fans = importlib.util.module_from_spec(spec)
loader.exec_module(fans)

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        fans.ROOT = root / 'hwmon'
        fans.JOURNAL = root / 'state.json'
        fans.BOOT = root / 'boot'
        fans.BOOT.write_text('boot-one')
        self.device(0, 77, 2)
        self.trust = patch.object(fans, 'trusted')
        self.trust.start()
    def tearDown(self):
        self.trust.stop()
        self.tmp.cleanup()
    def device(self, number, value, mode):
        dev = fans.ROOT / ('hwmon'+str(number))
        dev.mkdir(parents=True)
        (dev/'name').write_text('test-driver')
        (dev/'pwm1').write_text(str(value))
        (dev/'pwm1_enable').write_text(str(mode))
        return dev
    def setting(self, number):
        dev = fans.ROOT / ('hwmon'+str(number))
        return fans.integer(dev/'pwm1'), fans.integer(dev/'pwm1_enable')
    def test_repeat_and_hotplug_preserve_originals(self):
        fans.change('max')
        self.assertEqual(self.setting(0), (255, 1))
        self.device(1, 99, 1)
        fans.change('max')
        fans.change('auto')
        self.assertEqual(self.setting(0), (77, 2))
        self.assertEqual(self.setting(1), (99, 1))
        self.assertFalse(fans.JOURNAL.exists())
    def test_reboot_discards_stale_settings(self):
        fans.change('max')
        fans.BOOT.write_text('boot-two')
        (fans.ROOT/'hwmon0'/'pwm1').write_text('100')
        (fans.ROOT/'hwmon0'/'pwm1_enable').write_text('2')
        fans.change('max')
        fans.change('auto')
        self.assertEqual(self.setting(0), (100, 2))
    def test_replaced_driver_is_not_restored(self):
        fans.change('max')
        (fans.ROOT/'hwmon0'/'name').write_text('other-driver')
        fans.change('auto')
        self.assertEqual(self.setting(0), (255, 1))
    def test_invalid_journal_refuses_writes(self):
        fans.JOURNAL.write_text('{"boot":"boot-one","rows":[{"path":"/etc/passwd"}]}')
        with self.assertRaisesRegex(RuntimeError, 'Invalid saved'): fans.change('max')
        self.assertEqual(self.setting(0), (77, 2))
    def test_failed_max_restores_all_controls(self):
        self.device(1, 99, 2)
        original = pathlib.Path.write_text
        failed = False
        def write(path, value, *args, **kwargs):
            nonlocal failed
            if path == (fans.ROOT/'hwmon1'/'pwm1_enable').resolve() and value == '1' and not failed:
                failed = True
                raise OSError('simulated write failure')
            return original(path, value, *args, **kwargs)
        with patch.object(pathlib.Path, 'write_text', write):
            with self.assertRaisesRegex(OSError, 'simulated'): fans.change('max')
        self.assertEqual(self.setting(0), (77, 2))
        self.assertEqual(self.setting(1), (99, 2))
    def test_symlink_is_rejected(self):
        self.trust.stop()
        fans.JOURNAL.symlink_to(fans.BOOT)
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'): fans.saved_rows()
    def test_no_controls_is_explicit(self):
        (fans.ROOT/'hwmon0'/'pwm1_enable').unlink()
        with self.assertRaisesRegex(RuntimeError, 'No standard'): fans.change('max')

if __name__ == '__main__': unittest.main()
