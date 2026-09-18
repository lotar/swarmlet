# Hosted control plane

The control plane can serve the authenticated web workspace at `https://app.swarmlet.ai`. Engines and model files remain on the participating nodes. The controller carries enrollment, routing, relay traffic, deployment state and signed update artifacts.

Public web access is opt-in with `SWARMLET_PUBLIC_WEB=1`. Without it, the existing private-web policy remains in force. Admin API and browser chat require the admin token or login cookie; inference-only keys cannot administer the fleet. HTTPS login cookies are Secure, HttpOnly and SameSite=Strict. Forwarded requests cannot acquire loopback admin privileges. Disable LAN enrollment on a public host with `SWARMLET_LAN_AUTO_ENROLL=0`.

Use `compose.control.prod.yml` with the existing `traefik-public` network and Cloudflare-only Traefik middleware. It is a separate Compose project from the landing page. Set `SWARMLET_REVISION` to the shipping source revision and `SWARMLET_CONTROL_DATA` to a dedicated persistent directory writable by the image's `bun` user. The image uses Bun 1.3.14 and runs no inference engines.

Before migration, save node configurations and back up the complete controller data directory, including `control.json`, `control.sqlite`, `keys/` and `releases/`. Stop managed inference and shut down the old controller before the final state copy. Preserve the signing key: enrolled nodes pin it, and changing it would invalidate both their controller binding and release signatures. Never run two independent controllers against copies of the same live state.

After starting the hosted service, verify anonymous admin requests return 401, authenticate through the browser, and reconnect each existing node to the new HTTPS/WSS address. Existing node IDs, offers and signing-key pins must match their pre-migration records. Restore the saved deployment intent and verify generation over the public route.

Finally publish a higher signed release sequence, allow the normal node updater to activate it, and verify the installed files against the signed manifest and the actual running executable path. A successful image build or a healthy web page alone does not verify node migration or automatic updates.

For guarded model operations after cutover, point the existing idle gate at the hosted router:

```sh
python3 swarmlet/e2e/idle-window.py --allow-stopped --check --control-url https://app.swarmlet.ai
```

The gate still reads the admin token from `--control-config` (default `~/.swarmlet/control/control.json`), requires known zero activity, and preserves the existing production-owner and listener checks. Omit `--check` and supply the operator after `--` to run inside a verified quiet window. The default controller URL remains localhost for local installations.

## Transport: a direct path first, the relay as fallback

Every RPC endpoint in a plan carries the addresses the peer published plus `relay: true`. The node agent
(`node-agent/transport/dial.ts`) opens a local `127.0.0.1` port for each one and, on the first connection,
tries in this order:

1. a reverse stream, if that peer offered one (`servedial.ts`),
2. each direct address in turn - private IPs first, so two boxes on one LAN never leave it, then the
   public IP, then a NAT mapping the peer asked its own router for (`nat.ts`),
3. the control relay.

The winning path is remembered per endpoint and re-probed after a failure, so the cost is paid once per
placement. The assignment's ready detail names the path actually used: `rpc0=direct`, `rpc0=relay`.

A direct endpoint is a **preference, not a requirement**. The planner orders peers with a direct endpoint
first, by RTT, and lists relayed peers after them with a plan reason naming each one
(`Relayed over the control because no direct endpoint is advertised...`). A split plans and runs with no
direct endpoint anywhere, which is the state of production.

Measured on 2026-09-18, two Linux/CUDA nodes, neither advertising a public endpoint, split over RPC:

```
as-9a5915f749a8 ready: ... rpc0=direct        <- they reach each other over the LAN (192.168.1.0/24)
ready (split 3/21 on lotar-legion-2 > lotar-legion)
```

with a generation through the mesh endpoint answered by that split. The relay path is covered by the
agent's own test - no direct address answers, the dialer opens a relay stream, bytes flow, and
`currentPath` reports `relay` (`node-agent/test/transport.test.ts`). It is not exercised by a live pair
here because every online node sits on one LAN.

