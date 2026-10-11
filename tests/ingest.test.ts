import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/lib/db";
import { ingestPaper } from "../src/lib/ingest";
import { ARXIV_ID, arxivRoutes, fakeFetch, fixture } from "./helpers";

const fetchOptions = { retryDelayMs: 0, timeoutMs: 1000 };
const ABS_URL = `https://arxiv.org/abs/${ARXIV_ID}v2`;
const PDF_URL = `https://arxiv.org/pdf/${ARXIV_ID}.pdf`;

const paperHtml = { body: fixture("arxiv-paper.html") };
const absHtml = { body: fixture("arxiv-abs.html") };
const pdf = { body: fixture("sample.pdf"), contentType: "application/pdf" };

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

const paperRow = (id: string) => db.prepare(`SELECT * FROM papers WHERE id = ?`).get(id) as Record<string, any> | undefined;
const chunkRows = (id: string) =>
  db.prepare(`SELECT * FROM chunks WHERE paper_id = ? ORDER BY ordinal`).all(id) as Record<string, any>[];
const logRows = () => db.prepare(`SELECT * FROM fetch_log ORDER BY id`).all() as Record<string, any>[];

describe("arxiv ingestion", () => {
  it("uses arxiv HTML when available and takes metadata from /abs/", async () => {
    const { fn, calls } = fakeFetch({ [arxivRoutes.html]: paperHtml, [arxivRoutes.abs]: absHtml, [arxivRoutes.pdf]: pdf });
    const r = await ingestPaper(ABS_URL, { db, fetchFn: fn, fetchOptions });

    expect(r).toMatchObject({ outcome: "FETCHED", paperId: `arxiv:${ARXIV_ID}`, method: "arxiv_html" });
    expect(calls).toEqual([arxivRoutes.html, arxivRoutes.abs]); // PDF never requested
    const row = paperRow(r.paperId)!;
    expect(row).toMatchObject({
      source_url: ABS_URL,
      canonical_url: arxivRoutes.html,
      arxiv_id: ARXIV_ID,
      title: "Grounded Citation Checking with Small Models",
      authors: "Example, Ada; Sample, Bo",
      http_status: 200,
      extraction_method: "arxiv_html",
    });
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.char_count).toBe(row.extracted_text.length);
    expect(chunkRows(r.paperId)).toHaveLength(r.chunkCount);
  });

  it("second ingest of the same paper makes zero HTTP calls and logs REUSED", async () => {
    const first = fakeFetch({ [arxivRoutes.html]: paperHtml, [arxivRoutes.abs]: absHtml });
    const r1 = await ingestPaper(ABS_URL, { db, fetchFn: first.fn, fetchOptions });

    const second = fakeFetch({ [arxivRoutes.html]: paperHtml, [arxivRoutes.abs]: absHtml });
    // Different URL form, same canonical id.
    const r2 = await ingestPaper(PDF_URL, { db, fetchFn: second.fn, fetchOptions });

    expect(second.calls).toHaveLength(0);
    expect(r2).toMatchObject({ outcome: "REUSED", paperId: r1.paperId, chunkCount: r1.chunkCount, method: "arxiv_html" });
    expect(logRows().map((l) => l.outcome)).toEqual(["FETCHED", "REUSED"]);
    expect(logRows()[1]).toMatchObject({ chunk_count: r1.chunkCount, bytes: 0 });
  });

  it.each([
    ["404", { status: 404, body: "not found" }],
    ["a non-paper page", { body: fixture("arxiv-html-stub.html") }],
  ])("falls back to PDF when arxiv HTML is %s", async (_label, htmlRoute) => {
    const { fn, calls } = fakeFetch({ [arxivRoutes.html]: htmlRoute, [arxivRoutes.pdf]: pdf, [arxivRoutes.abs]: absHtml });
    const r = await ingestPaper(ABS_URL, { db, fetchFn: fn, fetchOptions });

    expect(r).toMatchObject({ outcome: "FETCHED", method: "pdf" });
    expect(calls).toEqual([arxivRoutes.html, arxivRoutes.pdf, arxivRoutes.abs]);
    const row = paperRow(r.paperId)!;
    expect(row.canonical_url).toBe(arxivRoutes.pdf);
    expect(row.title).toBe("Grounded Citation Checking with Small Models"); // from /abs/, not the PDF
    expect(row.extracted_text).toContain("## 1 INTRODUCTION");
    expect(chunkRows(r.paperId).map((c) => c.heading)).toContain("1 INTRODUCTION");
  });

  it("still succeeds when /abs/ metadata is unavailable", async () => {
    const { fn } = fakeFetch({ [arxivRoutes.html]: paperHtml, [arxivRoutes.abs]: { status: 500 } });
    const r = await ingestPaper(ABS_URL, { db, fetchFn: fn, fetchOptions });
    expect(r.outcome).toBe("FETCHED");
    expect(paperRow(r.paperId)!.title).toBe("Grounded Citation Checking with Small Models"); // from the HTML <h1>
  });
});

