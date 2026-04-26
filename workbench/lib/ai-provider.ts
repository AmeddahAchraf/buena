// Provider abstraction for LLM calls. Wraps xAI's OpenAI-compatible Grok API.
// Adds: structured logging, exponential-backoff retry on transient errors,
// JSON parsing with fenced-block recovery, and a runtime stats counter
// the UI can surface in the metric bar.
//
// Default model: grok-4-fast-reasoning — xAI's efficient reasoning tier.
// We pass reasoning_effort=low for the classifier (cheap, fast verdicts) and
// rely on JSON mode (response_format=json_object) for structured outputs.

import OpenAI from "openai";

export interface AIStats {
  enabled: boolean;
  model: string;
  calls: number;
  success: number;
  failed: number;
  retries: number;
  avg_ms: number | null;
  last_ms: number | null;
  last_error: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface GenerateJsonOpts {
  system: string;
  user: string;
  schemaHint?: string;
  label?: string;
  maxTokens?: number;
}

export interface GenerateTextOpts {
  system: string;
  user: string;
  label?: string;
  maxTokens?: number;
}

export interface AIProvider {
  enabled: boolean;
  modelName: string;
  generateJson<T = unknown>(opts: GenerateJsonOpts): Promise<T | null>;
  generateText(opts: GenerateTextOpts): Promise<string | null>;
  stats(): AIStats;
  resetStats(): void;
}

class XAIProvider implements AIProvider {
  enabled: boolean;
  modelName: string;
  private client: OpenAI | null = null;
  private _stats = {
    calls: 0,
    success: 0,
    failed: 0,
    retries: 0,
    totalMs: 0,
    last_ms: null as number | null,
    last_error: null as string | null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };

  constructor() {
    const apiKey = process.env.XAI_API_KEY || "";
    this.modelName = process.env.XAI_MODEL || "grok-4-fast-reasoning";
    const baseURL = process.env.XAI_BASE_URL || "https://api.x.ai/v1";
    this.enabled = Boolean(apiKey);
    if (this.enabled) {
      this.client = new OpenAI({ apiKey, baseURL });
    }
  }

  async generateJson<T = unknown>(opts: GenerateJsonOpts): Promise<T | null> {
    const txt = await this.callGrok({
      system:
        opts.system +
        "\n\nReturn ONLY a single JSON object. No prose, no commentary, no markdown fences. The first character must be `{` and the last character must be `}`." +
        (opts.schemaHint ? `\n\nSchema:\n${opts.schemaHint}` : ""),
      user: opts.user,
      label: opts.label ?? "json",
      maxTokens: opts.maxTokens ?? 4096,
      jsonMode: true,
    });
    if (txt == null) return null;
    return parseJsonLoose<T>(txt);
  }

  async generateText(opts: GenerateTextOpts): Promise<string | null> {
    return this.callGrok({
      system: opts.system,
      user: opts.user,
      label: opts.label ?? "text",
      maxTokens: opts.maxTokens ?? 16000,
      jsonMode: false,
    });
  }

  private async callGrok(opts: {
    system: string;
    user: string;
    label: string;
    maxTokens: number;
    jsonMode: boolean;
  }): Promise<string | null> {
    if (!this.enabled || !this.client) return null;

    const t0 = Date.now();
    this._stats.calls += 1;
    const MAX_ATTEMPTS = 4;

    // reasoning_effort is supported by grok-3-mini but not by grok-4-fast-*.
    // We only pass it for models that accept it; otherwise default reasoning.
    const supportsReasoningEffort = /grok-3-mini/.test(this.modelName);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const params: Record<string, unknown> = {
          model: this.modelName,
          max_tokens: opts.maxTokens,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        };
        if (opts.jsonMode) {
          params.response_format = { type: "json_object" };
        }
        if (supportsReasoningEffort) {
          params.reasoning_effort = "low";
        }

        const completion = await this.client.chat.completions.create(
          params as unknown as Parameters<
            typeof this.client.chat.completions.create
          >[0],
        );
        // Non-streaming returns ChatCompletion (not a stream).
        const choice = (completion as OpenAI.ChatCompletion).choices?.[0];
        const text = choice?.message?.content ?? "";
        const usage = (completion as OpenAI.ChatCompletion).usage;

        const ms = Date.now() - t0;
        this._stats.success += 1;
        this._stats.totalMs += ms;
        this._stats.last_ms = ms;
        this._stats.last_error = null;
        if (usage) {
          this._stats.input_tokens += usage.prompt_tokens ?? 0;
          this._stats.output_tokens += usage.completion_tokens ?? 0;
          // xAI may expose cached_tokens via prompt_tokens_details
          const cached =
            (usage as unknown as {
              prompt_tokens_details?: { cached_tokens?: number };
            }).prompt_tokens_details?.cached_tokens ?? 0;
          this._stats.cache_read_tokens += cached;
        }
        const tag = attempt > 1 ? ` · attempt ${attempt}` : "";
        const tok = usage
          ? ` · ${usage.prompt_tokens}in/${usage.completion_tokens}out`
          : "";
        // eslint-disable-next-line no-console
        console.log(
          `\x1b[32m[ai ✓]\x1b[0m ${this.modelName} · ${ms}ms${tok} · ${opts.label}${tag}`,
        );
        return text;
      } catch (err) {
        const e = err as Error & { status?: number };
        const msg = e.message || String(e);
        const status = e.status ?? 0;
        const isRetryable =
          status === 429 ||
          status >= 500 ||
          /timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg);

