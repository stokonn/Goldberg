// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: isolated test database.
//
// Disposable, per-run SQLite database via Node's built-in `node:sqlite`
// (experimental; Node 22.23.1). Zero npm dependencies. Never touches any
// application database (opus.db) or any remote service. Both `:memory:` and
// scratch file databases are supported; file databases are used only by the
// multi-process race scenario and live under `.scratch/` (gitignored).

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  suspended INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE revisions (
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (submission_id, revision)
);
CREATE TABLE review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE published_entities (
  uuid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  current_revision_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE published_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_uuid TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE change_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_uuid TEXT NOT NULL,
  revision_ref INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  this_hash TEXT NOT NULL
);
CREATE TABLE idempotency (
  principal_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, key)
);
CREATE TABLE quota_counters (
  principal_id TEXT NOT NULL,
  day TEXT NOT NULL,
  submissions_count INTEGER NOT NULL,
  PRIMARY KEY (principal_id, day)
);
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Open a fresh, isolated database. No state is ever shared between opens
// except when the same scratch file path is deliberately reused (race test).
// `schema: false` reopens an existing file database without re-creating tables
// (used by the race-test child processes).
export function openDb(path = ':memory:', { schema = true } = {}) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode=WAL');
  }
  db.exec('PRAGMA busy_timeout = 5000');
  if (schema) {
    db.exec(SCHEMA);
    db.prepare('INSERT INTO config (key, value) VALUES (?, ?)').run('kill_switch', 'off');
  }
  return db;
}

// Seed a synthetic principal (obviously fictional identities only).
export function seedPrincipal(db, id, displayName, roles = []) {
  db.prepare(
    'INSERT INTO principals (id, display_name, roles, suspended) VALUES (?, ?, ?, 0)'
  ).run(id, displayName, JSON.stringify(roles));
}
