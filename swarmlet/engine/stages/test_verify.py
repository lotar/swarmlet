import importlib.util, pathlib, types, unittest
spec=importlib.util.spec_from_file_location('verify',pathlib.Path(__file__).with_name('verify.py'));verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)
class Bounds(unittest.TestCase):
 def test_continuation_must_be_positive_and_bounded(self):
  for n in [-1,0,129]:
   with self.assertRaises(ValueError):verify.validate_args(types.SimpleNamespace(tokens=n,ctx=256))
  verify.validate_args(types.SimpleNamespace(tokens=8,ctx=256))
 def test_context_bound(self):
  with self.assertRaises(ValueError):verify.validate_args(types.SimpleNamespace(tokens=8,ctx=0))
 def test_float_proof_requires_finite_outputs(self):
  stats={};verify.close_float([1.,2.],[1.,2.],'finite',stats)
  self.assertEqual(stats['max_abs'],0)
  for bad in [float('nan'),float('inf'),-float('inf')]:
   for actual,expected in [([bad],[bad]),([bad],[1.]),([1.],[bad])]:
    with self.assertRaisesRegex(AssertionError,'nonfinite'):verify.close_float(actual,expected,'bad',{})
if __name__=='__main__':unittest.main()