        if (isRetryable && attempt < MAX_ATTEMPTS) {
          this._stats.retries += 1;
          const backoff = Math.min(
            8000,
            500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250),
          );
          const why =
            status === 429
              ? "rate-limited"
              : status >= 500
                ? `server ${status}`
                : "transient";
          // eslint-disable-next-line no-console
          console.warn(
            `\x1b[33m[ai ⏳]\x1b[0m ${this.modelName} · ${opts.label} · ${why}, retrying in ${backoff}ms (${attempt}/${MAX_ATTEMPTS - 1})`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        const ms = Date.now() - t0;
        this._stats.failed += 1;
        this._stats.last_ms = ms;
        this._stats.last_error = msg.slice(0, 240);
        // eslint-disable-next-line no-console
        console.warn(
          `\x1b[31m[ai ✗]\x1b[0m ${this.modelName} · ${ms}ms · ${opts.label} · ${this._stats.last_error}`,
        );
        return null;
      }
    }
    return null;
  }

  stats(): AIStats {
    return {
      enabled: this.enabled,
      model: this.modelName,
      calls: this._stats.calls,
      success: this._stats.success,
      failed: this._stats.failed,
      retries: this._stats.retries,
      avg_ms:
        this._stats.success > 0
          ? Math.round(this._stats.totalMs / this._stats.success)
          : null,
      last_ms: this._stats.last_ms,
      last_error: this._stats.last_error,
      input_tokens: this._stats.input_tokens,
      output_tokens: this._stats.output_tokens,
      cache_read_tokens: this._stats.cache_read_tokens,
      cache_creation_tokens: this._stats.cache_creation_tokens,
    };
  }

  resetStats() {
    this._stats = {
      calls: 0,
      success: 0,
      failed: 0,
      retries: 0,
      totalMs: 0,
      last_ms: null,
      last_error: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
  }
}

// Permissive JSON parse: tolerates fenced blocks, leading/trailing prose,
// and trailing commas. Even with response_format=json_object some models
// occasionally wrap output in fences when the system prompt is verbose.
function parseJsonLoose<T>(raw: string): T | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch {
    const cleaned = slice.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return null;
    }
  }
}

// Gemini provider via Google's OpenAI-compatible endpoint
// (https://generativelanguage.googleapis.com/v1beta/openai/). Supports
// response_format: json_object, prompt caching, and standard chat completions
// — so it slots into the same code path as xAI with only config differences.
class GeminiProvider implements AIProvider {
  enabled: boolean;
  modelName: string;
  private client: OpenAI | null = null;
  private _stats = {
    calls: 0,
    success: 0,
    failed: 0,
    retries: 0,
    totalMs: 0,
    last_ms: null as number | null,
    last_error: null as string | null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY || "";
    this.modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const baseURL =
      process.env.GEMINI_BASE_URL ||
      "https://generativelanguage.googleapis.com/v1beta/openai/";
    this.enabled = Boolean(apiKey);
    if (this.enabled) {
      this.client = new OpenAI({ apiKey, baseURL });
    }
  }

  async generateJson<T = unknown>(opts: GenerateJsonOpts): Promise<T | null> {
    const txt = await this.callGemini({
      system:
        opts.system +
        "\n\nReturn ONLY a single JSON object. No prose, no commentary, no markdown fences. The first character must be `{` and the last character must be `}`." +
        (opts.schemaHint ? `\n\nSchema:\n${opts.schemaHint}` : ""),
      user: opts.user,
      label: opts.label ?? "json",
      maxTokens: opts.maxTokens ?? 4096,
      jsonMode: true,
    });
    if (txt == null) return null;
    return parseJsonLoose<T>(txt);
  }

  async generateText(opts: GenerateTextOpts): Promise<string | null> {
    return this.callGemini({
      system: opts.system,
      user: opts.user,
      label: opts.label ?? "text",
      maxTokens: opts.maxTokens ?? 16000,
      jsonMode: false,
    });
  }

