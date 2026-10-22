// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: isolated test database
// (SQLite engine, async adapter).
//
// Disposable, per-run SQLite database via Node's built-in `node:sqlite`
// (experimental; Node 22.23.1). Never touches any application database
// (opus.db) or any remote service. Both `:memory:` and scratch file databases
// are supported; file databases are used only by the multi-process race
// scenario and live under `.scratch/` (gitignored).
//
// C6-PG PORT NOTE (2026-10-22): the adapter interface is now ASYNC
// (`get/all/run/exec/close`) so the SAME server and the SAME test suites can
// run against real PostgreSQL (src/db-pg.mjs). The SQLite engine keeps its
// original zero-npm-dependency property; the PostgreSQL venue adds exactly one
// dependency (`pg`, the wire client) on the spike branch only.

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

// Shared seed used by BOTH engines: `kill_switch = off`.
export const KILL_SWITCH_SEED = ["INSERT INTO config (key, value) VALUES ('kill_switch', 'off')"];

// Open a fresh, isolated SQLite database behind the async adapter interface.
// No state is ever shared between opens except when the same scratch file
// path is deliberately reused (race test). `schema: false` reopens an
// existing file database without re-creating tables (race-test children).
export function openDb(path = ':memory:', { schema = true } = {}) {
  const raw = new DatabaseSync(path);
  if (path !== ':memory:') {
    raw.exec('PRAGMA journal_mode=WAL');
  }
  raw.exec('PRAGMA busy_timeout = 5000');
  if (schema) {
    raw.exec(SCHEMA);
    for (const stmt of KILL_SWITCH_SEED) raw.exec(stmt);
  }
  return {
    engine: 'sqlite',
    async get(sql, params = []) {
      return raw.prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params);
    },
    async run(sql, params = []) {
      return raw.prepare(sql).run(...params);
    },
    async exec(sql) {
      raw.exec(sql);
    },
    async close() {
      raw.close();
    },
  };
}

// Seed a synthetic principal (obviously fictional identities only).
export async function seedPrincipal(db, id, displayName, roles = []) {
  await db.run(
    'INSERT INTO principals (id, display_name, roles, suspended) VALUES (?, ?, ?, 0)',
    [id, displayName, JSON.stringify(roles)]
  );
}
