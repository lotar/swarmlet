#!/usr/bin/env python3
"""E2E validation of all no-RAM goal artifacts."""
import importlib,json,subprocess,sys,urllib.request
from pathlib import Path
HERE=Path(__file__).parent;ROOT=HERE.parents[1];sys.path.insert(0,str(HERE))
def rss():return int(subprocess.check_output(['ps','-o','rss=','-p',str(__import__('os').getpid())],text=True).strip())
def prod():
 try:return sorted(subprocess.check_output(['pgrep','-f','llama.cpp-pr27739/build/bin/llama-server.*--port 8099'],text=True).split())
 except:return []
def health():return json.load(urllib.request.urlopen('http://127.0.0.1:8099/health'))
def model_snapshot():
 lines=subprocess.check_output(['ps','-axo','pid=,command='],text=True).splitlines();return sorted(x for x in lines if any(k in x for k in ('llama-server','convert_hf_to_gguf','llama-quantize','test-recurrent-state-rollback')) and 'ps -axo' not in x)
def docker_snapshot():return sorted(subprocess.check_output(['docker','ps','--format','{{.ID}}|{{.Names}}'],text=True).splitlines())
before_rss=rss();before_prod=prod();before_health=health();before_models=model_snapshot();before_docker=docker_snapshot();assert len(before_prod)==1 and before_health['status']=='ok'
results={};results['rollback']=importlib.import_module('rollback_fixture').selftest();results['featureCache']=importlib.import_module('feature_cache').selftest();results['schema']=importlib.import_module('validate_config').validate(HERE/'examples/flashnext-dflash2.candidate.json');results['scheduler']=importlib.import_module('scheduler_sim').selftest();results['partition']=importlib.import_module('partition_planner').plan();results['signedManifest']=importlib.import_module('run_manifest').selftest()
out=ROOT.parent/'docs/RESULTS_GRID.md';cmp=subprocess.run([sys.executable,str(HERE/'compare_results.py'),'--out',str(out)],check=True,capture_output=True,text=True);results['comparator']=json.loads(cmp.stdout.split('RESULT_JSON=')[-1])
runbook=ROOT/'scripts/flashnext-maintenance.sh';subprocess.run(['bash','-n',str(runbook)],check=True);check=subprocess.check_output([str(runbook),'check-only'],text=True);assert 'CHECK_OK' in check;results['runbook']={'checkOnly':True,'status':check.strip().splitlines()[-1]}
after_prod=prod();after_health=health();after_models=model_snapshot();after_docker=docker_snapshot();assert before_prod==after_prod and before_health==after_health;assert before_models==after_models;assert before_docker==after_docker
delta=max(0,rss()-before_rss);assert delta<512*1024;results['safety']={'rssDeltaMiB':delta/1024,'productionPidUnchanged':True,'healthObservedBeforeAfter':True,'modelProcessSnapshotUnchanged':True,'dockerSnapshotUnchanged':True,'noModelOrDockerStarted':True}
print('RESULT_JSON='+json.dumps(results,separators=(',',':')))