History worth keeping: relayed RPC was banned in the planner after it aborted coordinator engines
(`ggml_backend_rpc_add_server`) rather than failing softly, and the ban outlived its cause. Two things
made the ban wrong. The agent now establishes the path *before* the engine starts - it opens each local
port, waits for a connection path, and only then execs `llama-server` - so the engine never dials a
socket with nothing behind it. And the ban had been paired with `direct: []` in every assignment, which
meant even LAN-local pairs were relayed: the transport field names the authenticated substrate, not a
ban on direct paths.

## Model weights live on the nodes

The control never carries weights. A profile declares how to obtain them - `download.files[]` with a URL,
a byte count and a sha256 - and the catalog shows that source next to a model the node does not have.
The node fetches only on its owner's confirmation, in its own local UI, re-hashing what lands so control
only ever sees verified files. The planner will not place a model a node does not already hold, so a new
model needs one owner-confirmed fetch per node before it can serve.

`bonsai-2-27b-q2` (PrismML Ternary Bonsai 2 27B, ternary Q2_0 GGUF on the qwen35 arch) is a catalog
entry built this way: 64 layers, 98 MiB each measured from the file's tensor table, rank 28 - below the
27B it compresses, above the 35B-A3B. Context is capped at 32768 per row on purpose: this arch costs
262144 bytes of f16 KV per token, so the 262144 it was trained with would need 64 GiB of KV. The shipped
engine already carries the Q2_0 and Q1_0 tensor types, so Prism's own build is not required. Vision is
not wired: the profile format has no mmproj field.

## Releasing an agent build to the fleet

The node agent ships as a **signed release** in the controller's data dir, not as a git checkout: nodes
pull it with their own updater (`~/.swarmlet/logs/agent.out.log` shows `verified release <seq>` →
`started agent …` → `activated release <seq>`), and the feed refuses to move backwards.

```sh
# on the build host (the engine payload must be native for the target platform)
cd swarmlet
SWARMLET_ENGINE_DIST=<a previous release's engine dir> bun run node-agent/build.ts darwin
tar czf /tmp/agent-<platform>-<arch>-<seq>.tar.gz -C dist/agent/darwin swarmlet-node engine

# on the host running the controller (the signing key lives in the data dir; publishing never generates one)
scp /tmp/agent-<platform>-<arch>-<seq>.tar.gz root@the-shop:/root/
ssh root@the-shop 'mkdir -p /src-<seq> && tar xzf /root/agent-<platform>-<arch>-<seq>.tar.gz -C /src-<seq> \
  && find /src-<seq> -name "._*" -delete && chmod -R a+rX /src-<seq>'
ssh root@the-shop 'docker run --rm --user 1000:1000 \
  -v /root/projects/swarmlet-control/build:/app \
  -v /root/projects/swarmlet-control/data:/data \
  -v /src-<seq>:/src:ro -w /app oven/bun:1.3.14-slim \
  bun run swarmlet/control/publish-release.ts /data /src darwin arm64 <seq> <version>'
```

Four traps, each learned the hard way on 2026-09-16:

1. **`bun` is not installed on the controller host.** Run the publisher *inside* the Bun image (`oven/bun:1.3.14-slim`, the same runtime the controller container uses) with the host's build dir, data dir and payload mounted.
2. **Run it as uid 1000 (`--user 1000:1000`)** — that is the `bun` user inside the container and the `claude` user on the host that owns the release tree (`drwx------`). Root-owned release files are what you get otherwise.
3. **`tar` from macOS preserves the builder's uid and mode.** A payload extracted as root stays `uid 501`, mode `700`, and uid 1000 then cannot read it (the publisher fails with `EACCES` in `publishRelease`). `chmod -R a+rX` after extraction.
4. **Strip AppleDouble files** (`find … -name '._*' -delete`): macOS tar adds ~17 of them for this payload, and an `._*.json` reaching a node once crashed production in a boot loop.

