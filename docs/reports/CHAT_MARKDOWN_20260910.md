# Chat Markdown — 10 September 2026

Assistant messages use one shared GFM renderer in the embedded node UI (macOS, Windows, Linux) and the hosted workspace. It handles headings, emphasis, lists, quotes, tables, fenced code, links and task lists while replies stream. Node history retains the original Markdown and renders it again when reopened; prompts and API payloads remain plain source text. Hosted reasoning uses the same renderer.

Marked 18.0.12 and DOMPurify 3.4.15 are embedded with their licenses and verified upstream archive integrities. Raw HTML is escaped; the final DOM is sanitized with an explicit allowlist. Unsafe URL protocols are removed, external links use noopener/noreferrer, and image syntax becomes a link without an automatic third-party request.

## Validation

- `bun run --cwd swarmlet test`: `313 pass`, `0 fail`, `3825 expect() calls` after the final source change. An earlier full run had one RSS-cap timing assertion fail; its isolated rerun and two subsequent unchanged full runs passed. No assertion was relaxed.
- Real node and hosted browser fixture replies, streamed in 19-character chunks: headings, nested lists, tables, code, open/closed fences, literal raw HTML, unsafe links, disabled task checkboxes and zero image requests passed. Node reload preserved and rendered the raw saved answer. Hosted reasoning emphasis passed.
- Desktop and 375px layouts: no horizontal document overflow; screenshots inspected.
- Reproduce with `bun swarmlet/e2e/markdown-fixture.ts` (set its documented upstream environment variables as needed), send a message in each fixture UI, then `browse eval swarmlet/e2e/markdown-browser-check.js`.
- Three canonical agent targets compiled. Shipping source: `3cb0a1c`.

## Review

VERDICT: merge. FINDINGS: none outstanding.

| Lens | Result |
| --- | --- |
| Correctness | Clean: empty, streaming and restored messages exercised. |
| Contracts | Clean: `node-agent/ui/chat.js` and `control/ui/app.js` preserve raw message payloads; both `ui.ts` servers load assets before consumers. |
| Data safety | Clean: no storage migration, deletion or format change. |
| Time | Clean: no time logic changed. |
| Staleness/concurrency | Clean: synchronous stream updates and no-store assets. |
| Security | Clean: escaping, sanitization, URL checks and no implicit image fetches verified in the browser. |
| Tests | Clean: transport assertions retained; DOM security tested with the real renderer. |
| Simplicity | Clean: one adapter and stylesheet; duplicate-logic search across shared and both UI trees completed. |

QUESTIONS: none.

## Rollout

Release `2026091007` (`0.1.0-markdown.20260910.7`) activated automatically on the Mac, Windows node and both Linux nodes. All signed inventory hashes matched the running release (10/6/7/7 files); original node identities, controller keys and offers were preserved. The macOS service and desktop bundle contain the same signed agent bytes.

The hosted workspace runs image `swarmlet-control:3cb0a1c`. All five live surfaces serve exactly the shared JS/CSS from source; renderer JS SHA-256: `5b9522948847d54d274edf6abfbef92353c3ae07d9e674f74997b21f4b23d51b`. Browser DOM probes on each live surface passed headings, bold, tables, code and sanitization. A real hosted 2B reply rendered a heading and code block; a real node 2B reply rendered **Markdown works** as bold. One node reply during a worker update was interrupted; the post-rollout retry passed.

`python3 -I /tmp/swarmlet-markdown-fleet-audit.py` reported:

```text
PASS: 4/4 hosted release7 activations, signed inventories, stable identities/pins/offers, and gateway replies
```

All four gateways returned `MARKDOWN_FLEET_OK` through Qwen3.5-2B (Mac 4.19s, Windows 2.41s, Linux 2.62s/2.58s). Evidence is retained locally under `~/.swarmlet/backups/markdown-20260910/`. Reload already-open chat windows to load the renderer.

### Model recovery during rollout

Both model deployments were ready before the hosted restart. Qwen3.5-2B recovered and remains ready. Flash-Next failed to reload: `does not fit: 53099 MiB free, need 76016; no external service to stop`. Its original placement and memory limits remain intact. The same failure and free-memory measurement were confirmed through the deployment API and the Mac admission code (`node-agent/assignments.ts` → `probe/darwin.ts`).

| Hypothesis | Discriminating evidence |
| --- | --- |
| RAM admission prevents launch | Deployment explicitly reports 53099 < 76016 MiB; the fit gate throws before launch. Confirmed. |
| Markdown assets or a GPU engine crash prevent launch | UI probes pass; the failure is the pre-launch fit check, and 2B serves through the same agents. Rejected for this failure. |

macOS reports substantial file-backed cache, but its contribution to this admission result was not proven. A disk-cache purge was unavailable: `Unable to purge disk buffers: Operation not permitted`; passwordless sudo was also unavailable. No memory override, unrelated service restart, or model placement change was applied. After the rollout, macOS naturally reported 84645 MiB available. Flash-Next was retried through the same unchanged admission gate while 2B remained ready. It then reached ready and returned `FLASH_MARKDOWN_OK`. Final check: both Flash-Next and Qwen3.5-2B are ready. No recovery work remains.

```text
PASS: Flash-Next and 2B ready; Flash returned FLASH_MARKDOWN_OK
```
