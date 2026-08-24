// Deterministic mock of an OpenAI-compatible chat endpoint (llama-server shape).
// Used by unit tests and any offline path. Answers are a pure function of
// (seed, messages) — identical requests always yield byte-identical output,
// which is what makes redundant-execution cross-checks meaningful.

import type { ChatMsg } from "./types.ts";

export interface MockServerHandle {
  url: string;
  port: number;
  stop(): void;
  /** Number of chat completions served (for assertions). */
  requestCount(): number;
}

/** FNV-1a 32-bit — stable across runs, no Math.random anywhere. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic given an integer seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
  "golf", "hotel", "india", "juliet", "kilo", "lima",
];

/**
 * The exact content the mock returns for a request — exported so tests can
 * compute expectations without HTTP.
 * Always valid JSON: { "answer": string, "value": number, "tags": string[] }.
 */
export function mockContent(seed: number, messages: ChatMsg[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const key = `${seed}:${lastUser ? lastUser.content : ""}`;
  const h = fnv1a(key);
  const rand = mulberry32(h);
  const value = h % 1000;
  const wordCount = 2 + (h % 4);
  const tags: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    tags.push(MOCK_WORDS[Math.floor(rand() * MOCK_WORDS.length)] ?? "x");
  }
  const answer = tags.join("-");
  return JSON.stringify({ answer, value, tags });
}

export function startMockServer(
  opts: { seed?: number; port?: number } = {},
): MockServerHandle {
  const seed = opts.seed ?? 42;
  let count = 0;
  const server = Bun.serve({
    port: opts.port ?? 0, // 0 = ephemeral
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "mock-model" }] });
      }
      if (
        req.method === "POST" &&
        url.pathname === "/v1/chat/completions"
      ) {
        return req
          .json()
          .then((body: unknown) => {
            const messages =
              typeof body === "object" && body !== null && "messages" in body
                ? ((body as { messages: ChatMsg[] }).messages as ChatMsg[])
                : [];
            count++;
            // Seed from request wins if present (deterministic per-request).
            const reqSeed =
              typeof body === "object" && body !== null && "seed" in body &&
              typeof (body as { seed: unknown }).seed === "number"
                ? (body as { seed: number }).seed
                : seed;
            return Response.json({
              id: `chatcmpl-mock-${fnv1a(JSON.stringify(messages))}`,
              object: "chat.completion",
              model: "mock-model",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: mockContent(reqSeed, messages),
                  },
                  finish_reason: "stop",
                },
              ],
            });
          })
          .catch(
            () =>
              new Response("bad request body", { status: 400 }),
          );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
    requestCount: () => count,
  };
}
