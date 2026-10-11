import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";
import { canonicalId } from "./fetcher";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  arxiv_id TEXT,
  title TEXT,
  authors TEXT,
  fetched_at TEXT,
  last_success_at TEXT,
  http_status INTEGER,
  content_hash TEXT,
  extraction_method TEXT,
  extracted_text TEXT,
  char_count INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  ordinal INTEGER,
  heading TEXT,
  text TEXT,
  char_start INTEGER,
  char_end INTEGER
);
CREATE INDEX IF NOT EXISTS chunks_paper_id ON chunks(paper_id, ordinal);

-- Chunk embeddings, one row per chunk per model. Deleted with the chunk.
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,           -- float32 little-endian, L2-normalized
  PRIMARY KEY (chunk_id, model)
);

CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT,
  url TEXT,
  started_at TEXT,
  outcome TEXT,
  http_status INTEGER,
  bytes INTEGER,
  chunk_count INTEGER,
  duration_ms INTEGER,
  detail TEXT
);
`;

/** Open (and create if needed) the database. Pass ":memory:" in tests. */
export function openDb(file: string = config.dbPath): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  createKeywordIndex(db);
  return db;
}

/**
 * FTS5 index over chunk text, kept in sync with the chunks table by triggers.
 * Porter stemming so "routes"/"routing"/"routed" match each other.
 */
function createKeywordIndex(db: DB) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts'`).get();
  if (exists) return;
  db.exec(`
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      text, heading, content='chunks', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
    END;
    CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
    END;
    -- Index chunks stored before this index existed.
    INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
  `);
}

export interface StoredPaper {
  id: string;
  title: string | null;
  extracted_text: string;
}

export class PaperNotFoundError extends Error {}

/**
 * Look up a successfully ingested paper by id or by any URL form of it.
 * Never fetches: a paper that isn't stored is an error.
 */
export function getStoredPaper(db: DB, paperIdOrUrl: string): StoredPaper {
  let id = paperIdOrUrl.trim();
  if (/^https?:\/\//i.test(id)) id = canonicalId(id);
  const row = db
    .prepare(`SELECT id, title, extracted_text FROM papers WHERE id = ? AND last_success_at IS NOT NULL`)
    .get(id) as StoredPaper | undefined;
  if (!row) {
    throw new PaperNotFoundError(`paper ${id} is not ingested; run: npm run ingest-paper -- "<url>"`);
  }
  return row;
}
