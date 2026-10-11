import { config } from "./config";
import { getStoredPaper, type DB } from "./db";
import { isExcludedHeading, type RetrievedChunk } from "./retrieve-keyword";

/** Anything that can turn text into L2-normalized vectors. Tests pass a fake. */
export interface Embedder {
  model: string;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

let localPipeline: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;

/**
 * Local embedding model via transformers.js. The model is downloaded from
 * Hugging Face on first use into config.embedModelDir, then runs offline.
 */
export function localEmbedder(): Embedder {
  const load = () => {
    localPipeline ??= import("@huggingface/transformers").then(async ({ pipeline, env }) => {
      env.cacheDir = config.embedModelDir;
      const extractor = await pipeline("feature-extraction", config.embedModel, { dtype: "q8" });
      return extractor as unknown as (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>;
    });
    return localPipeline;
  };
  const embed = async (texts: string[]) => {
    const extractor = await load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      // bge models use the [CLS] token embedding.
      const batch = await extractor(texts.slice(i, i + 16), { pooling: "cls", normalize: true });
      out.push(...batch.tolist().map((v) => Float32Array.from(v)));
    }
    return out;
  };
  return {
    model: config.embedModel,
    embedPassages: embed,
    embedQuery: async (text) => (await embed([config.embedQueryPrefix + text]))[0],
  };
}

/** Embed and store any of the paper's chunks that don't yet have a vector for this model. Returns how many were added. */
export async function ensureEmbeddings(db: DB, paperId: string, embedder: Embedder): Promise<number> {
  const missing = db
    .prepare(
      `SELECT c.id, c.text, c.heading FROM chunks c
       LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ?
       WHERE c.paper_id = ? AND e.chunk_id IS NULL ORDER BY c.ordinal`,
    )
    .all(embedder.model, paperId) as { id: number; text: string; heading: string | null }[];
  if (missing.length === 0) return 0;

  // The heading gives the passage context ("Limitations", "Related Work") the text alone may lack.
  const vectors = await embedder.embedPassages(missing.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)));
  const insert = db.prepare(`INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, dim, vector) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    missing.forEach((c, i) => insert.run(c.id, embedder.model, vectors[i].length, Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength)));
  })();
  return missing.length;
}

/**
 * Cosine-similarity retrieval over one paper's chunks. Embeds the paper's
 * chunks first if they weren't embedded at ingest time.
 * Chunks under References/Bibliography headings are excluded.
 */
export async function retrieveEmbed(
  db: DB,
  paperIdOrUrl: string,
  sentence: string,
  embedder: Embedder,
  limit = config.retrieveLimit,
): Promise<RetrievedChunk[]> {
  const paper = getStoredPaper(db, paperIdOrUrl);
  await ensureEmbeddings(db, paper.id, embedder);
  const query = await embedder.embedQuery(sentence);

  const rows = db
    .prepare(
      `SELECT c.id, c.ordinal, c.heading, c.text, c.char_start, c.char_end, e.vector
       FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = ?
       WHERE c.paper_id = ?`,
    )
    .all(embedder.model, paper.id) as {
    id: number;
    ordinal: number;
    heading: string | null;
    text: string;
    char_start: number;
    char_end: number;
    vector: Buffer;
  }[];

  return rows
    .filter((r) => !isExcludedHeading(r.heading))
    .map((r) => ({
      chunkId: r.id,
      ordinal: r.ordinal,
      heading: r.heading,
      text: r.text,
      charStart: r.char_start,
      charEnd: r.char_end,
      score: cosine(query, toFloat32(r.vector)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function toFloat32(buf: Buffer): Float32Array {
  // Copy: SQLite blobs aren't guaranteed to be 4-byte aligned.
  return new Float32Array(new Uint8Array(buf).buffer);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
