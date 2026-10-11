import fs from "node:fs";
import path from "node:path";
import type { FetchFn } from "../src/lib/fetcher";
import type { Embedder } from "../src/lib/retrieve-embed";
import type { DB } from "../src/lib/db";
import { ingestPaper } from "../src/lib/ingest";

export const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name));

type Route = { status?: number; body?: string | Buffer; contentType?: string } | (() => Promise<Response>);

/** A fake fetch serving fixed routes by exact URL; unknown URLs 404. Records every call. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn: FetchFn = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (typeof route === "function") return route();
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const body = typeof route.body === "string" ? route.body : route.body ? new Uint8Array(route.body) : "";
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" },
    });
  };
  return { fn, calls };
}

export const ARXIV_ID = "2401.00001";
export const arxivRoutes = {
  html: `https://arxiv.org/html/${ARXIV_ID}`,
  pdf: `https://arxiv.org/pdf/${ARXIV_ID}`,
  abs: `https://arxiv.org/abs/${ARXIV_ID}`,
};

/**
 * Deterministic stand-in for the embedding model: hashed bag of stemmed-ish
 * words, L2-normalized. It only exercises the plumbing (storage, cosine
 * ranking, exclusions); it knows nothing about paraphrase.
 */
export function fakeEmbedder(dim = 256): Embedder & { calls: number } {
  const vec = (text: string) => {
    const v = new Float32Array(dim);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (word.length < 3) continue;
      const stem = word.replace(/(ing|ed|es|s)$/, "");
      let h = 0;
      for (const ch of stem) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % dim] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  const e = {
    model: "fake-embedder",
    calls: 0,
    embedPassages: async (texts: string[]) => {
      e.calls++;
      return texts.map(vec);
    },
    embedQuery: async (text: string) => vec(text),
  };
  return e;
}

export const PAPER_ID = `arxiv:${ARXIV_ID}`;

/** Ingest the fixture arxiv paper (HTML path) into `db`, embedding with a fake embedder. */
export async function ingestFixturePaper(db: DB, embedder = fakeEmbedder()) {
  const { fn } = fakeFetch({ [arxivRoutes.html]: { body: fixture("arxiv-paper.html") }, [arxivRoutes.abs]: { body: fixture("arxiv-abs.html") } });
  const r = await ingestPaper(`https://arxiv.org/abs/${ARXIV_ID}`, { db, fetchFn: fn, fetchOptions: { retryDelayMs: 0 }, embedder });
  if (r.outcome !== "FETCHED") throw new Error(`fixture ingest failed: ${r.detail}`);
  return embedder;
}
