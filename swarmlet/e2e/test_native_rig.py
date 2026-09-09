import importlib.util
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

loader=importlib.util.spec_from_file_location('native_rig',Path(__file__).with_name('native-rig.py'))
m=importlib.util.module_from_spec(loader)
loader.loader.exec_module(m)

class NativeRigTests(unittest.TestCase):
    def document(self):
        common=dict(ctx=1024,parallel=1,chain=0,transport='relay',profile='qwen35-2b-q8')
        return dict(cases=[dict(id='stage2',spec=dict(common,kind='stages',stages=[dict(nodeId=n) for n in ['l1','mac']])),
            dict(id='stage3',spec=dict(common,kind='stages',stages=[dict(nodeId=n) for n in ['l1','l2','mac']])),
            dict(id='pd-forward',spec=dict(common,kind='prefill-decode',prefillNodeId='mac',decodeNodeId='l1')),
            dict(id='pd-reverse',spec=dict(common,kind='prefill-decode',prefillNodeId='l1',decodeNodeId='mac'))])

    def test_requires_four_topologies_and_both_pd_directions(self):
        doc=self.document()
        self.assertEqual(len(m.catalogue(doc)),4)
        doc['cases'].pop()
        with self.assertRaisesRegex(ValueError,'both directions'):m.catalogue(doc)

    def test_rejects_duplicate_nodes_and_unqualified_envelope(self):
        doc=self.document()
        doc['cases'][0]['spec']['stages'][1]['nodeId']='l1'
        with self.assertRaisesRegex(ValueError,'distinct'):m.catalogue(doc)
        doc=self.document()
        doc['cases'][0]['spec']['ctx']=2048
        with self.assertRaisesRegex(ValueError,'ctx1024'):m.catalogue(doc)

    def test_qualified_plan_must_match_order_and_evidence(self):
        case=m.catalogue(self.document())[0]
        plan=dict(ctx=1024,parallel=1,nativeExecution=dict(mode='stages',endpoints=[dict(nodeId=n,binarySha256='a'*64,identity={'schema':1}) for n in case['nodes']],qualificationEvidenceSha256='b'*64))
        self.assertEqual(len(m.verify_plan(case,plan)),2)
        plan['nativeExecution']['endpoints'].reverse()
        with self.assertRaisesRegex(RuntimeError,'ordered'):m.verify_plan(case,plan)
        plan['nativeExecution']['endpoints'].reverse()
        plan['nativeExecution'].pop('qualificationEvidenceSha256')
        with self.assertRaisesRegex(RuntimeError,'evidence'):m.verify_plan(case,plan)

    def test_health_rejects_changed_pid_identity_or_dirty_session(self):
        endpoint=dict(identity={'schema':1},binarySha256='a'*64)
        health=dict(identity={'schema':1},binary_sha256='a'*64,pid=12,n_embd=2048,n_vocab=248320,session='',position=0)
        m.verify_health(endpoint,health,health)
        for change in [dict(pid=13),dict(session='still-live'),dict(position=1),dict(identity={}),dict(binary_sha256='b'*64)]:
            with self.assertRaises(RuntimeError):m.verify_health(endpoint,{**health,**change},health)

    def test_completion_request_has_prompt_and_no_messages(self):
        runner=object.__new__(m.NativeRunner)
        runner.args=SimpleNamespace(control_url='http://localhost')
        runner.token='test'
        dep=dict(id='dep',endpoint=dict(modelName='model'))
        req=runner.request(dep,False,False)
        body=json.loads(req.data)
        self.assertIn('prompt',body)
        self.assertNotIn('messages',body)
        self.assertTrue(req.full_url.endswith('/v1/completions'))
        self.assertEqual(req.get_header('X-swarmlet-deployment'),'dep')

    def test_failed_create_still_retires_and_persists_failed_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            out=Path(temporary)
            config=out/'config.json'
            config.write_text(json.dumps({'adminToken':'test'}))
            args=SimpleNamespace(out=out,config=config,control_url='http://unused',deployment_id='baseline',nodes=['mac','l1','l2'],request_timeout=3,hosts={})
            cases=m.catalogue(self.document())
            runner=m.NativeRunner(args,cases)
            runner.api=Mock(side_effect=RuntimeError('admission rejected'))
            runner.retire=Mock()
            runner.arm(cases[0])
            runner.retire.assert_called_once()
            record=json.loads((out/'cases/stage2/1/result.json').read_text())
            self.assertEqual(record['status'],'fail')
            self.assertIn('admission rejected',record['error'])
            runner.retire=Mock(side_effect=RuntimeError('cleanup pending'))
            with self.assertRaisesRegex(RuntimeError,'cleanup pending'):runner.arm(cases[0])
            record=json.loads((out/'cases/stage2/2/result.json').read_text())
            self.assertEqual(record['cleanupError'],'cleanup pending')

    def test_closed_port_proof_rejects_ssh_timeout_or_http_error(self):
        runner=object.__new__(m.NativeRunner)
        runner.args=SimpleNamespace(nodes=['mac'])
        runner.hosts={'l1':'lotar@host'}
        endpoint=dict(nodeId='l1',port=5001)
        with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=7,stderr='refused')):
            self.assertTrue(runner.health(endpoint,stopped=True)['connectionRefused'])
        for code in [0,22,28,255]:
            with patch.object(m.subprocess,'run',return_value=SimpleNamespace(returncode=code,stderr='error')):
                with self.assertRaises(RuntimeError):runner.health(endpoint,stopped=True)

if __name__=='__main__':unittest.main()
