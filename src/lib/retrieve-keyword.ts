import { config } from "./config";
import { getStoredPaper, type DB } from "./db";

export interface RetrievedChunk {
  chunkId: number;
  ordinal: number;
  heading: string | null;
  text: string;
  charStart: number; // offsets into papers.extracted_text
  charEnd: number;
  score: number; // higher is better; scale depends on the retriever
}

// Function words that carry no topical signal. FTS5 has no stopword list of its own.
const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "may might more most no not of on or our over she so such than that the their them then there these they this those " +
    "through to under up us was we were what when where which while who will with would you your also both each other " +
    "only same very via").split(" "),
);

/** Turn a citation sentence into an FTS5 OR-query of quoted terms. */
export function toFtsQuery(sentence: string): string | null {
  const terms = [...new Set(sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)),
  );
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}

/**
 * BM25 keyword retrieval over one paper's chunks via the chunks_fts index.
 * Chunks under References/Bibliography headings are excluded.
 * Note: FTS5's IDF statistics come from every stored paper, not just this one.
 */
export function retrieveKeyword(db: DB, paperIdOrUrl: string, sentence: string, limit = config.retrieveLimit): RetrievedChunk[] {
  const paper = getStoredPaper(db, paperIdOrUrl);
  const query = toFtsQuery(sentence);
  if (!query) return [];

  const rows = db
    .prepare(
      // bm25() is lower-is-better; text weighted 1.0, heading 0.5.
      `SELECT c.id, c.ordinal, c.heading, c.text, c.char_start, c.char_end, -bm25(chunks_fts, 1.0, 0.5) AS score
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ? AND c.paper_id = ?
       ORDER BY score DESC`,
    )
    .all(query, paper.id) as {
    id: number;
    ordinal: number;
    heading: string | null;
    text: string;
    char_start: number;
    char_end: number;
    score: number;
  }[];

  return rows
    .filter((r) => !isExcludedHeading(r.heading))
    .slice(0, limit)
    .map((r) => ({
      chunkId: r.id,
      ordinal: r.ordinal,
      heading: r.heading,
      text: r.text,
      charStart: r.char_start,
      charEnd: r.char_end,
      score: r.score,
    }));
}

export function isExcludedHeading(heading: string | null): boolean {
  return heading !== null && config.excludedHeadings.test(heading.trim());
}
