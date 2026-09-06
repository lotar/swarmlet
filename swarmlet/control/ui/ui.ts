// Web UI of the control plane. The three static assets are embedded as text at build time so the
// compiled binary carries them. The page talks to /api/* (admin cookie set by POST /login) and
// shows a login form when a call returns 401; see server.ts for the routes.

import indexHtml from "./index.html" with { type: "text" };
import appJs from "./app.js" with { type: "text" };
import styleCss from "./style.css" with { type: "text" };
import processingJs from "../../shared/ui/processing.js" with { type: "text" };
import processingCss from "../../shared/ui/processing.css" with { type: "text" };

// bun-types declares `*.html` as an HTMLBundle (for Bun.serve routes); `type: "text"` makes it a string.
const ASSETS: Record<string, { body: string; type: string }> = {
  "/": { body: indexHtml as unknown as string, type: "text/html; charset=utf-8" },
  "/app.js": { body: appJs, type: "application/javascript; charset=utf-8" },
  "/processing.js": { body: processingJs, type: "application/javascript; charset=utf-8" },
  "/processing.css": { body: processingCss, type: "text/css; charset=utf-8" },
  "/style.css": { body: styleCss, type: "text/css; charset=utf-8" },
};

/** Serve a UI asset; null when `path` is not a UI path (the caller falls through to its API or 404). */
export function serveUi(req: Request, path: string): Response | null {
  const asset = ASSETS[path === "/index.html" ? "/" : path];
  if (!asset) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
  }
  return new Response(req.method === "HEAD" ? null : asset.body, {
    headers: { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
