import crypto from "node:crypto";
import { config } from "./config";
import type { DB } from "./db";
import { canonicalId, fetchUrl, normalizeUrl, parseArxivId, type FetchFn, type FetchOptions, type FetchResult } from "./fetcher";
import { extractArxivHtml, extractHtml, parseArxivAbsMeta } from "./extract";
import { extractPdf } from "./extract-pdf";
import { chunkText } from "./chunk";
import { ensureEmbeddings, type Embedder } from "./retrieve-embed";

export type Outcome = "FETCHED" | "REUSED" | "FAILED";
export type ExtractionMethod = "arxiv_html" | "pdf" | "html" | "failed";

export interface IngestResult {
  outcome: Outcome;
  paperId: string;
  title: string | null;
  method: ExtractionMethod | null;
  chunkCount: number;
  durationMs: number;
  detail: string | null;
}

export interface IngestOptions {
  db: DB;
  fetchFn?: FetchFn;
  fetchOptions?: FetchOptions;
  /** Re-fetch even if the paper is already stored. */
  force?: boolean;
  /** If given, embed the new chunks right after storing them. */
  embedder?: Embedder;
}

interface Fetched {
  canonicalUrl: string;
  arxivId: string | null;
  title: string | null;
  authors: string | null;
  httpStatus: number;
  contentHash: string;
  method: Exclude<ExtractionMethod, "failed">;
  text: string;
  detail: string | null;
}

class IngestError extends Error {
  constructor(message: string, readonly httpStatus: number | null = null, readonly url: string | null = null) {
    super(message);
  }
}

