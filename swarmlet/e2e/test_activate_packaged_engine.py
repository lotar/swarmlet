import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('activate_packaged_engine', Path(__file__).with_name('activate-packaged-engine.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackagedEngineActivation(unittest.TestCase):
    def fixture(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        engine = root / 'package engine'
        engine.mkdir()
        lines = []
        for name in sorted(module.REQUIRED_BINARIES):
            data = ('packaged ' + name).encode()
            binary = engine / name
            binary.write_bytes(data)
            binary.chmod(0o755)
            lines.append(hashlib.sha256(data).hexdigest() + '  ' + name)
        (engine / 'sha256.txt').write_text('\n'.join(lines) + '\n')
        original = dict(enginePath=str(root / 'old-engine'), offer=dict(modelsDir='/models', roles=dict(worker=True, replica=False)),
                        enrolledNodeId='existing-node', controlUrl='https://control', externals=[dict(name='existing')])
        config = root / 'node.json'
        config.write_text(json.dumps(original))
        ownership = root / 'assignments.json'
        ownership.write_text('[]')
        return root, engine, config, ownership, original

    def test_stale_engine_path_is_activated_without_changing_other_settings(self):
        root, engine, config, ownership, original = self.fixture()
        before = config.read_bytes()
        self.assertFalse((Path(original['enginePath']) / 'mesh-stage-worker').exists())
        result = module.activate_packaged_engine(config, engine, root / 'backup', ownership)
        self.assertEqual(json.loads(config.read_text()), dict(original, enginePath=str(engine.resolve())))
        self.assertTrue((Path(json.loads(config.read_text())['enginePath']) / 'mesh-stage-worker').is_file())
        self.assertEqual((root / 'backup/node-before.json').read_bytes(), before)
        self.assertEqual(result['previousEnginePath'], original['enginePath'])
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertEqual((root / 'backup').stat().st_mode & 0o777, 0o700)
        for file in (root / 'backup').iterdir():self.assertEqual(file.stat().st_mode & 0o777, 0o600)

    def test_checksum_failure_before_activation_preserves_config_and_does_not_create_backup(self):
        root, engine, config, ownership, _ = self.fixture()
        before = config.read_bytes()
        (engine / 'llama-server').write_text('corrupt')
        with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
            module.activate_packaged_engine(config, engine, root / 'backup', ownership)
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse((root / 'backup').exists())

    def test_missing_native_manifest_entry_and_traversal_or_duplicate_entries_reject(self):
        root, engine, config, ownership, _ = self.fixture()
        manifest = engine / 'sha256.txt'
        original = manifest.read_text()
        for invalid in ['\n'.join(line for line in original.splitlines() if not line.endswith('mesh-stage-worker')),
                        original + 'a' * 64 + '  ../escape\n', original + original.splitlines()[0] + '\n']:
            manifest.write_text(invalid)
            with self.assertRaises(RuntimeError):module.activate_packaged_engine(config, engine, root / 'backup', ownership)
            self.assertFalse((root / 'backup').exists())

    def test_active_ownership_or_non_executable_binary_reject_before_config_write(self):
        root, engine, config, ownership, _ = self.fixture()
        ownership.write_text('[{"pid":123}]')
        with self.assertRaisesRegex(RuntimeError, 'ownership'):module.activate_packaged_engine(config, engine, root / 'backup', ownership)
        ownership.write_text('[]')
        (engine / 'mesh-stage-worker').chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'not executable'):module.activate_packaged_engine(config, engine, root / 'backup', ownership)

    def test_concurrent_config_change_is_preserved_and_original_backup_remains(self):
        root, engine, config, ownership, original = self.fixture()
        before = config.read_bytes()
        fsync = module.os.fsync
        def change(descriptor):
            fsync(descriptor)
            config.write_text(json.dumps(dict(original, controlUrl='https://changed')))
        with patch.object(module.os, 'fsync', side_effect=change):
            with self.assertRaisesRegex(RuntimeError, 'config changed'):module.activate_packaged_engine(config, engine, root / 'backup', ownership)
        self.assertEqual(json.loads(config.read_text())['controlUrl'], 'https://changed')
        self.assertEqual((root / 'backup/node-before.json').read_bytes(), before)
        self.assertEqual(list(root.glob('.node-engine-*')), [])

    def test_atomic_replace_failure_leaves_original_configuration_intact(self):
        root, engine, config, ownership, _ = self.fixture()
        before = config.read_bytes()
        with patch.object(module.os, 'replace', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):module.activate_packaged_engine(config, engine, root / 'backup', ownership)
        self.assertEqual(config.read_bytes(), before)
        self.assertEqual(list(root.glob('.node-engine-*')), [])

    def test_stopped_service_requires_inactive_state_and_no_main_pid(self):
        for output in ['ActiveState=inactive\nMainPID=0\n', 'ActiveState=failed\nMainPID=0\n']:
            with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout=output)):
                module.require_stopped_service('swarmlet-node.service')
        for output in ['ActiveState=active\nMainPID=1\n', 'ActiveState=deactivating\nMainPID=0\n', 'ActiveState=inactive\nMainPID=42\n', '']:
            with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(stdout=output)):
                with self.assertRaises(RuntimeError):module.require_stopped_service('swarmlet-node.service')


if __name__ == '__main__':unittest.main()
