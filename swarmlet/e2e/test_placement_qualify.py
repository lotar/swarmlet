import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

loader = importlib.util.spec_from_file_location('placement_qualify',Path(__file__).with_name('placement-qualify.py'))
module = importlib.util.module_from_spec(loader)
loader.loader.exec_module(module)


class PlacementTests(unittest.TestCase):
    def allocation_fixture(self,logical=None):
        logical = logical or [2,3,19]
        weights = [*logical[:-1],logical[-1]+1]
        assignment = dict(id='coord',body=dict(kind='coordinator',tensorSplit=weights,devices=['RPC0','RPC1','MTL0'],model={'path':'actual.gguf'},extraArgs=['-fa','on']))
        deployment = dict(plan={'engineTensorSplit':weights},assignments=[assignment])
        evidence = dict(controlLogs={'coord':{'lines':['print_info: n_layer_all = 24','load_tensors: offloaded 25/25 layers to GPU']}})
        return deployment,evidence

    def test_allocation_proof_uses_native_metadata_and_float32_output_slot(self):
        for logical in [[2,3,19],[3,2,19]]:
            deployment,evidence = self.allocation_fixture(logical)
            proof = module.allocation_proof(deployment,evidence,logical)
            self.assertEqual(proof['transformerBlocks'],logical)
            self.assertEqual(proof['engineWeights'],[*logical[:-1],20])
            self.assertEqual(proof['mode'],'derived-from-assignment-and-native-metadata')
            self.assertEqual(proof['nLayerAll'],24)
        deployment,evidence = self.allocation_fixture()
        deployment['assignments'][0]['body']['tensorSplit'] = [2,3,19]
        with self.assertRaisesRegex(RuntimeError,'actual coordinator assignment tensor weights'):
            module.allocation_proof(deployment,evidence,[2,3,19])

    def test_allocation_proof_rejects_missing_metadata_partial_offload_and_overrides(self):
        for lines in [[],['print_info: n_layer_all = 23','load_tensors: offloaded 25/25 layers to GPU'],
                      ['print_info: n_layer_all = 24','load_tensors: offloaded 24/25 layers to GPU']]:
            deployment,evidence = self.allocation_fixture()
            evidence['controlLogs']['coord']['lines'] = lines
            with self.assertRaises(RuntimeError):
                module.allocation_proof(deployment,evidence,[2,3,19])
        deployment,evidence = self.allocation_fixture()
        deployment['plan'].pop('engineTensorSplit')
        with self.assertRaisesRegex(RuntimeError,'lacks corrected'):
            module.allocation_proof(deployment,evidence,[2,3,19])
        deployment,evidence = self.allocation_fixture()
        deployment['assignments'][0]['body']['extraArgs'] = ['-ngl','3']
        with self.assertRaisesRegex(RuntimeError,'overrides native placement'):
            module.allocation_proof(deployment,evidence,[2,3,19])

    def test_allocation_proof_verifies_native_debug_mapping_when_present(self):
        deployment,evidence = self.allocation_fixture()
        devices = ['RPC0']*2+['RPC1']*3+['MTL0']*20
        lines = evidence['controlLogs']['coord']['lines']
        lines += [f'load_tensors: layer {i:3} assigned to device {device}, is_swa = 0' for i,device in enumerate(devices)]
        proof = module.allocation_proof(deployment,evidence,[2,3,19])
        self.assertEqual(proof['mode'],'observed-native-per-layer-log')
        lines[-1] = 'load_tensors: layer 24 assigned to device RPC1, is_swa = 0'
        with self.assertRaisesRegex(RuntimeError,'native per-layer allocation differs'):
            module.allocation_proof(deployment,evidence,[2,3,19])

    def runner(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        out = Path(directory.name)
        config = out/'config.json'
        config.write_text(json.dumps({'adminToken':'test-only'}))
        args = SimpleNamespace(out=out,config=config,control_url='http://unused',deployment_id='baseline',nodes=['mac','l1','l2'],request_timeout=5)
        return module.PlacementRunner(args,module.catalogue(args.nodes))

    def response(self,dep='a',node='l1',**over):
        return dict(status='pass',text='an animal',done=True,routeHeaders={'X-Swarmlet-Deployment':dep,'X-Swarmlet-Node':node},**over)

    def test_catalogue_has_all_ten_cases_with_no_duplicate_singletons(self):
        cases = module.catalogue(['mac','l1','l2'])
        self.assertEqual(len(cases),10)
        pools = [c for c in cases if c['specs'][0]['kind']=='replica']
        self.assertEqual([c['nodes'] for c in pools],[['l1'],['l2'],['mac','l1'],['mac','l2'],['l1','l2'],['mac','l1','l2']])
        self.assertEqual(cases[0]['tensorSplit'],[2,3,19])
        self.assertEqual(cases[1]['tensorSplit'],[3,2,19])
        self.assertEqual(cases[-2]['specs'][0]['coordinatorNodeId'],'l1')
        self.assertEqual(cases[-1]['specs'][0]['coordinatorNodeId'],'l2')
        for case in cases:
            for spec in case['specs']:
                self.assertEqual((spec['profile'],spec['ctx'],spec['parallel']),('qwen35-2b-q8',1024,1))

    def test_guard_refuses_marker_missing_open_port_and_unknown_socket_failure(self):
        with patch.dict(module.os.environ,{},clear=True), patch.object(module.socket,'create_connection') as connect:
            with self.assertRaisesRegex(RuntimeError,'idle-window'):
                module.guard()
            connect.assert_not_called()
        with patch.dict(module.os.environ,{'SWARMLET_IDLE_WINDOW':'1'}):
            connection = Mock()
            with patch.object(module.socket,'create_connection',return_value=connection):
                with self.assertRaisesRegex(RuntimeError,'still listening'):
                    module.guard()
            connection.close.assert_called_once()
            with patch.object(module.socket,'create_connection',side_effect=TimeoutError):
                with self.assertRaisesRegex(RuntimeError,'cannot establish'):
                    module.guard()
            with patch.object(module.socket,'create_connection',side_effect=ConnectionRefusedError):
                module.guard()

    def test_route_evidence_requires_every_expected_member_visible_text_and_done(self):
        expected = {'a':'l1','b':'l2'}
        module.verify_routes([self.response(),self.response('b','l2')],expected)
        with self.assertRaisesRegex(RuntimeError,'all members'):
            module.verify_routes([self.response(),self.response()],expected)
        for response in [self.response('foreign','l1'),self.response('a','wrong'),dict(self.response(),routeHeaders={})]:
            with self.assertRaisesRegex(RuntimeError,'route headers'):
                module.verify_routes([response],{'a':'l1'})
        for changed in [dict(done=False),dict(text=''),dict(error='SSE interrupted'),dict(status='fail')]:
            with self.assertRaisesRegex(RuntimeError,'inference failed'):
                module.verify_routes([dict(self.response(),**changed)],{'a':'l1'})

    def test_retires_orphan_creation_by_owned_prefix_only(self):
        runner = self.runner()
        runner.journal['pendingName'] = runner.prefix+'-lost-response'
        runner.api = Mock(return_value={'deployments':[dict(id='ours',spec={'name':runner.prefix+'-lost-response'}),dict(id='other',spec={'name':'not-ours'})]})
        runner.cleanup_call = Mock()
        runner.retire()
        self.assertEqual([call.args for call in runner.cleanup_call.call_args_list],[('/api/deployments/ours/stop','POST'),('/api/deployments/ours','DELETE')])
        self.assertEqual(runner.journal['ownedIds'],[])

    def test_preflight_refuses_inflight_or_unrelated_active_deployment(self):
        runner = self.runner()
        runner.api = Mock(return_value={'totals':{'inflight':1}})
        with self.assertRaisesRegex(RuntimeError,'active requests'):
            runner.preflight()
        runner.api = Mock(side_effect=[{'totals':{'inflight':0}},{'deployments':[dict(id='foreign',spec={'kind':'replica','name':'foreign'},state='ready')]}])
        with self.assertRaisesRegex(RuntimeError,'unrelated'):
            runner.preflight()

    def test_finally_restores_when_stop_or_case_interrupted(self):
        for fail_stop in [True,False]:
            runner = self.runner()
            runner.api = Mock(return_value=dict(state='stopped',spec={'name':'base'}))
            runner.preflight = Mock()
            runner.cleanup_call = Mock(side_effect=KeyboardInterrupt if fail_stop else None)
            runner.arm = Mock(side_effect=KeyboardInterrupt)
            runner.retire = Mock()
            runner.restore = Mock()
            with patch.object(module,'guard'), patch.object(module.signal,'signal'):
                with self.assertRaises(KeyboardInterrupt):
                    runner.run()
            runner.restore.assert_called_once()

    def test_restore_preserves_stopped_intent_and_restores_running_split(self):
        for running in [True,False]:
            runner = self.runner()
            runner.journal['baseline'] = dict(running=running,spec={'name':'base'},split=[3,3,18])
            runner.retire = Mock()
            def api(path,method='GET',body=None):
                if path=='/api/deployments':return {'deployments':[]}
                return dict(state='stopped',spec={'name':'base'})
            runner.api = Mock(side_effect=api)
            runner.ready = Mock(return_value={'plan':{'tensorSplit':[3,3,18]}})
            runner.restore()
            starts = [c for c in runner.api.call_args_list if c.args[0].endswith('/start')]
            self.assertEqual(len(starts),int(running))
            self.assertIn('restoredAt',runner.journal)

    def test_restore_does_not_start_baseline_if_cleanup_fails(self):
        runner = self.runner()
        runner.journal['baseline'] = dict(running=True,spec={},split=[])
        runner.retire = Mock(side_effect=RuntimeError('cleanup blocked'))
        runner.api = Mock()
        with self.assertRaisesRegex(RuntimeError,'cleanup blocked'):
            runner.restore()
        runner.api.assert_not_called()

    def test_pool_requests_are_unpinned_and_all_routes_are_recorded(self):
        runner = self.runner()
        case = next(c for c in runner.manifest['arms'] if c['id']=='replicas-legions')
        created = []
        def api(path,method='GET',body=None,timeout=30):
            if path=='/api/deployments':
                ident = 'a' if not created else 'b'
                created.append(ident)
                return {'id':ident}
            return {'ok':True}
        runner.api = Mock(side_effect=api)
        runner.ready = Mock(side_effect=lambda ident:dict(id=ident,endpoint={'nodeId':'l1' if ident=='a' else 'l2','modelName':'tiny'},assignments=[]))
        runner.collect_evidence = Mock()
        runner.retire = Mock()
        seen = []
        def request(url,headers,body,timeout):
            seen.append(headers)
            i = int(headers['x-request-id'].split('-')[-1])
            return self.response('a' if i%2==0 else 'b','l1' if i%2==0 else 'l2')
        with patch.object(module.matrix,'stream_request',side_effect=request):
            runner.arm(case)
        self.assertEqual(runner.results[case['id']]['status'],'pass')
        self.assertEqual(len(runner.results[case['id']]['requests']),6)
        self.assertTrue(all('x-swarmlet-deployment' not in h for h in seen))
        self.assertEqual(runner.journal['ownedIds'],['a','b'])
        runner.retire.assert_called_once()

    def test_failed_start_is_journalled_and_case_failure_visible(self):
        runner = self.runner()
        runner.api = Mock(side_effect=[{'id':'owned'},RuntimeError('start rejected')])
        runner.retire = Mock()
        runner.collect_evidence = Mock()
        runner.arm(runner.manifest['arms'][0])
        result = runner.results[runner.manifest['arms'][0]['id']]
        self.assertEqual(result['status'],'fail')
        self.assertIn('start rejected',result['error'])
        self.assertEqual(runner.journal['ownedIds'],['owned'])
        self.assertEqual(result['evidence'][0]['deployment']['id'],'owned')
        runner.retire.assert_called_once()

    def test_case_interrupt_is_failed_and_retired_before_propagating(self):
        runner = self.runner()
        runner.api = Mock(side_effect=KeyboardInterrupt)
        runner.retire = Mock()
        with self.assertRaises(KeyboardInterrupt):
            runner.arm(runner.manifest['arms'][0])
        result = runner.results[runner.manifest['arms'][0]['id']]
        self.assertEqual(result['status'],'fail')
        self.assertTrue(result['interrupted'])
        runner.retire.assert_called_once()


if __name__=='__main__':
    unittest.main()
