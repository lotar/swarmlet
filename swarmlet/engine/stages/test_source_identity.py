import importlib.util, pathlib, subprocess, tempfile, unittest
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('source_identity',HERE/'source_identity.py');identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
class SourceIdentity(unittest.TestCase):
 def test_dirty_and_untracked_sources_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);src=root/'src';src.mkdir()
   def git(*a):return subprocess.check_output(['git','-C',str(src),*a],stderr=subprocess.DEVNULL)
   git('init');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid')
   (src/'engine.cpp').write_text('base\n');git('add','engine.cpp');git('commit','-m','fixture');ref=git('rev-parse','HEAD').decode().strip()
   (src/'engine.cpp').write_text('overlay\n');patch=root/'overlay.patch';patch.write_bytes(git('-c','core.abbrev=7','-c','diff.algorithm=myers','diff','--no-ext-diff','--no-color','--binary','HEAD'))
   self.assertTrue(identity.verify_source(src,patch,ref))
   (src/'engine.cpp').write_text('unreviewed\n')
   with self.assertRaisesRegex(RuntimeError,'exact stage overlay'):identity.verify_source(src,patch,ref)
   (src/'engine.cpp').write_text('overlay\n');(src/'extra.cpp').write_text('unreviewed')
   with self.assertRaisesRegex(RuntimeError,'untracked engine'):identity.verify_source(src,patch,ref)
   with self.assertRaisesRegex(RuntimeError,'revision mismatch'):identity.verify_source(src,patch,'0'*40)
if __name__=='__main__':unittest.main()
