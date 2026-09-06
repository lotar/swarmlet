import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('matrix',Path(__file__).with_name('mesh-matrix.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Response(io.BytesIO):
    status=200
    headers={'content-type':'text/event-stream'}

class MatrixTests(unittest.TestCase):
    def test_manifest_is_deterministic_and_no_duplicate_configs(self):
        a=m.catalogue();b=m.catalogue()
        self.assertEqual(a,b)
        unique=[x for x in a['arms'] if x['group']!='interleaved-baseline']
        self.assertEqual(len(unique),len({m.digest(x['config']) for x in unique}))
        self.assertEqual([x['group'] for x in a['arms'][:3]],['P0']*3)

    def test_exhaustive_placement_and_orders(self):
        arms=m.catalogue()['arms']
        for transport in ['auto','relay']:
            for worker in [1,2]:
                self.assertEqual({a['config']['layers'] for a in arms if a['config']['workers']==[worker] and a['config']['transport']==transport},set(range(1,24)))
            for order in [[1,2],[2,1]]:
                self.assertEqual({a['config']['layers'] for a in arms if a['config']['workers']==order and a['config']['transport']==transport},set(range(1,12)))
        blocked=next(x for x in m.catalogue()['blocked'] if x['id']=='asymmetric-placement')
        self.assertEqual(len(blocked['configurations']),484)
        self.assertTrue(all(sum(x['layers'])==24 and min(x['layers'])>0 for x in blocked['configurations']))

    def test_stream_handles_null_role_empty_choices_usage_and_done(self):
        data=[{'choices':[{'delta':{'role':'assistant','content':None}}]},
              {'choices':[{'delta':{'content':'OK'},'finish_reason':'stop'}]},
              {'choices':[],'usage':{'completion_tokens':1}}]
        raw=b''.join(b'data: '+json.dumps(d).encode()+b'\n\n' for d in data)+b'data: [DONE]\n\n'
        with patch.object(m.urllib.request,'urlopen',return_value=Response(raw)):
            r=m.stream_request('http://test',{}, {})
        self.assertEqual(r['status'],'pass');self.assertEqual(r['text'],'OK')
        self.assertEqual(r['usage']['completion_tokens'],1);self.assertTrue(r['done'])

    def test_incomplete_stream_is_failure(self):
        raw=b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
        with patch.object(m.urllib.request,'urlopen',return_value=Response(raw)):
            self.assertEqual(m.stream_request('http://test',{}, {})['status'],'fail')

    def test_engine_error_not_counted_as_success(self):
        with patch.object(m.urllib.request,'urlopen',return_value=Response(b'data: {"error":{"message":"OOM"}}\n\n')):
            with self.assertRaisesRegex(RuntimeError,'OOM'):m.stream_request('http://test',{}, {})

    def test_restore_refuses_modified_owned_profile(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);file=root/'matrix-owned-x.json';file.write_text('changed')
            runner=object.__new__(m.Runner);runner.prefix='matrix-owned'
            runner.journal={'profiles':{str(file):'wrong-hash'}};runner.retire=lambda:None
            with patch.object(m,'PROFILES',root):
                with self.assertRaisesRegex(RuntimeError,'modified owned'):runner.restore()
            self.assertTrue(file.exists())

    def test_restore_never_deletes_another_campaign(self):
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/'another.json';file.write_text('keep')
            runner=object.__new__(m.Runner);runner.prefix='matrix-owned'
            runner.journal={'profiles':{str(file):'hash'}};runner.retire=lambda:None
            with self.assertRaisesRegex(RuntimeError,'invalid owned'):runner.restore()
            self.assertTrue(file.exists())

    def test_same_workload_has_identical_inputs_across_arms_and_repeats(self):
        runner=object.__new__(m.Runner);runner.prefix='test-model'
        def api(req, **kwargs):
            data=json.loads(req.data)
            if req.full_url.endswith('/apply-template'):
                return Response(json.dumps({'prompt':json.dumps(data['messages'])}).encode())
            return Response(json.dumps({'tokens':list(range(len(data['content'])))}).encode())
        with patch.object(m.urllib.request,'urlopen',side_effect=api):
            for workload in ['greeting','conversation','longchat','text128','text512','text1024']:
                inputs=[]
                for arm in m.catalogue()['arms'][:3]+[a for a in m.catalogue()['arms'] if a['group']=='interleaved-baseline'][:1]:
                    cfg={**arm['config'],'workload':workload,'ctx':8192}
                    for rep in range(2):
                        body,count=runner.body(cfg,'http://test')
                        inputs.append((m.digest(body['messages']),count))
                        self.assertNotIn(arm['id'],json.dumps(body['messages']))
                        if workload.startswith('text'):
                            self.assertTrue(body['messages'][0]['content'].endswith('Summarize briefly.'))
                            self.assertLessEqual(count,int(workload[4:]))
                self.assertEqual(len(set(inputs)),1)

    def test_atomic_results_are_readable(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'results.json';m.write_json(p,{'a':1});m.write_json(p,{'a':2})
            self.assertEqual(json.loads(p.read_text()),{'a':2})
            self.assertFalse(p.with_suffix('.json.tmp').exists())

if __name__=='__main__':unittest.main()
