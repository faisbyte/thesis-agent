import { describe, expect, it } from "vitest";
import { canonicalId, fetchUrl, FetchError, parseArxivId } from "../src/lib/fetcher";
import { fakeFetch } from "./helpers";

const fast = { retryDelayMs: 0 };

describe("arxiv URL detection", () => {
  it.each([
    ["https://arxiv.org/abs/2401.12345", "2401.12345"],
    ["https://arxiv.org/abs/2401.12345v3", "2401.12345"],
    ["https://arxiv.org/pdf/2401.12345", "2401.12345"],
    ["https://arxiv.org/pdf/2401.12345v2.pdf", "2401.12345"],
    ["http://www.arxiv.org/pdf/2401.12345.pdf", "2401.12345"],
    ["https://arxiv.org/html/2401.12345v1", "2401.12345"],
    ["https://arxiv.org/abs/hep-th/9711200v3", "hep-th/9711200"],
    ["https://arxiv.org/abs/math.GT/0309136", "math.GT/0309136"],
    ["https://arxiv.org/abs/1706.03762?context=cs", "1706.03762"],
  ])("%s -> %s", (url, id) => {
    expect(parseArxivId(url)).toBe(id);
    expect(canonicalId(url)).toBe(`arxiv:${id}`);
  });

  it("ignores non-arxiv URLs", () => {
    expect(parseArxivId("https://example.com/abs/2401.12345")).toBeNull();
    expect(parseArxivId("https://arxiv.org/list/cs.CL/recent")).toBeNull();
  });

  it("normalizes non-arxiv URLs", () => {
    expect(canonicalId("HTTPS://Example.COM/paper/?utm_source=x#section-2")).toBe("https://example.com/paper");
  });
});

describe("fetchUrl", () => {
  it("sends a descriptive User-Agent", async () => {
    let ua: string | null = null;
    await fetchUrl("https://x.test/", async (_url, init) => {
      ua = new Headers(init?.headers).get("user-agent");
      return new Response("ok");
    });
    expect(ua).toMatch(/thesis-agent/);
  });

  it("retries once on 5xx", async () => {
    let n = 0;
    const res = await fetchUrl("https://x.test/", async () => new Response("", { status: ++n === 1 ? 503 : 200 }), fast);
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  it("gives up after one retry on repeated 5xx and returns the status", async () => {
    let n = 0;
    const res = await fetchUrl("https://x.test/", async () => (n++, new Response("", { status: 502 })), fast);
    expect(res.status).toBe(502);
    expect(n).toBe(2);
  });

  it("never retries 4xx", async () => {
    const { fn, calls } = fakeFetch({});
    const res = await fetchUrl("https://x.test/missing", fn, fast);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("retries once on network error, then throws", async () => {
    let n = 0;
    const failing = async () => {
      n++;
      throw new TypeError("fetch failed");
    };
    await expect(fetchUrl("https://x.test/", failing, fast)).rejects.toThrow(FetchError);
    expect(n).toBe(2);
  });

  it("times out and retries", async () => {
    let n = 0;
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        n++;
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    await expect(fetchUrl("https://x.test/", hanging, { timeoutMs: 20, retryDelayMs: 0 })).rejects.toThrow(/timeout/);
    expect(n).toBe(2);
  });
});
