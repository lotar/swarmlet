import { signObject } from "./sign.ts";

/** Read-only release downloads use the enrolled node identity, including through a tunnel. */
export function releaseFetcher(identity: { nodeId: string; keys: { priv: CryptoKey } }, fetcher: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET" || !url.pathname.startsWith("/releases/") || url.search || url.hash) throw new Error("invalid signed release request");
    const auth = await signObject({ kind: "swarmlet-release-read", nodeId: identity.nodeId, method, path: url.pathname, time: Date.now() }, identity.keys.priv);
    const headers = new Headers(init?.headers);
    headers.set("x-swarmlet-release-auth", JSON.stringify(auth));
    return fetcher(input, { ...init, headers, redirect: "error" });
  }) as typeof fetch;
}
