import path from "node:path";

export const config = {
  dbPath: process.env.THESIS_DB_PATH ?? path.join(process.cwd(), "data", "papers.db"),

  // Fetching
  fetchTimeoutMs: 20_000,
  retryDelayMs: 1_000,
  userAgent: "thesis-agent-citation-checker/0.1 (research tool; contact: YOUR_EMAIL_HERE)",

  // Below this many characters, an arxiv HTML page is treated as "not real content"
  // (conversion failure stub) and we fall back to the PDF.
  minArxivHtmlChars: 2_000,
  // Below this, any extraction is considered a failure.
  minExtractedChars: 200,

  // Chunking
  chunkMinChars: 600,
  chunkMaxChars: 1_000,

  // Retrieval
  retrieveLimit: 5,
  // Chunks under these headings are never returned (reference lists match
  // citation sentences lexically but never support them).
  excludedHeadings: /^(\d+\.?\s*)?(references|bibliography|works cited|literature cited)$/i,
  // Used by check-citation when --retriever isn't given. Placeholder until the
  // keyword-vs-embedding comparison is decided.
  defaultRetriever: "embed" as "keyword" | "embed",

  // Local embedding model (transformers.js, downloaded once into embedModelDir)
  embedModel: "Xenova/bge-small-en-v1.5",
  embedModelDir: process.env.THESIS_MODEL_DIR ?? path.join(process.cwd(), "data", "models"),
  // bge v1.5 recommends this prefix on queries (not passages) for retrieval.
  embedQueryPrefix: "Represent this sentence for searching relevant passages: ",

  // Verification model (Anthropic Messages API)
  anthropicModel: "claude-opus-5-5",
  anthropicEffort: "medium" as "low" | "medium" | "high" | "xhigh" | "max",
  anthropicMaxTokens: 16_000,
  anthropicTimeoutMs: 120_000,
};
