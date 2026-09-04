// The UI assets are imported `with { type: "text" }`, which Bun turns into strings. tsc knows nothing
// about .js/.css text imports, so declare them here. The pattern differs from node-agent/ui/assets.d.ts
// on purpose: two identical wildcard declarations would merge and collide.
declare module "*app.js" { const text: string; export default text; }
declare module "*style.css" { const text: string; export default text; }
