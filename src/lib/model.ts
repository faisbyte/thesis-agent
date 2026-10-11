import { config } from "./config";
import type { FetchFn } from "./fetcher";

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  /** JSON schema the reply must follow (structured outputs). */
  schema?: object;
}

export interface ModelResponse {
  text: string;
  stopReason: string;
  model: string;
  /** Billed tokens for this call, when the API reports them. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** What verify.ts calls. Tests pass a fake. */
export type ModelFn = (req: ModelRequest) => Promise<ModelResponse>;

export class ModelError extends Error {}

const API_URL = "https://api.anthropic.com/v1/messages";

/**
 * One call to the Anthropic Messages API with plain fetch. Retries once on
 * network error, 429 or 5xx. Throws ModelError on anything that isn't a
 * usable text reply (including a refusal).
 */
export function anthropicModel(opts: { apiKey?: string; fetchFn?: FetchFn } = {}): ModelFn {
  return async (req) => {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ModelError("ANTHROPIC_API_KEY is not set");
    const fetchFn = opts.fetchFn ?? fetch;

    const body = {
      model: config.anthropicModel,
      max_tokens: config.anthropicMaxTokens,
      system: req.system,
      messages: req.messages,
      output_config: {
        effort: config.anthropicEffort,
        ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}),
      },
      // If a safety classifier declines, let the API re-run on a fallback model.
      fallbacks: "default",
    };

    let res: Response | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await fetchFn(API_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "server-side-fallback-2026-07-01",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.anthropicTimeoutMs),
        });
      } catch (err) {
        if (attempt === 2) throw new ModelError(`Anthropic API request failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 1) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, Number(res!.headers.get("retry-after") ?? 2) * 1000));
        continue;
      }
      break;
    }

    const data = (await res!.json().catch(() => null)) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { type: string; message: string };
    } | null;
    if (!res!.ok) {
      throw new ModelError(`Anthropic API ${res!.status}: ${data?.error?.message ?? "unknown error"}`);
    }
    if (data?.stop_reason === "refusal") throw new ModelError("the model declined to answer (refusal)");

    const text = (data?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const usage = data?.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : undefined;
    return { text, stopReason: data?.stop_reason ?? "unknown", model: data?.model ?? config.anthropicModel, usage };
  };
}