describe("failures", () => {
  it("a failed fetch leaves the stored paper and other papers untouched", async () => {
    const ok = fakeFetch({
      [arxivRoutes.html]: paperHtml,
      [arxivRoutes.abs]: absHtml,
      "https://blog.test/post": { body: fixture("blog-article.html") },
    });
    await ingestPaper(ABS_URL, { db, fetchFn: ok.fn, fetchOptions });
    await ingestPaper("https://blog.test/post", { db, fetchFn: ok.fn, fetchOptions });
    const snapshot = () => ({
      papers: db.prepare(`SELECT * FROM papers ORDER BY id`).all(),
      chunks: db.prepare(`SELECT * FROM chunks ORDER BY id`).all(),
    });
    const before = snapshot();

    // Forced re-fetch while arxiv is down entirely.
    const down = fakeFetch({
      [arxivRoutes.html]: { status: 503 },
      [arxivRoutes.pdf]: { status: 503 },
      [arxivRoutes.abs]: { status: 503 },
    });
    const r = await ingestPaper(ABS_URL, { db, fetchFn: down.fn, fetchOptions, force: true });

    expect(r.outcome).toBe("FAILED");
    expect(r.detail).toMatch(/PDF HTTP 503/);
    expect(down.calls).toEqual([arxivRoutes.html, arxivRoutes.html, arxivRoutes.pdf, arxivRoutes.pdf]); // one retry each
    expect(snapshot()).toEqual(before);
    expect(logRows().at(-1)).toMatchObject({ outcome: "FAILED", http_status: 503, paper_id: `arxiv:${ARXIV_ID}` });
  });

  it("a failed fetch for a new paper records a 'failed' placeholder and is retried next time", async () => {
    const network = fakeFetch({ "https://gone.test/paper.pdf": async () => Promise.reject(new TypeError("fetch failed")) });
    const r = await ingestPaper("https://gone.test/paper.pdf", { db, fetchFn: network.fn, fetchOptions });
    expect(r.outcome).toBe("FAILED");
    expect(r.detail).toMatch(/fetch failed/);
    expect(paperRow("https://gone.test/paper.pdf")).toMatchObject({ extraction_method: "failed", extracted_text: null });
    expect(chunkRows("https://gone.test/paper.pdf")).toHaveLength(0);

    const back = fakeFetch({ "https://gone.test/paper.pdf": pdf });
    const r2 = await ingestPaper("https://gone.test/paper.pdf", { db, fetchFn: back.fn, fetchOptions });
    expect(r2).toMatchObject({ outcome: "FETCHED", method: "pdf" });
    expect(back.calls).toHaveLength(1);
  });

  it("never retries a 4xx", async () => {
    const { fn, calls } = fakeFetch({ "https://paywall.test/a": { status: 403, body: "forbidden" } });
    const r = await ingestPaper("https://paywall.test/a", { db, fetchFn: fn, fetchOptions });
    expect(r).toMatchObject({ outcome: "FAILED", detail: "HTTP 403" });
    expect(calls).toHaveLength(1);
  });

  it("rejects a .pdf URL that serves HTML", async () => {
    const { fn } = fakeFetch({ "https://journal.test/paper.pdf": { body: fixture("blog-article.html") } });
    const r = await ingestPaper("https://journal.test/paper.pdf", { db, fetchFn: fn, fetchOptions });
    expect(r.outcome).toBe("FAILED");
    expect(r.detail).toMatch(/expected a PDF/);
  });
});

describe("non-arxiv ingestion", () => {
  it("detects a PDF by content-type even without a .pdf extension", async () => {
    const { fn } = fakeFetch({ "https://repo.test/download?id=7": pdf });
    const r = await ingestPaper("https://repo.test/download?id=7", { db, fetchFn: fn, fetchOptions });
    expect(r).toMatchObject({ outcome: "FETCHED", method: "pdf", title: "Tiny Fixture Paper on Citation Checking" });
  });

  it("extracts HTML pages with Readability", async () => {
    const { fn } = fakeFetch({ "https://blog.test/post": { body: fixture("blog-article.html") } });
    const r = await ingestPaper("https://blog.test/post/#top", { db, fetchFn: fn, fetchOptions });
    expect(r).toMatchObject({ outcome: "FETCHED", method: "html", paperId: "https://blog.test/post" });
  });
});

describe("chunk offsets", () => {
  it.each([
    ["arxiv_html", { [arxivRoutes.html]: paperHtml, [arxivRoutes.abs]: absHtml }],
    ["pdf", { [arxivRoutes.pdf]: pdf, [arxivRoutes.abs]: absHtml }],
  ])("round-trip against stored extracted_text (%s)", async (_label, routes) => {
    const { fn } = fakeFetch(routes);
    const r = await ingestPaper(ABS_URL, { db, fetchFn: fn, fetchOptions });
    const { extracted_text } = paperRow(r.paperId)!;
    const chunks = chunkRows(r.paperId);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(extracted_text.slice(c.char_start, c.char_end)).toBe(c.text);
  });
});
