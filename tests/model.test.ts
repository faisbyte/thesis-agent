import { describe, expect, it } from "vitest";
import { anthropicModel, ModelError } from "../src/lib/model";
import { config } from "../src/lib/config";

function fakeApi(...responses: { status?: number; body: object }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "retry-after": "0" } });
  };
  return { fetchFn, calls };
}

const okBody = { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":1}' }] };
const request = { system: "sys", messages: [{ role: "user" as const, content: "hi" }], schema: { type: "object" } };

describe("anthropicModel", () => {
  it("sends a Messages API request with plain fetch and returns the text", async () => {
    const api = fakeApi({ body: okBody });
    const res = await anthropicModel({ apiKey: "test-key", fetchFn: api.fetchFn })(request);
    expect(res).toEqual({ text: '{"a":1}', stopReason: "end_turn", model: "claude-opus-5-5" });

    const { url, init } = api.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: config.anthropicModel,
      system: "sys",
      messages: request.messages,
      output_config: { effort: config.anthropicEffort, format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(body.thinking).toBeUndefined();
  });

  it("retries once on overload, never on 4xx", async () => {
    const overloaded = fakeApi({ status: 529, body: { error: { type: "overloaded_error", message: "Overloaded" } } }, { body: okBody });
    await anthropicModel({ apiKey: "k", fetchFn: overloaded.fetchFn })(request);
    expect(overloaded.calls).toHaveLength(2);

    const bad = fakeApi({ status: 400, body: { error: { type: "invalid_request_error", message: "bad field" } } });
    await expect(anthropicModel({ apiKey: "k", fetchFn: bad.fetchFn })(request)).rejects.toThrow(/400: bad field/);
    expect(bad.calls).toHaveLength(1);
  });

  it("treats a refusal as an error, not a reply", async () => {
    const api = fakeApi({ body: { ...okBody, stop_reason: "refusal", content: [] } });
    await expect(anthropicModel({ apiKey: "k", fetchFn: api.fetchFn })(request)).rejects.toThrow(ModelError);
  });

  it("fails clearly without an API key", async () => {
    const api = fakeApi({ body: okBody });
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(anthropicModel({ fetchFn: api.fetchFn })(request)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
    expect(api.calls).toHaveLength(0);
  });
});
