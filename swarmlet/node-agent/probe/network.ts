import { readFile } from 'node:fs/promises';
import type { NodeMetrics } from '../../protocol/types.ts';
import { exec } from './exec.ts';
export interface InterfaceCounter {name:string;rx:number;tx:number}
export function parseLinuxNetwork(text:string):InterfaceCounter[] {
  return text.split('\n').flatMap(line=>{
    const match=/^\s*([^:]+):\s*(.*)$/.exec(line);if(!match||match[1]==='lo')return [];
    const fields=match[2]!.trim().split(/\s+/).map(Number),rx=fields[0],tx=fields[8];
    return rx!==undefined&&tx!==undefined&&Number.isFinite(rx)&&Number.isFinite(tx)?[{name:match[1]!,rx,tx}]:[];
  });
}
export function parseMacNetwork(text:string):InterfaceCounter[] {
  const lines=text.trim().split('\n'),head=lines.shift()?.trim().split(/\s+/)??[];
  const name=head.indexOf('Name'),network=head.indexOf('Network'),rx=head.indexOf('Ibytes'),tx=head.indexOf('Obytes');
  if([name,network,rx,tx].some(x=>x<0))return [];
  const found=new Map<string,InterfaceCounter>();
  for(const line of lines){const f=line.trim().split(/\s+/);if(!f[network]?.startsWith('<Link#')||f[name]==='lo0')continue;const r=Number(f[rx]),t=Number(f[tx]);if(Number.isFinite(r)&&Number.isFinite(t))found.set(f[name]!,{name:f[name]!,rx:r,tx:t});}
  return [...found.values()];
}
export class NetworkSampler {
  private previous = new Map<string,InterfaceCounter>();
  private last = 0;
  rates(current:InterfaceCounter[],now=performance.now()):NonNullable<NodeMetrics['network']> {
    const elapsed=(now-this.last)/1000;
    const rates=current.map(row=>{const previous=this.previous.get(row.name);return {name:row.name,...(this.last&&elapsed>0&&previous&&row.rx>=previous.rx&&row.tx>=previous.tx?{rxBps:(row.rx-previous.rx)/elapsed,txBps:(row.tx-previous.tx)/elapsed}:{})};});
    this.previous=new Map(current.map(row=>[row.name,row]));this.last=now;return rates;
  }
  async sample():Promise<NonNullable<NodeMetrics['network']>> {
    let rows:InterfaceCounter[];
    if(process.platform==='linux')rows=parseLinuxNetwork(await readFile('/proc/net/dev','utf8'));
    else if(process.platform==='darwin'){
      const result=await exec(['netstat','-ibn'],{timeoutMs:3000});if(result.code!==0)throw Error('Network counters unavailable');rows=parseMacNetwork(result.stdout);
    }else{
      const script="$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-NetAdapterStatistics | ForEach-Object { @{name=$_.Name;rx=$_.ReceivedBytes;tx=$_.SentBytes} }) -Compress";
      const result=await exec(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeoutMs:5000});
      if(result.code!==0)throw Error('Network counters unavailable');rows=JSON.parse(result.stdout);
      if(!Array.isArray(rows))throw Error('Network counters malformed');
      rows=rows.filter(r=>typeof r.name==='string'&&Number.isFinite(r.rx)&&Number.isFinite(r.tx));
    }
    return this.rates(rows);
  }
}
