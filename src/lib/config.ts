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
};
