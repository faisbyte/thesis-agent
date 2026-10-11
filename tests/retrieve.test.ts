import { beforeEach, describe, expect, it } from "vitest";
import { openDb, PaperNotFoundError, type DB } from "../src/lib/db";
import { ingestPaper } from "../src/lib/ingest";
import { retrieveKeyword, toFtsQuery } from "../src/lib/retrieve-keyword";
import { retrieveEmbed } from "../src/lib/retrieve-embed";
import { ARXIV_ID, arxivRoutes, fakeEmbedder, fakeFetch, fixture, ingestFixturePaper, PAPER_ID } from "./helpers";

const extractedText = (db: DB) =>
  (db.prepare(`SELECT extracted_text FROM papers WHERE id = ?`).get(PAPER_ID) as { extracted_text: string }).extracted_text;

// Close to the paper's own wording in 2.1 Retrieval.
const ECHO = "Passages from the reference list are excluded, because a paper listing another paper in its bibliography says nothing about support.";
// Words that appear mostly in the fixture's References section.
const BIBLIOGRAPHIC = "Citation verification by passage retrieval with a lexical and dense retrieval model, benchmarks, citation recommendation";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

describe.each([
  ["keyword", (sentence: string, limit?: number) => Promise.resolve(retrieveKeyword(db, PAPER_ID, sentence, limit))],
  ["embed", (sentence: string, limit?: number) => retrieveEmbed(db, PAPER_ID, sentence, fakeEmbedder(), limit)],
] as const)("%s retriever", (_name, retrieve) => {
  beforeEach(async () => {
    await ingestFixturePaper(db);
  });

  it("puts the chunk a closely-worded sentence came from first", async () => {
    const [top] = await retrieve(ECHO);
    expect(top.text).toContain("Passages from the reference list are excluded");
    expect(top.heading).toBe("2.1 Retrieval");
  });

  it("returns at most N chunks, with offsets that round-trip into extracted_text", async () => {
    const results = await retrieve(ECHO, 3);
    expect(results.length).toBeLessThanOrEqual(3);
    const text = extractedText(db);
    for (const c of results) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
  });

  it("never returns References chunks, even for a sentence that matches them best", async () => {
    const refChunks = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE heading = 'References'`).get() as { n: number };
    expect(refChunks.n).toBeGreaterThan(0); // the fixture really has them
    const all = await retrieve(BIBLIOGRAPHIC, 100);
    expect(all.length).toBeGreaterThan(0);
    expect(all.some((c) => c.heading === "References")).toBe(false);
    expect(all.some((c) => c.text.includes("Transactions on Retrieval"))).toBe(false);
  });

  it("fails clearly for a paper that isn't stored", async () => {
    const missing = _name === "keyword"
      ? () => retrieveKeyword(db, "https://arxiv.org/abs/9999.99999", ECHO)
      : () => retrieveEmbed(db, "https://arxiv.org/abs/9999.99999", ECHO, fakeEmbedder());
    await expect(Promise.resolve().then(missing)).rejects.toThrow(PaperNotFoundError);
  });
});

describe("paper lookup", () => {
  it("accepts any URL form of a stored paper", async () => {
    await ingestFixturePaper(db);
    expect(retrieveKeyword(db, `https://arxiv.org/pdf/${ARXIV_ID}v1`, ECHO).length).toBeGreaterThan(0);
  });

  it("treats a failed placeholder row as not stored", async () => {
    const { fn } = fakeFetch({});
    await ingestPaper("https://gone.test/x", { db, fetchFn: fn, fetchOptions: { retryDelayMs: 0 } });
    expect(() => retrieveKeyword(db, "https://gone.test/x", ECHO)).toThrow(PaperNotFoundError);
  });
});

describe("keyword query building", () => {
  it("drops stopwords and quotes terms", () => {
    expect(toFtsQuery("The router selects top-2 of the experts")).toBe('"router" OR "selects" OR "top" OR "2" OR "experts"');
  });
  it("returns nothing for a sentence of only stopwords", async () => {
    await ingestFixturePaper(db);
    expect(toFtsQuery("it is what it is")).toBeNull();
    expect(retrieveKeyword(db, PAPER_ID, "it is what it is")).toEqual([]);
  });
  it("is safe against FTS5 query syntax in the sentence", async () => {
    await ingestFixturePaper(db);
    expect(() => retrieveKeyword(db, PAPER_ID, 'NEAR(a b) "unbalanced * OR AND -x: col:y')).not.toThrow();
  });
});

describe("embeddings storage", () => {
  it("embeds every chunk once at ingest time and reuses the vectors", async () => {
    const embedder = await ingestFixturePaper(db);
    const { chunks, vectors } = db
      .prepare(`SELECT (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM chunk_embeddings) AS vectors`)
      .get() as { chunks: number; vectors: number };
    expect(vectors).toBe(chunks);
    const callsAfterIngest = embedder.calls;
    await retrieveEmbed(db, PAPER_ID, ECHO, embedder);
    expect(embedder.calls).toBe(callsAfterIngest); // no passage re-embedding
  });

  it("backfills vectors for papers ingested without an embedder", async () => {
    const { fn } = fakeFetch({ [arxivRoutes.html]: { body: fixture("arxiv-paper.html") } });
    await ingestPaper(`https://arxiv.org/abs/${ARXIV_ID}`, { db, fetchFn: fn, fetchOptions: { retryDelayMs: 0 } });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM chunk_embeddings`).get() as { n: number }).n).toBe(0);
    const [top] = await retrieveEmbed(db, PAPER_ID, ECHO, fakeEmbedder());
    expect(top.text).toContain("Passages from the reference list are excluded");
  });

  it("drops vectors when a forced re-ingest replaces the chunks", async () => {
    await ingestFixturePaper(db);
    const { fn } = fakeFetch({ [arxivRoutes.html]: { body: fixture("arxiv-paper.html") } });
    await ingestPaper(`https://arxiv.org/abs/${ARXIV_ID}`, { db, fetchFn: fn, fetchOptions: { retryDelayMs: 0 }, force: true });
    const orphans = db.prepare(`SELECT COUNT(*) AS n FROM chunk_embeddings e LEFT JOIN chunks c ON c.id = e.chunk_id WHERE c.id IS NULL`).get() as { n: number };
    expect(orphans.n).toBe(0);
    // And the keyword index follows the new chunks too.
    expect(retrieveKeyword(db, PAPER_ID, ECHO)[0].text).toContain("Passages from the reference list are excluded");
  });
});
