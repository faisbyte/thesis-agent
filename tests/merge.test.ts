import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/lib/config";
import { openDb, type DB } from "../src/lib/db";
import type { ModelFn } from "../src/lib/model";
import { retrieveKeyword, type RetrievedChunk } from "../src/lib/retrieve-keyword";
import { retrieveEmbed, type Embedder } from "../src/lib/retrieve-embed";
import { mergeChunks, verifyCitation } from "../src/lib/verify";
import { fakeEmbedder, ingestFixturePaper, PAPER_ID } from "./helpers";

/**
 * A fake embedder whose query vector is the embedding of `steerTo` instead of
 * the sentence. Lets a test decide exactly which chunk "embedding" finds, so
 * one retriever can miss on purpose while the other hits.
 */
function steeredEmbedder(steerTo: string): Embedder {
  const base = fakeEmbedder();
  return { ...base, embedQuery: () => base.embedQuery(steerTo) };
}

const chunkWith = (db: DB, phrase: string) =>
  db.prepare(`SELECT id, text FROM chunks WHERE paper_id = ? AND text LIKE ?`).get(PAPER_ID, `%${phrase}%`) as { id: number; text: string };

const irrelevantModel: ModelFn = async () => ({
  text: JSON.stringify({ verdict: "irrelevant", explanation: "mock", evidence: [] }),
  stopReason: "end_turn",
  model: "mock",
});

let db: DB;
beforeEach(async () => {
  db = openDb(":memory:");
  await ingestFixturePaper(db);
});

describe("merged retrieval (retriever: both)", () => {
  it("finds the right chunk when only keyword does (mirrors S1)", async () => {
    // Close to the paper's own wording, but embedding is steered to the Limitations chunk.
    const sentence = "Passages from the reference list are excluded, since a bibliography says nothing about support.";
    const target = chunkWith(db, "Passages from the reference list are excluded");
    const decoy = chunkWith(db, "Paywalled sources");
    const embedder = steeredEmbedder(decoy.text);

    const keywordAlone = retrieveKeyword(db, PAPER_ID, sentence, 1);
    const embedAlone = await retrieveEmbed(db, PAPER_ID, sentence, embedder, 1);
    expect(keywordAlone.map((c) => c.chunkId)).toEqual([target.id]);
    expect(embedAlone.map((c) => c.chunkId)).not.toContain(target.id);

    const r = await verifyCitation({ db, paper: PAPER_ID, sentence, retriever: "both", embedder, model: irrelevantModel, limit: 1 });
    const found = r.chunks.find((c) => c.chunkId === target.id);
    expect(found?.foundBy).toEqual(["keyword"]);
    expect(r.chunks.find((c) => c.chunkId === decoy.id)?.foundBy).toEqual(["embed"]);
  });

  it("finds the right chunk when only embedding does (mirrors S9)", async () => {
    // Lexically this sentence matches the Limitations chunk; "embedding" understands it's about the verifier.
    const sentence = "Paywalled sources and scanned PDFs cannot be checked.";
    const target = chunkWith(db, "The verifier receives the citing sentence");
    const embedder = steeredEmbedder(target.text);

    const keywordAlone = retrieveKeyword(db, PAPER_ID, sentence, 1);
    const embedAlone = await retrieveEmbed(db, PAPER_ID, sentence, embedder, 1);
    expect(keywordAlone.map((c) => c.chunkId)).not.toContain(target.id);
    expect(embedAlone.map((c) => c.chunkId)).toEqual([target.id]);

    const r = await verifyCitation({ db, paper: PAPER_ID, sentence, retriever: "both", embedder, model: irrelevantModel, limit: 1 });
    expect(r.chunks.find((c) => c.chunkId === target.id)?.foundBy).toEqual(["embed"]);
  });

  it("lists a chunk both retrievers found once, tagged with both", async () => {
    const sentence = "Passages from the reference list are excluded, since a bibliography says nothing about support.";
    const target = chunkWith(db, "Passages from the reference list are excluded");
    const r = await verifyCitation({
      db, paper: PAPER_ID, sentence, retriever: "both", embedder: steeredEmbedder(target.text), model: irrelevantModel,
    });
    const hits = r.chunks.filter((c) => c.chunkId === target.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].foundBy).toEqual(["embed", "keyword"]);
    expect(hits[0].ranks).toEqual({ embed: 1, keyword: 1 });
    expect(new Set(r.chunks.map((c) => c.chunkId)).size).toBe(r.chunks.length);
  });

  it("never exceeds the cap on a real merge", async () => {
    const r = await verifyCitation({
      db, paper: PAPER_ID, sentence: "verifier passages retrieval citation", retriever: "both",
      embedder: fakeEmbedder(), model: irrelevantModel, limit: 5, maxMerged: 3,
    });
    expect(r.chunks.length).toBe(3);
    const def = await verifyCitation({
      db, paper: PAPER_ID, sentence: "verifier passages retrieval citation", retriever: "both", embedder: fakeEmbedder(), model: irrelevantModel,
    });
    expect(def.chunks.length).toBeLessThanOrEqual(config.mergedMaxChunks);
  });

  it("is the default retriever", () => {
    expect(config.defaultRetriever).toBe("both");
  });
});

describe("mergeChunks", () => {
  const fake = (id: number, score: number): RetrievedChunk => ({
    chunkId: id, ordinal: id, heading: null, text: `chunk ${id}`, charStart: 0, charEnd: 1, score,
  });
  const embed = [1, 2, 3, 4, 5].map((id) => fake(id, 0.9 - id / 100));
  const keyword = [11, 12, 13, 14, 15].map((id) => fake(id, 10 - id / 10));

  it("respects the cap with fully disjoint lists, keeping each retriever's best first", () => {
    const merged = mergeChunks(embed, keyword, 6);
    expect(merged.map((c) => c.chunkId)).toEqual([1, 11, 2, 12, 3, 13]);
    expect(mergeChunks(embed, keyword, 10)).toHaveLength(10);
    expect(mergeChunks(embed, keyword, 100)).toHaveLength(10);
  });

  it("deduplicates overlap and records both ranks and scores", () => {
    const merged = mergeChunks([fake(1, 0.8), fake(2, 0.7)], [fake(2, 9), fake(3, 8)], 10);
    expect(merged.map((c) => c.chunkId)).toEqual([1, 2, 3]);
    expect(merged[1]).toMatchObject({ foundBy: ["embed", "keyword"], ranks: { embed: 2, keyword: 1 }, scores: { embed: 0.7, keyword: 9 } });
  });

  it("handles one empty side", () => {
    expect(mergeChunks([], keyword, 10).every((c) => c.foundBy[0] === "keyword")).toBe(true);
    expect(mergeChunks([], [], 10)).toEqual([]);
  });
});
