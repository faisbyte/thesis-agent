import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestResult } from "../src/lib/ingest";
import type { VerifyOptions, VerifyResult } from "../src/lib/verify";

// Mock the lib boundary the routes sit on: ingest, verify, the embedding model, and the DB file.
const ingestPaper = vi.fn<(url: string, opts: unknown) => Promise<IngestResult>>();
const verifyCitation = vi.fn<(opts: VerifyOptions) => Promise<VerifyResult>>();
vi.mock("@/lib/ingest", () => ({ ingestPaper: (url: string, opts: unknown) => ingestPaper(url, opts) }));
vi.mock("@/lib/verify", () => ({ verifyCitation: (opts: VerifyOptions) => verifyCitation(opts) }));
vi.mock("@/lib/retrieve-embed", () => ({ localEmbedder: () => ({ model: "mock", embedPassages: vi.fn(), embedQuery: vi.fn() }) }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { ...actual, openDb: () => actual.openDb(":memory:") };
});

const { POST: checkPost } = await import("../src/app/api/check/route");
const { POST: batchPost } = await import("../src/app/api/check-batch/route");
const { POST: ingestPost } = await import("../src/app/api/ingest/route");
const { GET: papersGet } = await import("../src/app/api/papers/route");

const post = (body: unknown) =>
  new Request("http://test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const ingested = (url: string, outcome: IngestResult["outcome"] = "REUSED"): IngestResult => ({
  outcome,
  paperId: `id:${url}`,
  title: "T",
  method: outcome === "FAILED" ? "failed" : "arxiv_html",
  chunkCount: outcome === "FAILED" ? 0 : 41,
  durationMs: 5,
  detail: outcome === "FAILED" ? "HTTP 404" : null,
});

const verdict = (opts: VerifyOptions): VerifyResult => ({
  paperId: opts.paper,
  sentence: opts.sentence,
  retriever: opts.retriever,
  verdict: "relevant",
  explanation: `checked: ${opts.sentence}`,
  evidence: [],
  chunks: [],
  grounded: true,
  modelCalls: 1,
  model: "mock-model",
  usage: { inputTokens: 1_000_000, outputTokens: 0 },
});

beforeEach(() => {
  ingestPaper.mockReset().mockImplementation(async (url) => ingested(url));
  verifyCitation.mockReset().mockImplementation(async (opts) => verdict(opts));
});

describe("POST /api/check-batch", () => {
  it("preserves input order and runs one item at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    verifyCitation.mockImplementation(async (opts) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Earlier items take longer: a parallel implementation would finish them out of order.
      await new Promise((r) => setTimeout(r, opts.sentence === "first" ? 30 : 1));
      order.push(opts.sentence);
      inFlight--;
      return verdict(opts);
    });
    const items = ["first", "second", "third"].map((s) => ({ url: "https://arxiv.org/abs/2401.04088", sentence: s }));
    const res = await batchPost(post({ items }));
    const { results } = await res.json();

    expect(results.map((r: { sentence: string }) => r.sentence)).toEqual(["first", "second", "third"]);
    expect(order).toEqual(["first", "second", "third"]);
    expect(maxInFlight).toBe(1);
  });

  it("keeps going after an item fails, and reports each failure in place", async () => {
    ingestPaper.mockImplementation(async (url) => ingested(url, url.includes("bad") ? "FAILED" : "REUSED"));
    verifyCitation.mockImplementation(async (opts) => {
      if (opts.sentence === "model breaks") throw new Error("model reply invalid after one retry");
      return verdict(opts);
    });
    const res = await batchPost(
      post({
        items: [
          { url: "https://ok.test/a", sentence: "one" },
          { url: "https://bad.test/b", sentence: "two" },
          { url: "https://ok.test/c", sentence: "model breaks" },
          { url: "", sentence: "no url" },
          { url: "https://ok.test/d", sentence: "five" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results).toHaveLength(5);
    expect(results.map((r: { error: string | null }) => r.error)).toEqual([
      null,
      "could not ingest paper: HTTP 404",
      "both check failed: model reply invalid after one retry",
      "missing paper URL",
      null,
    ]);
    expect(results[4].results[0].verdict).toBe("relevant");
    // The failed ingest never reached the model.
    expect(verifyCitation.mock.calls.map((c) => c[0].sentence)).toEqual(["one", "model breaks", "five"]);
  });

  it("rejects a malformed body", async () => {
    expect((await batchPost(post({ items: [{ url: 1 }] }))).status).toBe(400);
    expect((await batchPost(post({ nope: true }))).status).toBe(400);
  });
});

describe("POST /api/check", () => {
  it("ingests first, then verifies with the default (merged) retriever, and reports how the paper was obtained", async () => {
    ingestPaper.mockImplementation(async (url) => ingested(url, "FETCHED"));
    const res = await checkPost(post({ url: "https://arxiv.org/abs/2401.04088", sentence: "S" }));
    const body = await res.json();
    expect(ingestPaper).toHaveBeenCalledTimes(1);
    expect(body.ingest.outcome).toBe("FETCHED");
    expect(verifyCitation.mock.calls[0][0]).toMatchObject({ paper: "id:https://arxiv.org/abs/2401.04088", retriever: "both" });
    expect(body.results[0]).toMatchObject({ verdict: "relevant", retriever: "both", costUsd: 4 }); // 1M input tokens at $4/M
  });

  it("runs separate embed and keyword verdicts for retriever=side-by-side", async () => {
    const body = await (await checkPost(post({ url: "https://x.test/p", sentence: "S", retriever: "side-by-side" }))).json();
    expect(body.results.map((r: { retriever: string }) => r.retriever)).toEqual(["embed", "keyword"]);
  });

  it("does not call the model when the paper can't be ingested", async () => {
    ingestPaper.mockImplementation(async (url) => ingested(url, "FAILED"));
    const body = await (await checkPost(post({ url: "https://x.test/p", sentence: "S" }))).json();
    expect(body).toMatchObject({ error: "could not ingest paper: HTTP 404", results: [] });
    expect(verifyCitation).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await checkPost(post({ url: "https://x.test" }))).status).toBe(400);
    expect((await checkPost(post({ url: "https://x.test", sentence: "s", retriever: "bm25" }))).status).toBe(400);
  });
});

describe("POST /api/ingest and GET /api/papers", () => {
  it("returns the ingest result, 502 on failure", async () => {
    expect((await ingestPost(post({ url: "https://x.test/p" }))).status).toBe(200);
    ingestPaper.mockImplementation(async (url) => ingested(url, "FAILED"));
    expect((await ingestPost(post({ url: "https://x.test/p" }))).status).toBe(502);
    expect((await ingestPost(post({}))).status).toBe(400);
  });

  it("lists papers", async () => {
    const body = await (await papersGet()).json();
    expect(body).toEqual({ papers: [] });
  });
});
