import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeMetrics } from '../protocol/types.ts';
import { exec } from './probe/exec.ts';
import { startFanLease } from './fan-lease.ts';

type Hardware = NonNullable<NodeMetrics['hardware']>;
interface ProviderStatus { fans?: Hardware['fans']; temperatures?: Hardware['temperatures']; controls?: Array<{value:number;mode:number}>; error?: string }
const PRIVILEGED_HELPER = process.platform === 'darwin' ? '/Library/PrivilegedHelperTools/swarmlet-fans' : '/usr/local/libexec/swarmlet-fans';

/** Providers inspect exposed capabilities; no hostname, model or fan-count tables. */
export class FanManager {
  private owned = false;
  private lease: Awaited<ReturnType<typeof startFanLease>> | null = null;
  private stopping = false;
  private retryAt = 0;
  private control: Hardware['fanControl'] = {state:'unsupported',detail:'Fan control has not been probed'};
  private cache: Hardware | null = null;
  private starting: Promise<void> | null = null;
  constructor(private readonly enginePath: string) {}
  start(): Promise<void> {
    return this.starting ??= this.requestMaximum();
  }
  private async requestMaximum(): Promise<void> {
    const hardware = await this.sample(true);
    if (hardware.fanControl.state === 'unsupported') return;
    if (!existsSync(PRIVILEGED_HELPER)) {
      this.control = {state:'permission-required',detail:'Administrator setup is required to enable automatic maximum fan speed'};
      return;
    }
    try {
      this.lease = await startFanLease(['sudo','-n',PRIVILEGED_HELPER,'hold']);
      this.owned = true;
      this.control = {state:'requested',detail:'Maximum cooling held while the node is running; checking fan feedback'};
      this.cache = null;
    } catch (error) {
      this.control = {state:'error',detail:'Maximum fan request failed: '+String(error).slice(0,300)};
      this.retryAt = Date.now()+30_000;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.starting?.catch(() => undefined);
    if (!this.owned) return;
    if (this.lease) {
      await this.lease.stop();
      this.lease = null;
    } else {
      const result = await exec(['sudo','-n',PRIVILEGED_HELPER,'auto'],{timeoutMs:10000});
      if (result.code !== 0) throw new Error('Could not restore automatic fan control: '+(result.stdout || result.stderr).trim());
    }
    this.owned = false;
    this.control = {state:'automatic',detail:'Previous Linux settings or Apple automatic control restored'};
  }
  async sample(force = false): Promise<Hardware> {
    if (this.lease && this.lease.exitCode !== null) {
      this.lease = null; this.owned = false;
      this.control = {state:'error',detail:'Fan helper stopped; retrying maximum cooling shortly'};
      this.retryAt = Date.now()+30_000;
    }
    if (!this.stopping && this.retryAt && Date.now() >= this.retryAt) {
      this.retryAt = 0;
      this.starting = this.requestMaximum();
      await this.starting;
    }
    if (!force && this.cache && Date.now()-Date.parse(this.cache.measuredAt)<5000) return {...this.cache,fanControl:this.control};
    const helper = join(this.enginePath,'swarmlet-fans');
    let status:ProviderStatus = {};
    if (process.platform === 'win32') {
      // Standard Windows APIs do not provide a portable writable fan interface.
      // Read optional hardware-monitor sensors when a driver exposes them through WMI.
      const script = "$ErrorActionPreference='Stop'; $s=Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor; $fans=@($s | Where-Object SensorType -eq 'Fan' | ForEach-Object { @{id=$_.Identifier;name=$_.Name;rpm=$_.Value} }); $temps=@($s | Where-Object SensorType -eq 'Temperature' | ForEach-Object { @{name=$_.Name;celsius=$_.Value} }); @{fans=$fans;temperatures=$temps} | ConvertTo-Json -Depth 4 -Compress";
      const result = await exec(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeoutMs:5000});
      if (result.code === 0) try {status=JSON.parse(result.stdout);} catch {}
      this.control = {state:'unsupported',detail:'This Windows driver exposes no supported maximum-speed control interface'};
    } else if (existsSync(helper)) {
      const result = await exec([helper,'status'],{timeoutMs:5000});
      try {status=JSON.parse(result.stdout);} catch {status.error='Fan provider did not return a valid hardware reading';}
      if (!status || typeof status !== 'object') status={error:'Invalid fan provider response'};
      status.fans=(Array.isArray(status.fans)?status.fans:[]).filter(f=>f&&typeof f.id==='string'&&typeof f.name==='string');
      status.controls=(Array.isArray(status.controls)?status.controls:[]).filter(c=>c&&Number.isInteger(c.value)&&Number.isInteger(c.mode));
      const supported = !status.error && (process.platform === 'darwin' ? (status.fans?.length ?? 0)>0 : (status.controls?.length ?? 0)>0);
      if (!supported) this.control = {state:'unsupported',detail:status.error || 'Firmware/driver exposes no standard writable fan controls'};
      else if (!this.owned && this.control.state === 'unsupported') this.control = {state:'automatic',detail:'Firmware fan control detected'};
      else if (this.owned) {
        const atMax = process.platform === 'darwin' && !!status.fans?.length && status.fans.every(f=> f.mode==='manual' && typeof f.rpm==='number' && typeof f.maxRpm==='number' && f.rpm >= f.maxRpm*0.95 && typeof f.targetRpm==='number' && Math.abs(f.targetRpm-f.maxRpm)<=5);
        const requested = process.platform === 'darwin' || !!status.controls?.length && status.controls.every(c=>c.value===255&&c.mode===1);
        this.control = {state:atMax?'max':requested?'requested':'error',detail:atMax?'Fan RPMs are within 5% of firmware maximums':requested?'Maximum cooling requested; RPM feedback shown where available':'Firmware did not retain the maximum cooling request'};
      }
    } else this.control={state:'unsupported',detail:'No compatible fan provider is installed'};
    const fans=(Array.isArray(status.fans) ? status.fans : []).filter(f=>f && typeof f.id==='string'&&typeof f.name==='string'&&(f.rpm===undefined||Number.isFinite(f.rpm)&&f.rpm>=0&&f.rpm<=100000));
    const temperatures=(Array.isArray(status.temperatures) ? status.temperatures : []).filter(t=>t && typeof t.name==='string'&&Number.isFinite(t.celsius)&&t.celsius>=-40&&t.celsius<=200);
    this.cache={measuredAt:new Date().toISOString(),fans,temperatures,fanControl:this.control};
    return this.cache;
  }
}
