# Hosted control plane

The control plane can serve the authenticated web workspace at `https://app.swarmlet.ai`. Engines and model files remain on the participating nodes. The controller carries enrollment, routing, relay traffic, deployment state and signed update artifacts.

Public web access is opt-in with `SWARMLET_PUBLIC_WEB=1`. Without it, the existing private-web policy remains in force. Admin API and browser chat require the admin token or login cookie; inference-only keys cannot administer the fleet. HTTPS login cookies are Secure, HttpOnly and SameSite=Strict. Forwarded requests cannot acquire loopback admin privileges. Disable LAN enrollment on a public host with `SWARMLET_LAN_AUTO_ENROLL=0`.

Use `compose.control.prod.yml` with the existing `traefik-public` network and Cloudflare-only Traefik middleware. It is a separate Compose project from the landing page. Set `SWARMLET_REVISION` to the shipping source revision and `SWARMLET_CONTROL_DATA` to a dedicated persistent directory writable by the image's `bun` user. The image uses Bun 1.3.14 and runs no inference engines.

Before migration, save node configurations and back up the complete controller data directory, including `control.json`, `control.sqlite`, `keys/` and `releases/`. Stop managed inference and shut down the old controller before the final state copy. Preserve the signing key: enrolled nodes pin it, and changing it would invalidate both their controller binding and release signatures. Never run two independent controllers against copies of the same live state.

After starting the hosted service, verify anonymous admin requests return 401, authenticate through the browser, and reconnect each existing node to the new HTTPS/WSS address. Existing node IDs, offers and signing-key pins must match their pre-migration records. Restore the saved deployment intent and verify generation over the public route.

Finally publish a higher signed release sequence, allow the normal node updater to activate it, and verify the installed files against the signed manifest and the actual running executable path. A successful image build or a healthy web page alone does not verify node migration or automatic updates.
