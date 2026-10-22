// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: isolated test database
// (PostgreSQL engine, async adapter).
//
// C6-PG PORT (2026-10-22). Real, isolated, LOCAL PostgreSQL (verified against
// PostgreSQL 17.11 in a rootless podman container bound to 127.0.0.1 only,
// trust auth on loopback, synthetic data only). This module exists ONLY on the
// spike branch and is NEVER merged; it is NOT a production data layer and
// targets NO Supabase project.
//
// One handle = ONE pg Client (connection). This is deliberate: the contract
// server opens explicit transactions (BEGIN … COMMIT/ROLLBACK) and issues all
// statements of one transaction through the same handle — a pool would spread
// them over different connections and break transactional locality. The pg
// Client serializes queries on its connection, mirroring the single-handle
// semantics of the SQLite engine. Multi-connection concurrency (the T10 race,
// v9/v10) uses separate processes/clients, exactly like real pooled usage.
//
// Faithful translations applied by the adapter (each is a recorded
// SQLite→PostgreSQL difference, see results/SUMMARY.md):
//   1. `?` placeholders         → PostgreSQL `$1..$n`
//   2. `BEGIN IMMEDIATE`        → `BEGIN` (no IMMEDIATE in PostgreSQL; the
//                                 write-lock-at-BEGIN semantics SQLite provides
//                                 simply do NOT exist here — that is the point
//                                 of the v10 isolation probes)
//   3. `rowid`                  → `id` (PostgreSQL has no rowid; the PG schema
//                                 gives published_entities a real BIGSERIAL id)
//   4. int8 (BIGINT) results    → JS numbers via a type parser (the pg driver
//                                 DEFAULT is string — a production config
//                                 requirement, probed by v10 TYPE tests)

import pg from 'pg';
import { KILL_SWITCH_SEED } from './db.mjs';

// int8 → Number (epoch-ms BIGINTs and BIGSERIAL ids must stay JSON numbers).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const SCHEMA_PG = `
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  suspended INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE revisions (
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (submission_id, revision)
);
CREATE TABLE review_events (
  id BIGSERIAL PRIMARY KEY,
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE published_entities (
  id BIGSERIAL,
  uuid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  current_revision_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE published_revisions (
  id BIGSERIAL PRIMARY KEY,
  entity_uuid TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE change_feed (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_uuid TEXT NOT NULL,
  revision_ref BIGINT NOT NULL,
  provenance TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE audit_events (
  seq BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
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
  created_at BIGINT NOT NULL,
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

// Validate an injected schema identifier (test-controlled, but never trust
// interpolated SQL blindly).
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export function translateSql(sql) {
  let n = 0;
  return sql
    .replace(/\bBEGIN IMMEDIATE\b/g, 'BEGIN')
    .replace(/\browid\b/g, 'id')
    .replace(/\?/g, () => `$${(n += 1)}`);
}

// Open one PostgreSQL connection pinned to `schema` (a per-trial schema,
// created by the caller) inside the `database`. `schema: false` skips DDL
// (race-test children). All state lives inside the schema; each trial gets a
// fresh schema, so trials never share rows.
export async function openPgDb(
  { url = process.env.C6_PG_URL, database = 'c6spike', schema, ddl = true } = {}
) {
  if (!url) throw new Error('openPgDb: C6_PG_URL (or url) required');
  if (schema !== undefined && !IDENT_RE.test(schema))
    throw new Error(`openPgDb: unsafe schema identifier: ${schema}`);
  const client = new pg.Client({ connectionString: url, database });
  await client.connect();
  try {
    if (schema) {
      if (ddl) {
        // Fresh schema per trial — mirrors SQLite's per-test :memory: db and
        // gives total row isolation even when a previous run left state.
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.query(`CREATE SCHEMA ${schema}`);
      } else {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      }
      await client.query(`SET search_path TO ${schema}`);
    }
    if (schema && ddl) {
      await client.query(SCHEMA_PG);
      for (const stmt of KILL_SWITCH_SEED) await client.query(stmt);
    }
  } catch (e) {
    await client.end();
    throw e;
  }
  return {
    engine: 'postgres',
    client,
    async get(sql, params = []) {
      const r = await client.query(translateSql(sql), params);
      return r.rows[0];
    },
    async all(sql, params = []) {
      const r = await client.query(translateSql(sql), params);
      return r.rows;
    },
    async run(sql, params = []) {
      return client.query(translateSql(sql), params);
    },
    async exec(sql) {
      // exec receives control statements only (BEGIN/COMMIT/ROLLBACK/PRAGMA).
      if (/\bPRAGMA\b/i.test(sql)) return; // SQLite-only; no PG equivalent needed
      await client.query(translateSql(sql));
    },
    async close() {
      await client.end();
    },
  };
}

// Admin helper for the test harness: create/drop per-trial schemas using a
// separate short-lived connection.
export async function withAdmin(url, database, fn) {
  const admin = new pg.Client({ connectionString: url, database });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}
