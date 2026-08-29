#!/usr/bin/env python3
import argparse,json
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--catalog',default=str(Path(__file__).parent/'results/catalog.json'));ap.add_argument('--out');a=ap.parse_args();rows=json.load(open(a.catalog))['rows'];repo=Path(__file__).resolve().parents[3]
for r in rows:
 if r['kind'] in ('measured','projected'):assert r.get('source') and (repo/r['source']).exists(),f'missing provenance for {r["variant"]}'
base=next(x for x in rows if x['variant']=='Target A1')['tps']
lines=['# AI Mesh results grid','','Measured and simulated values are intentionally separated. Disk-expert rows measure preparation, not full-model generation.','', '| Category | Variant | Kind | TPS | Latency | Δ vs Qwen target | Status | Source | Notes |','|---|---|---:|---:|---:|---:|---|---|---|']
for r in rows:
 delta=(r['tps']/base-1)*100;lines.append(f"| {r['category']} | {r['variant']} | {r['kind']} | {r['tps']:.2f} | {r['latencyMs']:.2f} ms | {delta:+.1f}% | {r['status']} | `{r['source']}` | {r['notes']} |")
lines+=['','## Best known points','',f"- Best measured full Qwen: **{max(x['tps'] for x in rows if x['kind']=='measured' and x['category'].startswith('Qwen')):.2f} tok/s** (native MTP Q4 n=3, concurrency 1 campaign).",'- 50 tok/s remains a conditional rack-scale pipeline simulation, not an empirical result.','- Pan-European token-path variants remain below target.','- Kimi disk streaming fits memory but is not interactive.','']
text='\n'.join(lines)
if a.out:Path(a.out).write_text(text)
print(text);print('RESULT_JSON='+json.dumps({'rows':len(rows),'bestMeasuredQwenTps':max(x['tps'] for x in rows if x['kind']=='measured' and x['category'].startswith('Qwen')),'simulated50Found':any(x['kind']=='simulated' and x['tps']>=50 for x in rows)},separators=(',',':')))
