import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL,
  timezone TEXT NOT NULL,
  lat REAL,
  lng REAL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  opt_out INTEGER NOT NULL DEFAULT 0,
  opt_out_reason TEXT,
  scenario TEXT,
  test_line INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_watch (
  site_id TEXT NOT NULL,
  watch_id TEXT NOT NULL,
  carries INTEGER NOT NULL DEFAULT 1,
  refused_at TEXT,
  wrong_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, watch_id)
);
CREATE TABLE IF NOT EXISTS sweeps (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  iso_week TEXT NOT NULL,
  planned_site_ids TEXT NOT NULL,
  undersampled TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (watch_id, iso_week)
);
CREATE TABLE IF NOT EXISTS dispatches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  watch_id TEXT,
  find_request_id TEXT,
  sweep_id TEXT,
  wave_index INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  site_ids TEXT NOT NULL,
  task_text TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  state TEXT NOT NULL,
  call_id TEXT,
  simulated INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  terminal_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS dispatches_state ON dispatches (state);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  watch_id TEXT,
  find_request_id TEXT,
  site_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  answered_by TEXT NOT NULL,
  reached_pharmacy TEXT NOT NULL,
  restock_expectation TEXT NOT NULL,
  quantity_note TEXT NOT NULL,
  evidence_quote TEXT NOT NULL,
  task_conf_score REAL,
  task_conf_label TEXT,
  do_not_call INTEGER NOT NULL,
  hold_response TEXT NOT NULL,
  usable INTEGER NOT NULL,
  usable_reason TEXT NOT NULL,
  simulated INTEGER NOT NULL,
  transcript_turns INTEGER NOT NULL,
  UNIQUE (dispatch_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS observations_site ON observations (site_id, observed_at);
CREATE INDEX IF NOT EXISTS observations_watch ON observations (watch_id, observed_at);
CREATE TABLE IF NOT EXISTS transcripts (
  dispatch_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  json TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  PRIMARY KEY (dispatch_id, recipient_id)
);
CREATE TABLE IF NOT EXISTS estimates (
  watch_id TEXT NOT NULL,
  iso_week TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (watch_id, iso_week)
);
CREATE TABLE IF NOT EXISTS inbox (
  event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  processed_at TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE TABLE IF NOT EXISTS find_requests (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside one transaction. Rolls back on any throw. */
export function withTx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
