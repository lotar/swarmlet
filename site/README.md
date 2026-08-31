# swarmlet.ai — teaser site

One static page. No build step, no bundler, no dependencies, no third-party requests.

```
index.html   markup + all critical CSS, inlined
app.js       ~32 KB of deferred vanilla JS: scroll state, reveal, counters, form, WebGL field
favicon.svg  the mark
og.svg/png   editable social card + 1200×630 rendered image
server.mjs   dependency-free dev/preview server (brotli + gzip, cache headers)
_headers     response headers for hosts that read them (Netlify / Cloudflare Pages)
robots.txt sitemap.xml CNAME
```

## Run it

```sh
cd site && node server.mjs            # http://localhost:8123
PORT=8123 SITE_CACHE="public, max-age=60" node server.mjs
```

The dev server defaults to `cache-control: no-store` so reloads are never stale.
`index.html` also opens straight off disk — `file://…/site/index.html` works, every
asset path is relative.

For a deploy target that ignores `_headers` (GitHub Pages), set the same headers at the
edge, or accept the defaults: the page has no dependencies to expire.

## The WebGL field

`app.js` draws the mesh with raw WebGL 1 — no library. Three canvases, one context each
(`#mesh-canvas`, `[data-shader="thesis"]`, `[data-shader="cta"]`).

**A view is assembled in five stages — context, line program, node program, lattice upload,
first draw — and exactly one stage runs per idle slice.** This is the single most
load-bearing rule in the file. Building a view in one go costs ~70 ms of real CPU (measured
under 4× CPU throttling), which Lighthouse inflates to a 618 ms long task inside the TBT
window: 100 → 86 on mobile. PageSpeed Insights runs Chrome without a GPU, so shader
compiles are slow *there*, not just in our traces. Rules that fall out of it:

- a canvas offscreen stays unbuilt until an `IntersectionObserver` brings it within 260 px;
- a canvas that has *started* always finishes, even if it scrolls away — a half-built canvas
  is blank on the next scroll. Untouched offscreen ones wait for the observer instead, which
  is what keeps the scheduler idle-driven rather than spinning;
- stages never run on `requestAnimationFrame`. A shader compile on a frame is scroll jank;
  `requestIdleCallback(..., { timeout: 500 })` is what stops the render loop from starving a
  half-built view forever.

A view is a jittered lattice with holes, wired to nearest neighbours with hub-style degrees
plus a few long-haul links. Lines are quads with analytic screen-space coverage
(`1 - smoothstep(core, core + px, |d|)`), so a hairline stays one crisp device pixel at any
DPR instead of turning into a ribbon. Nodes fire on a computed cascade schedule; edges
brighten while a packet crosses them and the destination node flashes on arrival.
Everything fades out before the canvas edge so the field dissolves instead of being cut.

Tiers:

| device | canvases | frame cap | pixel ceiling |
| --- | --- | --- | --- |
| desktop | all three | 60 fps | 2.3 M px |
| `max-width: 880px` or coarse pointer | hero only | 30 fps | 0.5 × ceiling, quieter mask |
| `prefers-reduced-motion` | all three, one static frame | — | — |
| no WebGL / refused context | none — the CSS gradient carries the section | — | — |

QA flags, both inert in production:

- `?gl=force` — keep the field alive on software rasterisers (headless Chrome uses
  SwiftShader, which `failIfMajorPerformanceCaveat` normally refuses) and expose
  `window.__sw` / `window.__dbg` render dials (`{ lines, nodes, pkt, w }`).
- `?gl=off` — no WebGL at all; check the page reads fine without it.

## QA

```sh
tools/site/shots.sh "http://localhost:8123/?gl=force" 1440x900 /tmp/sw   # every section
tools/site/shots.sh "http://localhost:8123/?gl=force" 390x844  /tmp/mw   # phone
lighthouse http://localhost:8123/ --form-factor=mobile --screenEmulation.mobile \
  --only-categories=performance,accessibility,best-practices,seo --output=json --output-path=/tmp/lh.json
lighthouse http://localhost:8123/ --preset=desktop --form-factor=desktop \
  --only-categories=performance,accessibility,best-practices,seo --output=json --output-path=/tmp/lhd.json
```

Dated local evidence (2026-08-30): Lighthouse **100 / 100 / 100 / 100**, mobile and desktop, **TBT 0 ms, no long
tasks** either side. The only flagged audit is back/forward cache, which is the dev server's
`no-store` and does not apply to a deployed host.

`tools/site/trace.mjs` is how a regression like that gets found instead of guessed at — it
traces a throttled mobile load and prints every event over 40 ms with its script and
function name (`FunctionCall app.js drain 71.3 ms` is what pointed straight at the shader
compiles). `tools/site/probe.mjs` drives headless Chrome over CDP for the things Lighthouse
cannot see:

```sh
# from repository root: lazy build + no GL errors (needs ?gl=force for SwiftShader)
node tools/site/probe.mjs "http://localhost:8123/?gl=force" 'JSON.stringify({views:window.__sw?.views.length,errors:window.__sw?.err})'
# reduced motion: one static frame and nothing hidden
RM=1 SPY=1 node tools/site/probe.mjs "http://localhost:8123/?gl=force" 'JSON.stringify({raf:window.__raf,hidden:[...document.querySelectorAll(".rv:not(.in)")].length})'
# file:// still works
node tools/site/probe.mjs "file://$PWD/site/index.html?gl=force" 'JSON.stringify(window.__sw?.err)'
```

Non-negotiable behaviour, all of it verified rather than assumed:

- **no JS**: the inline `documentElement.className += " js"` gate means reveals, bars and
  counters render their final state (`<noscript>` is not needed for them); the form falls
  back to `action="mailto:"` with native validation.
- **reduced motion**: one static mesh frame, no rAF loop, nothing hidden behind a reveal.
- **`file://`**: every asset path is relative; the field builds and reports no GL errors.
- **no horizontal overflow** at 390 px; the benchmark table scrolls inside its own wrapper
  with a visible "table scrolls sideways" hint.

Things that were load-bearing for that score, don't casually undo them:

- `app.js` is `defer`red and WebGL starts after `load`, in idle slices — see the staged-build
  rule above; collapsing the stages back into one task costs ~570 ms TBT on mobile (100 → 86).
- No webfonts. `system-ui` + `ui-monospace` only, so no FOUT and no CLS.
- Accordion and mobile nav are native `<details>`; scroll-spy and reveal are one
  `IntersectionObserver` each.
- Vertex buffers are interleaved 10 floats per line vertex; the stride in `upload()` has to
  match `vert()` exactly or the mesh renders as fat ribbons.

Content numbers come from `../docs/BENCHMARKS.md`, `../docs/PoC.md` and `../docs/WEBGPU.md`.
If a benchmark changes, change the copy in the same commit.

The site and harness are source available under `../LICENSE`. The revenue-limited commercial grant is not an OSI Open Source license.
