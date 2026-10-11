import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Local SQLite persistence. This is a hackathon setup: one file on local disk
 * (plus private uploads next to it). It is not suitable for ephemeral or
 * serverless deployments where the disk does not persist between requests.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  owner_session TEXT NOT NULL,
  revision INTEGER NOT NULL,
  mode TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_owner ON cases(owner_session);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_case ON evidence(case_id);

CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  excerpt TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provenance_case ON provenance(case_id);

CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL,
  approved_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  UNIQUE(case_id, revision)
);

CREATE TABLE IF NOT EXISTS call_attempts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  authorization_id TEXT NOT NULL UNIQUE REFERENCES authorizations(id),
  request_id TEXT NOT NULL UNIQUE,
  provider_call_id TEXT UNIQUE,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  transcript TEXT,
  error TEXT,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS call_attempts_case ON call_attempts(case_id);

CREATE TABLE IF NOT EXISTS call_reconciliation (
  call_id TEXT PRIMARY KEY REFERENCES call_attempts(id),
  terminal_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_events (
  event_id TEXT PRIMARY KEY,
  provider_call_id TEXT NOT NULL,
  type TEXT NOT NULL,
  raw_body BLOB NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  call_id TEXT
);
CREATE INDEX IF NOT EXISTS provider_events_call ON provider_events(provider_call_id);
`;

export type Db = Database.Database;

type Cache = { dir: string; db: Db };
const globalCache = globalThis as unknown as { __refundDb?: Cache };

export function openDatabase(dataDir: string): Db {
  const cached = globalCache.__refundDb;
  if (cached && cached.dir === dataDir && cached.db.open) return cached.db;
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "refund.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  globalCache.__refundDb = { dir: dataDir, db };
  return db;
}

export function closeDatabase(): void {
  const cached = globalCache.__refundDb;
  if (cached) {
    cached.db.close();
    globalCache.__refundDb = undefined;
  }
}