Verify after publishing: the feed's `sequence` advanced, `swarmlet-node`'s `sha256` in the manifest equals the
binary you built, and on a node that `~/.swarmlet/releases/<seq>-*/swarmlet-node` hashes the same. A release
that is wrong can be superseded (never rewritten) with a higher sequence.

### The installer bundle (`/agent/latest.tar.gz`) is a separate artifact — keep it current

`site/install.sh` does not install a release. It unpacks a single hand-built bundle into `~/swarmlet-agent`,
reinstalls the service unit, and that unit then runs whatever release the supervisor already has in
`~/.swarmlet/releases`. The bundle is served by the `swarmlet-web` container from
`/usr/share/nginx/html/agent/latest.tar.gz`. On 2026-09-17 it was a build from revision `b5bf4209` whose agent
matched **none** of the published releases — six days stale, which turns "re-run the installer to upgrade" into
a downgrade. The served `install.sh` was stale for the same reason (same image).

Rebuild it from the release you intend to install:

```sh
cd swarmlet/dist/agent && rm -rf /tmp/bundle && mkdir -p /tmp/bundle/darwin
cp -a darwin/swarmlet-node darwin/engine darwin/agent-build.json /tmp/bundle/darwin/
cd /tmp/bundle && tar czf /tmp/latest.tar.gz darwin && shasum -a 256 /tmp/latest.tar.gz > /tmp/latest.tar.gz.sha256
scp /tmp/latest.tar.gz /tmp/latest.tar.gz.sha256 site/install.sh root@the-shop:/root/agent-upload/
ssh the-shop 'docker cp /root/agent-upload/latest.tar.gz swarmlet-web:/usr/share/nginx/html/agent/latest.tar.gz
             docker cp /root/agent-upload/latest.tar.gz.sha256 swarmlet-web:/usr/share/nginx/html/agent/latest.tar.gz.sha256
             docker cp /root/agent-upload/install.sh swarmlet-web:/usr/share/nginx/html/install.sh'
```

Three facts this cost a day to learn:

1. **`docker cp` is not durable.** Recreating the `swarmlet-web` container reverts both files to whatever the
   image holds. The real fix is to COPY the bundle into the site image at build time, so the artifact cannot
   drift from the releases again.
2. **The bundle is darwin-arm64 only, on purpose.** `install.sh` refuses any other platform with "no bundle is
   published for `<os>/<arch>`" instead of installing something wrong; a non-macOS node takes
   `SWARMLET_BUNDLE_URL` explicitly.
3. **Verify by hash, never by success.** The bundle's `darwin/swarmlet-node` must hash equal to the
   `swarmlet-node` sha256 in the release manifest it was built from, and the served `.sha256` must match the
   served tarball. A 200 response and a completed install prove nothing about freshness — this is exactly how a
   six-day-old bundle sat behind a "re-run to upgrade" instruction.

### A node that cannot hold a control session can only be rescued by the installer

The supervisor installs a release only after a health gate. That gate used to require `connected: true` from the
running agent; `2026091701` changed the pre-swap check so it no longer does (the trial still does, and only when
the outgoing release was connected). A node still running an older build keeps the old gate, so a node whose
control session is broken cannot install the fix that would repair it. That is a bootstrap deadlock, and it is
why one node sat five days and ~100 reconnects a day behind while its heartbeats reached control the whole time.

Spot it: the node's `releaseSequence` stays put — in the control's stored metrics for that node, or
`curl -s http://127.0.0.1:47800/api/status` on the machine — while its metrics keep arriving.

The escape hatch is the installer, which needs no session:

```sh
curl -fsSL https://app.swarmlet.ai/install.sh | bash -s -- --upgrade
```

It installs a current supervisor, which then installs the current release by itself within minutes. Nothing else
reaches such a node: the control can assign work, but it cannot push config or trigger an install.
