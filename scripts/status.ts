import { openDb } from "../src/lib/db";

const db = openDb();
const rows = db
  .prepare(
    `SELECT p.id, p.title, p.fetched_at, p.extraction_method, p.char_count,
            (SELECT COUNT(*) FROM chunks c WHERE c.paper_id = p.id) AS chunk_count
     FROM papers p ORDER BY p.fetched_at DESC`,
  )
  .all() as { id: string; title: string | null; fetched_at: string | null; extraction_method: string | null; char_count: number | null; chunk_count: number }[];
db.close();

if (rows.length === 0) {
  console.log("No papers stored yet.");
  process.exit(0);
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const table = rows.map((r) => [
  r.id,
  truncate(r.title ?? "(untitled)", 60),
  r.fetched_at ?? "",
  r.extraction_method ?? "",
  String(r.chunk_count),
]);
const header = ["ID", "TITLE", "FETCHED_AT", "METHOD", "CHUNKS"];
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
for (const row of [header, ...table]) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