  private async callGemini(opts: {
    system: string;
    user: string;
    label: string;
    maxTokens: number;
    jsonMode: boolean;
  }): Promise<string | null> {
    if (!this.enabled || !this.client) return null;

    const t0 = Date.now();
    this._stats.calls += 1;
    const MAX_ATTEMPTS = 4;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const params: Record<string, unknown> = {
          model: this.modelName,
          max_tokens: opts.maxTokens,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        };
        if (opts.jsonMode) {
          params.response_format = { type: "json_object" };
        }

        const completion = await this.client.chat.completions.create(
          params as unknown as Parameters<
            typeof this.client.chat.completions.create
          >[0],
        );
        const choice = (completion as OpenAI.ChatCompletion).choices?.[0];
        const text = choice?.message?.content ?? "";
        const usage = (completion as OpenAI.ChatCompletion).usage;

        const ms = Date.now() - t0;
        this._stats.success += 1;
        this._stats.totalMs += ms;
        this._stats.last_ms = ms;
        this._stats.last_error = null;
        if (usage) {
          this._stats.input_tokens += usage.prompt_tokens ?? 0;
          this._stats.output_tokens += usage.completion_tokens ?? 0;
          const cached =
            (usage as unknown as {
              prompt_tokens_details?: { cached_tokens?: number };
            }).prompt_tokens_details?.cached_tokens ?? 0;
          this._stats.cache_read_tokens += cached;
        }
        const tag = attempt > 1 ? ` · attempt ${attempt}` : "";
        const tok = usage
          ? ` · ${usage.prompt_tokens}in/${usage.completion_tokens}out`
          : "";
        // eslint-disable-next-line no-console
        console.log(
          `\x1b[32m[ai ✓]\x1b[0m ${this.modelName} · ${ms}ms${tok} · ${opts.label}${tag}`,
        );
        return text;
      } catch (err) {
        const e = err as Error & { status?: number };
        const msg = e.message || String(e);
        const status = e.status ?? 0;
        const isRetryable =
          status === 429 ||
          status >= 500 ||
          /timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg);

        if (isRetryable && attempt < MAX_ATTEMPTS) {
          this._stats.retries += 1;
          const backoff = Math.min(
            8000,
            500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250),
          );
          const why =
            status === 429
              ? "rate-limited"
              : status >= 500
                ? `server ${status}`
                : "transient";
          // eslint-disable-next-line no-console
          console.warn(
            `\x1b[33m[ai ⏳]\x1b[0m ${this.modelName} · ${opts.label} · ${why}, retrying in ${backoff}ms (${attempt}/${MAX_ATTEMPTS - 1})`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        const ms = Date.now() - t0;
        this._stats.failed += 1;
        this._stats.last_ms = ms;
        this._stats.last_error = msg.slice(0, 240);
        // eslint-disable-next-line no-console
        console.warn(
          `\x1b[31m[ai ✗]\x1b[0m ${this.modelName} · ${ms}ms · ${opts.label} · ${this._stats.last_error}`,
        );
        return null;
      }
    }
    return null;
  }

  stats(): AIStats {
    return {
      enabled: this.enabled,
      model: this.modelName,
      calls: this._stats.calls,
      success: this._stats.success,
      failed: this._stats.failed,
      retries: this._stats.retries,
      avg_ms:
        this._stats.success > 0
          ? Math.round(this._stats.totalMs / this._stats.success)
          : null,
      last_ms: this._stats.last_ms,
      last_error: this._stats.last_error,
      input_tokens: this._stats.input_tokens,
      output_tokens: this._stats.output_tokens,
      cache_read_tokens: this._stats.cache_read_tokens,
      cache_creation_tokens: this._stats.cache_creation_tokens,
    };
  }

  resetStats() {
    this._stats = {
      calls: 0,
      success: 0,
      failed: 0,
      retries: 0,
      totalMs: 0,
      last_ms: null,
      last_error: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
  }
}

let _provider: AIProvider | null = null;
export function getAI(): AIProvider {
  if (_provider) return _provider;
  // Provider selection:
  //   1. Explicit AI_PROVIDER env wins ("gemini" | "xai")
  //   2. Otherwise: prefer Gemini if its key is set, else fall back to xAI
  // This lets you flip providers by setting GEMINI_API_KEY in .env.local without
  // touching code.
  const explicit = (process.env.AI_PROVIDER || "").toLowerCase();
  const useGemini =
    explicit === "gemini" ||
    (!explicit && Boolean(process.env.GEMINI_API_KEY));
  _provider = useGemini ? new GeminiProvider() : new XAIProvider();
  return _provider;
}
