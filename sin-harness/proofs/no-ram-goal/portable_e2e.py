#!/usr/bin/env python3
"""Hermetic, low-RAM proof checks for clean Linux/macOS clones.

This suite intentionally excludes the actual-GGUF partition plan, Docker,
LaunchAgent checks, and model inference. Those live behind explicit hardware or
integration commands.
"""
import importlib,json,os,subprocess,sys,tempfile
from pathlib import Path
HERE=Path(__file__).parent;ROOT=HERE.parents[1];QWEN=HERE.parent/'qwen-flash-experts';sys.path[:0]=[str(HERE),str(QWEN)]
def rss():return int(subprocess.check_output(['ps','-o','rss=','-p',str(os.getpid())],text=True).strip())
def model_snapshot():
 lines=subprocess.check_output(['ps','-axo','pid=,command='],text=True).splitlines()
 return sorted(x for x in lines if any(k in x for k in ('llama-server','convert_hf_to_gguf','llama-quantize')) and 'ps -axo' not in x)
before_rss=rss();before_models=model_snapshot();results={}
results['rollback']=importlib.import_module('rollback_fixture').selftest()
results['featureCache']=importlib.import_module('feature_cache').selftest()
results['schema']=importlib.import_module('validate_config').validate(HERE/'examples/flashnext-dflash2.candidate.json')
results['scheduler']=importlib.import_module('scheduler_sim').selftest()
results['signedManifest']=importlib.import_module('run_manifest').selftest()
results['qwenAdminAuth']=importlib.import_module('admin_auth').selftest()
results['qwenSigning']=importlib.import_module('signing').selftest()
results['qwenResponseValidation']=importlib.import_module('response_validation').selftest()
results['expertBundle']=importlib.import_module('bundle_format').selftest()
worker=subprocess.run([sys.executable,str(QWEN/'bundle_worker_selftest.py')],check=True,capture_output=True,text=True);results['expertBundleWorker']=json.loads(worker.stdout.split('RESULT_JSON=')[-1])
results['systemMetrics']=importlib.import_module('system_metrics').selftest()
with tempfile.TemporaryDirectory() as d:
 out=Path(d)/'RESULTS_GRID.md';cmp=subprocess.run([sys.executable,str(HERE/'compare_results.py'),'--out',str(out)],check=True,capture_output=True,text=True)
 results['comparator']=json.loads(cmp.stdout.split('RESULT_JSON=')[-1]);assert out.is_file()
after_models=model_snapshot();delta=max(0,rss()-before_rss);assert before_models==after_models;assert delta<512*1024
results['safety']={'rssDeltaMiB':delta/1024,'modelProcessSnapshotUnchanged':True,'noModelOrDockerStarted':True,'portableScope':True}
print('RESULT_JSON='+json.dumps(results,separators=(',',':')))
