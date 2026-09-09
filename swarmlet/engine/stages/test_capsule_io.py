import pathlib, subprocess, sys, tempfile, unittest
HERE=pathlib.Path(__file__).resolve().parent
class CapsuleFilesystem(unittest.TestCase):
 def test_native_filesystem_faults_and_ownership(self):
  with tempfile.TemporaryDirectory() as td:
   binary=pathlib.Path(td)/'capsule-io-test'
   subprocess.run(['c++','-std=c++17',str(HERE/'test_capsule_io.cpp'),'-o',str(binary)],check=True)
   for mode in ['partial','close','preexisting','retry','append']+(['full'] if sys.platform=='linux' else []):
    with self.subTest(mode=mode),tempfile.TemporaryDirectory() as fixture:
     subprocess.run([str(binary),fixture,mode],check=True)
if __name__=='__main__':unittest.main()
