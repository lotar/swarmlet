import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

loader = importlib.util.spec_from_file_location('speculation_rig',Path(__file__).with_name('speculation-rig.py'))
module = importlib.util.module_from_spec(loader)
loader.loader.exec_module(module)


class SpeculationRigTests(unittest.TestCase):
    def runner(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        out = Path(temp.name)
        config = out/'config.json'
        config.write_text(json.dumps({'adminToken':'fake'}))
        model = out/'model.gguf'
        model.write_bytes(b'test model fixture')
        args = SimpleNamespace(out=out,config=config,control_url='http://unused',deployment_id='baseline',nodes=['mac','l1','l2'],request_timeout=3)
        runner = module.SpeculationRunner(args,module.catalogue(args.nodes))
        return runner,model

    def prepare(self,runner,model,events):
        specs = {}
        def api(path,method='GET',body=None,timeout=30):
            if path=='/api/deployments':
                ident = 'target' if not specs else 'ngram'
                specs[ident] = body
                events.append('create-'+ident)
                return {'id':ident}
            return {'ok':True}
        def ready(ident):
            s = specs[ident]
            assignment = dict(id='as-'+ident,body=dict(kind=s['kind'],model={'path':str(model)},speculation=s.get('speculation')))
            return dict(id=ident,plan={'speculation':s.get('speculation')},assignments=[assignment],endpoint={'nodeId':'mac','modelName':'same-model','port':5001})
        runner.api = Mock(side_effect=api)
        runner.ready = Mock(side_effect=ready)
        runner.collect_evidence = Mock()
        runner.retire = Mock(side_effect=lambda:events.append('retire'))
        def collect(args):
            events.append('collect-'+args.arm.split('-')[-1])
            Path(args.output).write_text('{}')
        def stream(url,headers,body,timeout):
            ident = headers['x-swarmlet-deployment']
            events.append('route-'+ident)
            return dict(status='pass',text='animals',done=True,routeHeaders={'x-swarmlet-deployment':ident,'x-swarmlet-node':'mac'})
        return collect,stream

    def test_catalogue_has_fresh_target_ngram_pairs_for_both_topologies(self):
        cases = module.catalogue(['mac','l1','l2'])
        self.assertEqual([c['id'] for c in cases],['mac-replica','mac-split'])
        for case in cases:
            baseline,candidate = case['specs']
            self.assertNotIn('speculation',baseline)
            self.assertEqual(candidate,{**baseline,'speculation':{'type':'ngram-simple'}})
            self.assertEqual((baseline['ctx'],baseline['parallel']),(1024,1))
        self.assertEqual(cases[1]['tensorSplit'],[2,3,19])
        self.assertEqual(cases[1]['specs'][0]['workerLayers'],[2,3])

    def test_collect_is_serial_before_routed_smoke_and_every_mode_is_retired(self):
        runner,model = self.runner()
        events = []
        collect,stream = self.prepare(runner,model,events)
        with patch.object(module.qualify,'collect',side_effect=collect),patch.object(module.matrix,'stream_request',side_effect=stream),patch.object(module,'compare_to_file',return_value={'gates':{'parity':True}}):
            runner.arm(runner.manifest['arms'][0])
        self.assertEqual(events,['create-target','collect-target','route-target','retire','create-ngram','collect-ngram','route-ngram','retire'])
        record = runner.results['mac-replica']
        self.assertEqual(record['status'],'pass')
        self.assertEqual(len(record['modes']),2)
        self.assertEqual(record['modes'][0]['model']['sha256'],record['modes'][1]['model']['sha256'])
        self.assertIn('swarmlet/e2e/speculation-rig.py',record['codeSha256'])

    def test_collect_error_preserves_failure_and_retirement_without_routed_request(self):
        runner,model = self.runner()
        events=[]
        _,stream = self.prepare(runner,model,events)
        with patch.object(module.qualify,'collect',side_effect=RuntimeError('missing native counters')),patch.object(module.matrix,'stream_request',side_effect=stream) as request:
            runner.arm(runner.manifest['arms'][0])
        self.assertEqual(runner.results['mac-replica']['status'],'fail')
        self.assertIn('missing native counters',runner.results['mac-replica']['error'])
        runner.retire.assert_called_once()
        request.assert_not_called()

    def test_comparator_nonzero_is_persisted_and_raised(self):
        runner,_ = self.runner()
        output = runner.out/'comparison.json'
        def compare(args):
            print(json.dumps({'gates':{'tokenAndTextParity':False,'draftedAndAccepted':True}}))
            return 1
        with patch.object(module.qualify,'compare',side_effect=compare):
            with self.assertRaisesRegex(RuntimeError,'comparison gates failed'):
                module.compare_to_file('target.json','ngram.json',output)
        self.assertFalse(json.loads(output.read_text())['gates']['tokenAndTextParity'])

    def test_comparator_exception_is_persisted_and_not_converted_to_pass(self):
        runner,_ = self.runner()
        output = runner.out/'comparison.json'
        with patch.object(module.qualify,'compare',side_effect=RuntimeError('invalid speculative counters')):
            with self.assertRaisesRegex(RuntimeError,'invalid speculative counters'):
                module.compare_to_file('target.json','ngram.json',output)
        self.assertIn('invalid speculative counters',json.loads(output.read_text())['error'])

    def test_remote_endpoint_refused_before_native_collection(self):
        runner,model = self.runner()
        events=[]
        self.prepare(runner,model,events)
        runner.ready = Mock(return_value={'id':'target','endpoint':{'nodeId':'l1'}})
        with patch.object(module.qualify,'collect') as collect:
            runner.arm(runner.manifest['arms'][0])
        self.assertIn('not on the local Mac',runner.results['mac-replica']['error'])
        collect.assert_not_called()
        runner.retire.assert_called_once()

    def test_attempt_directories_preserve_previous_evidence(self):
        runner,_ = self.runner()
        runner.api = Mock(side_effect=RuntimeError('create refused'))
        runner.retire = Mock()
        case = runner.manifest['arms'][0]
        runner.arm(case)
        first = runner.out/runner.results[case['id']]['artifactDirectory']
        (first/'target.json').write_text('prior evidence')
        runner.arm(case)
        second = runner.out/runner.results[case['id']]['artifactDirectory']
        self.assertNotEqual(first,second)
        self.assertEqual((first/'target.json').read_text(),'prior evidence')
        self.assertTrue((second/'previous-result.json').exists())

    def test_interrupt_retires_mode_and_marks_case_failed(self):
        runner,_ = self.runner()
        runner.api = Mock(side_effect=KeyboardInterrupt)
        runner.retire = Mock()
        with self.assertRaises(KeyboardInterrupt):
            runner.arm(runner.manifest['arms'][0])
        self.assertTrue(runner.results['mac-replica']['interrupted'])
        self.assertEqual(runner.results['mac-replica']['status'],'fail')
        runner.retire.assert_called_once()

    def test_unacknowledged_retirement_aborts_campaign_instead_of_loading_next_mode(self):
        runner,model = self.runner()
        events=[]
        collect,stream = self.prepare(runner,model,events)
        runner.retire = Mock(side_effect=RuntimeError('cleanup pending acknowledgement'))
        with patch.object(module.qualify,'collect',side_effect=collect),patch.object(module.matrix,'stream_request',side_effect=stream):
            with self.assertRaisesRegex(RuntimeError,'cleanup pending acknowledgement'):
                runner.arm(runner.manifest['arms'][0])
        self.assertNotIn('create-ngram',events)
        record = runner.results['mac-replica']
        self.assertEqual(record['status'],'fail')
        self.assertIn('cleanup pending acknowledgement',record['cleanupError'])


if __name__=='__main__':
    unittest.main()
