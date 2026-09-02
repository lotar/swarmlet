# swarmlet.ai

A dependency-free product site for Swarmlet: an adaptive orchestration layer that chooses how to split open-weight models across heterogeneous consumer hardware.

The page has one job: explain the actual product, show the current evidence without broadening it, publish the full roadmap, and offer a one-field wishlist. It does not claim a production network, account system, pricing, public source release, or finished DeepSeek support.

```text
index.html   semantic page, roadmap, HTML graph labels, and critical CSS
app.js       reveal behavior, wishlist behavior, and three routing WebGL graphs
favicon.svg  site mark
og.svg/png   editable social card and rendered 1200×630 image
server.mjs   dependency-free preview server with compression and cache headers
```

## Run it

```sh
cd site && node server.mjs
# http://localhost:8123
```

`index.html` also works directly from `file://`; all asset paths are relative. The preview server uses `cache-control: no-store` unless `SITE_CACHE` is set.

## Product narrative

The page makes a strict distinction between product direction and current evidence:

1. `adaptive`: heterogeneous nodes are measured, scored, and assigned to one served model.
2. `split`: the planner can consider stages, experts, tensor banks, and whole requests instead of hard-coding one architecture.
3. `federation`: low-latency cells host complete models; wide-area links route whole requests between them.

The HTML labels preserve the explanation when WebGL is disabled. Canvas uses raw WebGL 1, initializes near the viewport, pauses offscreen, and renders a static frame for reduced motion.

The physical proof copy is scoped to the signed Qwen3.8 Flash Next Legion CUDA artifact in `sin-harness/data/qwen-legion-cuda-matrix-20260901T083747Z/`. It separately identifies the Mac + two-Legion test rig and states that the signed two-owner physical result is pending.

QA flags:

- `?gl=force` allows SwiftShader in headless tests and exposes `window.__sw`.
- `?gl=off` disables WebGL so the semantic fallback can be verified.
- `window.__sw` contains `{ views, err }`; a full-page pass should build `adaptive`, `split`, and `federation` with no errors.

## Wishlist behavior

The form has one required email input. JavaScript validates it and posts it to the same-origin wishlist API, which stores the normalized address in SQLite. Without JavaScript, the native `mailto:` form remains usable.

## Analytics behavior

Google Analytics 4 remains unloaded until a visitor explicitly allows analytics. The choice is stored in the browser and can be changed from the footer. Tracking is limited to the automatic page view and a `wishlist_signup` event after the API accepts the form. The event contains only `{ form_location: "homepage" }`; email addresses and form contents are never added to the analytics queue.

## QA

From the repository root:

```sh
node --check site/app.js
git diff --check

node tools/site/probe.mjs "http://localhost:8123/?gl=force" \
  'JSON.stringify({views:window.__sw?.views.length,errors:window.__sw?.err})'

node tools/site/probe.mjs "http://localhost:8123/?gl=off" \
  'JSON.stringify({content:document.querySelector("main").innerText.length})'

RM=1 SPY=1 node tools/site/probe.mjs "http://localhost:8123/?gl=force" \
  'JSON.stringify({raf:window.__raf,errors:window.__sw?.err})'

node tools/site/probe.mjs "file://$PWD/site/index.html?gl=force" \
  'JSON.stringify(window.__sw?.err)'
```

Before release, inspect desktop and phone screenshots, verify 320–1440 px without horizontal overflow, exercise invalid and valid wishlist states, navigate every header anchor, and run the repository release check.
