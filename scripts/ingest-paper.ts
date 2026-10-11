import { openDb } from "../src/lib/db";
import { ingestPaper } from "../src/lib/ingest";

const args = process.argv.slice(2);
const force = args.includes("--force");
const url = args.find((a) => !a.startsWith("--"));
if (!url) {
  console.error('usage: npm run ingest-paper -- "<url>" [--force]');
  process.exit(2);
}

const db = openDb();
const r = await ingestPaper(url, { db, force });
db.close();

const seconds = `${(r.durationMs / 1000).toFixed(1)}s`;
if (r.outcome === "FAILED") {
  console.log([r.outcome.padEnd(8), r.paperId, r.detail, seconds].join("  "));
  process.exit(1);
}
console.log(
  [r.outcome.padEnd(8), r.paperId, JSON.stringify(r.title ?? "(untitled)"), r.method, `${r.chunkCount} chunks`, seconds].join("  "),
);
