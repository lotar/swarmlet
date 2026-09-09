import importlib.util, json, pathlib, sys, tempfile, unittest
import numpy as np
HERE=pathlib.Path(__file__).resolve().parent
ENGINE=HERE.parent/'.build/llama.cpp-stages'
sys.path.insert(0,str(ENGINE/'gguf-py'))
import gguf
spec=importlib.util.spec_from_file_location('extract',HERE/'extract.py');extract=importlib.util.module_from_spec(spec);spec.loader.exec_module(extract)

class Shards(unittest.TestCase):
 def fixture(self,root,arch='qwen35'):
  p=root/'source.gguf';w=gguf.GGUFWriter(p,arch);w.add_uint32('qwen35.block_count',8);w.add_uint32('qwen35.attention.full_attention_interval',4)
  for name in ['token_embd.weight','output_norm.weight','output.weight']+[f'blk.{i}.test.weight' for i in range(8)]:w.add_tensor(name,np.arange(16,dtype=np.float32).reshape(4,4))
  w.write_header_to_file();w.write_kv_data_to_file();w.write_tensors_to_file();w.close();return p
 def test_exact_partition_and_recurrence(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);src=self.fixture(root);rows=extract.extract(src,root/'out',[0,3,6,8],ENGINE)
   expected=[[True,True,True],[False,True,True],[True,False]]
   for i,row in enumerate(rows):
    r=gguf.GGUFReader(row['path']);self.assertEqual(r.get_field('qwen35.attention.recurrent_layers').contents(),expected[i]);names={t.name for t in r.tensors};self.assertEqual(len([n for n in names if n.startswith('blk.')]),row['end']-row['start'])
    self.assertEqual('token_embd.weight' in names,i==0);self.assertEqual('output.weight' in names,i==2)
    for t in r.tensors:np.testing.assert_array_equal(t.data,np.arange(16,dtype=np.float32).reshape(4,4))
   self.assertEqual(rows[0]['source_sha256'],extract.digest(src))
 def test_invalid_partitions(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);src=self.fixture(root)
   for cuts in [[1,8],[0,3,7],[0,4,4,8],[0,9,8]]:
    with self.assertRaises(ValueError):extract.extract(src,root/'out',cuts,ENGINE)
 def test_reject_other_architecture(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);src=self.fixture(root,'llama')
   with self.assertRaises(ValueError):extract.extract(src,root/'out',[0,8],ENGINE)
if __name__=='__main__':unittest.main()
