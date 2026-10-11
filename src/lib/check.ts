import { config } from "./config";
import type { DB } from "./db";
import { ingestPaper, type IngestResult } from "./ingest";
import type { ModelFn } from "./model";
import type { Embedder } from "./retrieve-embed";
import { verifyCitation, type RetrieverName, type VerifyResult } from "./verify";

/** A retriever mode, or "side-by-side": separate embed and keyword verdicts (two model calls). */
export type CheckRetriever = RetrieverName | "side-by-side";

export interface CheckResult extends VerifyResult {
  /** Estimated model cost for this verdict, from config.anthropicPricePerMTok. */
  costUsd: number;
}

export interface CheckItemResult {
  url: string;
  sentence: string;
  /** How the paper was obtained: FETCHED = ingested just now, REUSED = already stored. Null if never attempted. */
  ingest: IngestResult | null;
  /** One verdict per retriever run ("side-by-side" gives embed then keyword; every other mode gives one). */
  results: CheckResult[];
  /** Set when this item could not be checked; the other fields say how far it got. */
  error: string | null;
  durationMs: number;
}

export interface CheckOptions {
  db: DB;
  embedder: Embedder;
  model?: ModelFn;
}

/**
 * Ingest the paper if it isn't stored yet, then verify the sentence against it.
 * Never throws: any failure is returned in `error` so a batch can carry on.
 */
export async function checkCitation(
  item: { url: string; sentence: string; retriever?: CheckRetriever },
  opts: CheckOptions,
): Promise<CheckItemResult> {
  const started = Date.now();
  const url = item.url?.trim() ?? "";
  const sentence = item.sentence?.trim() ?? "";
  const out: CheckItemResult = { url, sentence, ingest: null, results: [], error: null, durationMs: 0 };
  const done = (error: string | null) => ({ ...out, error, durationMs: Date.now() - started });

  if (!url) return done("missing paper URL");
  if (!sentence) return done("missing sentence");

  // Already-stored papers come back REUSED with no network calls.
  out.ingest = await ingestPaper(url, { db: opts.db, embedder: opts.embedder });
  if (out.ingest.outcome === "FAILED") return done(`could not ingest paper: ${out.ingest.detail}`);

  const retrievers: RetrieverName[] =
    item.retriever === "side-by-side" ? ["embed", "keyword"] : [item.retriever ?? config.defaultRetriever];
  for (const retriever of retrievers) {
    try {
      const r = await verifyCitation({
        db: opts.db,
        paper: out.ingest.paperId,
        sentence,
        retriever,
        embedder: opts.embedder,
        model: opts.model,
      });
      out.results.push({ ...r, costUsd: estimateCost(r.usage) });
    } catch (err) {
      return done(`${retriever} check failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return done(null);
}

/** Run checks one at a time, in input order. One item's failure doesn't stop the rest. */
export async function checkBatch(
  items: { url: string; sentence: string; retriever?: CheckRetriever }[],
  opts: CheckOptions,
): Promise<CheckItemResult[]> {
  const results: CheckItemResult[] = [];
  for (const item of items) results.push(await checkCitation(item, opts));
  return results;
}

function estimateCost(usage: { inputTokens: number; outputTokens: number }): number {
  const price = config.anthropicPricePerMTok;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
