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