/** Fetch -> extract -> chunk -> store one paper. Never throws; failures come back as FAILED. */
export async function ingestPaper(sourceUrl: string, opts: IngestOptions): Promise<IngestResult> {
  const { db } = opts;
  const startedAt = new Date();
  const elapsed = () => Date.now() - startedAt.getTime();
  let paperId = sourceUrl;
  let bytes = 0;

  const log = (outcome: Outcome, httpStatus: number | null, chunkCount: number | null, detail: string | null) =>
    db.prepare(
      `INSERT INTO fetch_log (paper_id, url, started_at, outcome, http_status, bytes, chunk_count, duration_ms, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(paperId, sourceUrl, startedAt.toISOString(), outcome, httpStatus, bytes, chunkCount, elapsed(), detail);

  try {
    paperId = canonicalId(sourceUrl);
  } catch {
    log("FAILED", null, null, "invalid URL");
    return { outcome: "FAILED", paperId, title: null, method: null, chunkCount: 0, durationMs: elapsed(), detail: "invalid URL" };
  }

  const existing = db
    .prepare(`SELECT title, extraction_method FROM papers WHERE id = ? AND last_success_at IS NOT NULL`)
    .get(paperId) as { title: string | null; extraction_method: ExtractionMethod } | undefined;
  if (existing && !opts.force) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE paper_id = ?`).get(paperId) as { n: number };
    log("REUSED", null, n, null);
    return { outcome: "REUSED", paperId, title: existing.title, method: existing.extraction_method, chunkCount: n, durationMs: elapsed(), detail: null };
  }

  const get = async (url: string): Promise<FetchResult> => {
    const res = await fetchUrl(url, opts.fetchFn, opts.fetchOptions);
    bytes += res.body.length;
    return res;
  };

  let fetched: Fetched;
  try {
    const arxivId = parseArxivId(sourceUrl);
    fetched = arxivId ? await fetchArxiv(arxivId, get) : await fetchGeneric(sourceUrl, get);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const httpStatus = err instanceof IngestError ? err.httpStatus : null;
    recordFailure(db, paperId, sourceUrl, err instanceof IngestError ? err.url : null, httpStatus, startedAt);
    log("FAILED", httpStatus, null, detail);
    return { outcome: "FAILED", paperId, title: null, method: "failed", chunkCount: 0, durationMs: elapsed(), detail };
  }

  const chunks = chunkText(fetched.text);
  const now = new Date().toISOString();
  const store = db.transaction(() => {
    db.prepare(
      `INSERT INTO papers (id, source_url, canonical_url, arxiv_id, title, authors, fetched_at, last_success_at,
                           http_status, content_hash, extraction_method, extracted_text, char_count)
       VALUES (@id, @source_url, @canonical_url, @arxiv_id, @title, @authors, @now, @now,
               @http_status, @content_hash, @method, @text, @char_count)
       ON CONFLICT(id) DO UPDATE SET
         source_url = excluded.source_url, canonical_url = excluded.canonical_url, arxiv_id = excluded.arxiv_id,
         title = excluded.title, authors = excluded.authors, fetched_at = excluded.fetched_at,
         last_success_at = excluded.last_success_at, http_status = excluded.http_status,
         content_hash = excluded.content_hash, extraction_method = excluded.extraction_method,
         extracted_text = excluded.extracted_text, char_count = excluded.char_count`,
    ).run({
      id: paperId,
      source_url: sourceUrl,
      canonical_url: fetched.canonicalUrl,
      arxiv_id: fetched.arxivId,
      title: fetched.title,
      authors: fetched.authors,
      now,
      http_status: fetched.httpStatus,
      content_hash: fetched.contentHash,
      method: fetched.method,
      text: fetched.text,
      char_count: fetched.text.length,
    });
    db.prepare(`DELETE FROM chunks WHERE paper_id = ?`).run(paperId);
    const insert = db.prepare(
      `INSERT INTO chunks (paper_id, ordinal, heading, text, char_start, char_end) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const c of chunks) insert.run(paperId, c.ordinal, c.heading, c.text, c.charStart, c.charEnd);
    log("FETCHED", fetched.httpStatus, chunks.length, fetched.detail);
  });
  try {
    store(); // rolls back as a whole on error, leaving any earlier row intact
  } catch (err) {
    const detail = `storage error: ${err instanceof Error ? err.message : err}`;
    log("FAILED", fetched.httpStatus, null, detail);
    return { outcome: "FAILED", paperId, title: fetched.title, method: "failed", chunkCount: 0, durationMs: elapsed(), detail };
  }

  // Best-effort: the paper is stored either way, and retrieve-embed backfills missing vectors.
  let detail = fetched.detail;
  if (opts.embedder) {
    try {
      await ensureEmbeddings(db, paperId, opts.embedder);
    } catch (err) {
      detail = [detail, `embedding failed: ${err instanceof Error ? err.message : err}`].filter(Boolean).join("; ");
    }
  }

  return {
    outcome: "FETCHED",
    paperId,
    title: fetched.title,
    method: fetched.method,
    chunkCount: chunks.length,
    durationMs: elapsed(),
    detail,
  };
}

/**
 * On failure, only create a placeholder row if the paper has never been seen.
 * An existing row (and its chunks) is never modified by a failed fetch.
 */
function recordFailure(db: DB, paperId: string, sourceUrl: string, url: string | null, httpStatus: number | null, at: Date) {
  db.prepare(
    `INSERT OR IGNORE INTO papers (id, source_url, canonical_url, arxiv_id, fetched_at, http_status, extraction_method)
     VALUES (?, ?, ?, ?, ?, ?, 'failed')`,
  ).run(paperId, sourceUrl, url ?? sourceUrl, parseArxivId(sourceUrl), at.toISOString(), httpStatus);
}

type Getter = (url: string) => Promise<FetchResult>;

/** arxiv: HTML version first, PDF fallback; /abs/ page for title and authors either way. */
async function fetchArxiv(arxivId: string, get: Getter): Promise<Fetched> {
  const htmlUrl = `https://arxiv.org/html/${arxivId}`;
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
  const absUrl = `https://arxiv.org/abs/${arxivId}`;

  let full: Omit<Fetched, "arxivId" | "authors" | "detail"> | null = null;
  let htmlNote: string;
  try {
    const res = await get(htmlUrl);
    const extracted = res.ok ? extractArxivHtml(res.body.toString("utf8"), htmlUrl) : null;
    if (!res.ok) htmlNote = `arxiv HTML ${res.status}`;
    else if (!extracted) htmlNote = "arxiv HTML not a LaTeXML paper";
    else if (extracted.text.length < config.minArxivHtmlChars) htmlNote = `arxiv HTML only ${extracted.text.length} chars`;
    else {
      htmlNote = "";
      full = { canonicalUrl: htmlUrl, httpStatus: res.status, contentHash: sha256(res.body), method: "arxiv_html", ...extracted };
    }
  } catch (err) {
    htmlNote = `arxiv HTML error: ${err instanceof Error ? err.message : err}`;
  }

  if (!full) {
    const res = await get(pdfUrl);
    if (!res.ok) throw new IngestError(`${htmlNote}; PDF HTTP ${res.status}`, res.status, pdfUrl);
    if (!isPdfBytes(res.body)) throw new IngestError(`${htmlNote}; PDF URL did not return a PDF (${res.contentType})`, res.status, pdfUrl);
    const extracted = await extractPdf(new Uint8Array(res.body));
    full = { canonicalUrl: pdfUrl, httpStatus: res.status, contentHash: sha256(res.body), method: "pdf", ...extracted };
  }

  if (full.text.length < config.minExtractedChars) {
    throw new IngestError(`extracted only ${full.text.length} chars via ${full.method}`, full.httpStatus, full.canonicalUrl);
  }

  // Metadata is best-effort: a failed /abs/ fetch shouldn't fail the ingest.
  let meta = { title: null as string | null, authors: null as string | null };
  let metaNote = "";
  try {
    const res = await get(absUrl);
    if (res.ok) meta = parseArxivAbsMeta(res.body.toString("utf8"));
    else metaNote = `abs HTTP ${res.status}`;
  } catch (err) {
    metaNote = `abs error: ${err instanceof Error ? err.message : err}`;
  }

  return {
    ...full,
    arxivId,
    title: meta.title ?? full.title,
    authors: meta.authors,
    detail: [htmlNote, metaNote].filter(Boolean).join("; ") || null,
  };
}

/** Any other URL: PDF if it looks like one, otherwise an HTML article. */
async function fetchGeneric(sourceUrl: string, get: Getter): Promise<Fetched> {
  const url = normalizeUrl(sourceUrl);
  const res = await get(url);
  if (!res.ok) throw new IngestError(`HTTP ${res.status}`, res.status, url);

  const looksLikePdf = /application\/pdf/i.test(res.contentType) || new URL(url).pathname.toLowerCase().endsWith(".pdf");
  let method: "pdf" | "html";
  let extracted;
  if (looksLikePdf || isPdfBytes(res.body)) {
    if (!isPdfBytes(res.body)) throw new IngestError(`expected a PDF but got ${res.contentType || "unknown content"}`, res.status, url);
    method = "pdf";
    extracted = await extractPdf(new Uint8Array(res.body));
  } else {
    method = "html";
    extracted = extractHtml(res.body.toString("utf8"), url);
  }

  if (extracted.text.length < config.minExtractedChars) {
    throw new IngestError(`extracted only ${extracted.text.length} chars via ${method}`, res.status, url);
  }
  return {
    canonicalUrl: url,
    arxivId: null,
    title: extracted.title,
    authors: null,
    httpStatus: res.status,
    contentHash: sha256(res.body),
    method,
    text: extracted.text,
    detail: null,
  };
}

function isPdfBytes(body: Buffer): boolean {
  return body.subarray(0, 5).toString("latin1") === "%PDF-";
}

function sha256(body: Buffer): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}
