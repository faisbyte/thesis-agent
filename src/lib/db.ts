import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config";

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
  return db;
}
