#!/usr/bin/env python3
"""Portable, fail-closed process RSS and host swap telemetry."""
from __future__ import annotations
import platform,re,subprocess
from pathlib import Path

def rss_kib(pid:int)->int:
 out=subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True).strip()
 if not out:raise RuntimeError(f'RSS unavailable for live pid {pid}')
 return int(out)

def swap_used_mib()->float:
 system=platform.system()
 if system=='Linux':
  values={}
  for line in Path('/proc/meminfo').read_text().splitlines():
   if ':' in line:
    key,value=line.split(':',1);m=re.search(r'(\d+)',value)
    if m:values[key]=int(m.group(1))
  if 'SwapTotal' not in values or 'SwapFree' not in values:raise RuntimeError('Linux swap telemetry unavailable')
  return max(0,values['SwapTotal']-values['SwapFree'])/1024
 if system=='Darwin':
  text=subprocess.check_output(['sysctl','vm.swapusage'],text=True);m=re.search(r'used = ([\d.]+)M',text)
  if not m:raise RuntimeError('macOS swap telemetry unavailable')
  return float(m.group(1))
 raise RuntimeError(f'swap telemetry unsupported on {system}')

def memory_available_percent()->float:
 system=platform.system()
 if system=='Linux':
  values={}
  for line in Path('/proc/meminfo').read_text().splitlines():
   if ':' in line:
    key,value=line.split(':',1);m=re.search(r'(\d+)',value)
    if m:values[key]=int(m.group(1))
  if not values.get('MemTotal') or 'MemAvailable' not in values:raise RuntimeError('Linux memory telemetry unavailable')
  return 100*values['MemAvailable']/values['MemTotal']
 if system=='Darwin':
  text=subprocess.check_output(['memory_pressure','-Q'],text=True);m=re.search(r'free percentage:\s*(\d+)%',text)
  if not m:raise RuntimeError('macOS memory telemetry unavailable')
  return float(m.group(1))
 raise RuntimeError(f'memory telemetry unsupported on {system}')

def selftest():
 assert rss_kib(__import__('os').getpid())>0
 used=swap_used_mib();available=memory_available_percent();assert used>=0 and 0<=available<=100
 return {'rssKiB':rss_kib(__import__('os').getpid()),'swapUsedMiB':used,'memoryAvailablePercent':available,'platform':platform.system()}

if __name__=='__main__':
 import json;print('RESULT_JSON='+json.dumps(selftest(),separators=(',',':')))
