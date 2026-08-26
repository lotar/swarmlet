// L0 — Model Contract client.
// Talks to any OpenAI-compatible endpoint (llama-server in production,
// core/mock.ts in tests). The base model is a config line: nothing about a
// specific model is hardcoded; identity comes from config.json + probe.

import type { ChatMsg, ChatOptions, L0Client, ModelManifest } from "./types.ts";
import { loadConfig, manifestFromConfig, resolveFromRoot, type SinConfig } from "./config.ts";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface ModelsProbeResponse {
  data?: Array<{ id?: string }>;
}

export class HttpL0Client implements L0Client {
  private cachedManifest: ModelManifest | null = null;

  constructor(
    public readonly config: SinConfig,
    /** Endpoint override (e.g. mock server URL in tests). Empty = llama-server from config. */
    public readonly endpointOverride: string = "",
  ) {}

  static async fromConfig(
    opts: { configPath?: string; endpoint?: string } = {},
  ): Promise<HttpL0Client> {
    const cfgPath = opts.configPath
      ? resolveFromRoot(opts.configPath)
      : undefined;
    const cfg = await loadConfig(cfgPath);
    return new HttpL0Client(cfg, opts.endpoint ?? "");
  }

  get endpoint(): string {
    if (this.endpointOverride) return this.endpointOverride;
    const { host, port } = this.config.llamaServer;
    return `http://${host}:${port}`;
  }

  get model(): string {
    return this.config.baseModel.name;
  }

  async healthy(): Promise<boolean> {
    for (const path of ["/health", "/v1/models"]) {
      try {
        const res = await fetch(`${this.endpoint}${path}`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return true;
      } catch {
        // try next probe
      }
    }
    return false;
  }

  async manifest(): Promise<ModelManifest> {
    if (this.cachedManifest) return this.cachedManifest;
    const base = manifestFromConfig(this.config, this.endpoint);
    // Probe refines what the endpoint itself reports (model id), never the
    // capability fields — those are owned by config so a swap is one line.
    try {
      const res = await fetch(`${this.endpoint}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as ModelsProbeResponse;
        const id = body.data?.[0]?.id;
        if (id) base.name = id;
      }
    } catch {
      // offline / not yet booted: config values stand
    }
    this.cachedManifest = base;
    return base;
  }

  async chat(messages: ChatMsg[], opts: ChatOptions = {}): Promise<string> {
    // Churn-tolerant transport: connect-level failures (ECONNREFUSED/RESET,
    // "Unable to connect") get ONE retry after a short backoff. HTTP errors
    // (400/500 from the model) do NOT retry — they are deterministic answers.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.chatOnce(messages, opts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const connectLevel =
          /unable to connect|econnrefused|econnreset|socket|fetch failed/i.test(msg) &&
          !/HTTP \d+/.test(msg);
        if (!connectLevel || attempt >= 1) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  private async chatOnce(messages: ChatMsg[], opts: ChatOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0, // determinism rule: default 0
      seed: opts.seed,
      max_tokens: opts.maxTokens ?? 512,
      stream: false,
    };
    if (opts.cachePrompt !== undefined) body.cache_prompt = opts.cachePrompt;
    const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Generous ceiling: eval instances against slow/distributed backends
      // may legitimately run minutes. Override with SIN_L0_TIMEOUT_MS.
      signal: AbortSignal.timeout(Number(process.env.SIN_L0_TIMEOUT_MS ?? 300_000)),
    });
    if (!res.ok) {
      throw new Error(
        `L0 chat failed: HTTP ${res.status} ${await safeText(res)}`,
      );
    }
    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("L0 chat returned no message content");
    }
    return content;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}
