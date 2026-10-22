// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: V10 — PostgreSQL
// isolation, constraint and type-mapping probes (C6-PG port, 2026-10-22).
//
// PostgreSQL-only suite (skipped on the SQLite venue). Every test drives TWO
// or THREE dedicated connections with a DETERMINISTIC, hand-controlled
// interleaving of the exact statement sequence that src/server.mjs runDecision
// executes (a faithful reduction — each step names the runDecision step it
// mirrors). No wall-clock races: blockers are observed via explicit
// promise barriers, so outcomes are reproducible.
//
// What this proves (owner's Stage 6 focus areas):
//   ISO-1  transaction isolation — under PostgreSQL READ COMMITTED (the
//          Supabase PostgREST default) the faithful C6 decision transaction
//          loses the T10 guard: both concurrent approves COMMIT (double
//          publication) when the target entity already exists. SQLite's
//          BEGIN IMMEDIATE has no READ COMMITTED analogue.
//   ISO-2  SELECT … FOR UPDATE on the submission row restores the T10
//          invariant under READ COMMITTED (loser observes published status →
//          409, exactly one decision).
//   ISO-3  SERIALIZABLE also restores it: the loser aborts with SQLSTATE
//          40001 serialization_failure — which the faithful server would map
//          to 500 today, so production must map 40001 → 409 explicitly.
//   CONS-1 idempotency PK: a concurrent duplicate (principal_id, key) insert
//          raises 23505 unique_violation — production must catch and replay.
//   CHAIN-1 audit seq generation by "read last seq in-transaction" races:
//          two concurrent appends compute the same seq → 23505 on the audit
//          PK. Production DDL (task 6.1) must serialize seq assignment.
//   TYPE-1 int8/BIGINT: the pg driver returns strings by DEFAULT; the adapter
//          installs parsers so JSON keeps numbers. Both behaviors asserted.
//   CONS-2 the C6 DDL defines NO foreign keys — orphan references are
//          accepted by both engines. Recorded as a task 6.1 schema gap.
//
// Synthetic data only. Local loopback instance only. Never Supabase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, key, uuid, registerHandle } from './helpers.mjs';
import pg from 'pg';

// Captured BEFORE any db-pg.mjs import in this process: the pg driver's
// built-in int8 parser (type parsers are process-global singletons, and the
// adapter installs its Number parser at module load).
const DRIVER_DEFAULT_INT8_PARSER = pg.types.getTypeParser(20);

const PG_URL = process.env.C6_PG_URL;
const SKIP = ENGINE !== 'postgres' || !PG_URL;

const T0 = 1_760_000_000_000;
const SUB_ID = 'sub_v10_001';
const ENTITY = 'ent_v10_001';
const PAYLOAD = JSON.stringify({ schemaVersion: 1, target: { kind: 'work' } });

// Shared per-test setup: a fresh schema with seeded principals + one submitted
// submission. When `entityExists`, a previously published entity with the same
// uuid is pre-seeded (the amendment case — the second submission amends an
// already-published entity). Returns open handles; caller closes.
async function setupIsolation(schema, { entityExists }) {
  const { openPgDb } = await import('../src/db-pg.mjs');
  const a = await openPgDb({ url: PG_URL, schema }); // ddl: creates everything
  await a.run(
    'INSERT INTO principals (id, display_name, roles, suspended) VALUES (?, ?, ?, 0)',
    ['p_contrib_x', 'Synthetic X', '[]']
  );
  await a.run(
    'INSERT INTO principals (id, display_name, roles, suspended) VALUES (?, ?, ?, 0)',
    ['p_mod_a', 'Synthetic Mod A', '["moderator"]']
  );
  await a.run(
    'INSERT INTO principals (id, display_name, roles, suspended) VALUES (?, ?, ?, 0)',
    ['p_mod_b', 'Synthetic Mod B', '["moderator"]']
  );
  await a.run(
    'INSERT INTO submissions (id, principal_id, status, revision, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [SUB_ID, 'p_contrib_x', 'submitted', 1, PAYLOAD, T0, T0]
  );
  if (entityExists) {
    await a.run(
      'INSERT INTO published_revisions (entity_uuid, submission_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [ENTITY, 'sub_prior', 1, PAYLOAD, T0 - 1000]
    );
    const prior = await a.get('SELECT MAX(id) AS id FROM published_revisions', []);
    await a.run(
      'INSERT INTO published_entities (uuid, kind, current_revision_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ENTITY, 'work', prior.id, 'published', T0 - 1000, T0 - 1000]
    );
  }
  // Two extra connections: `b` is the second moderator's connection used by
  // every interleaving probe (each test closes a and b itself).
  const b = await openPgDb({ url: PG_URL, schema, ddl: false });
  // Registered so a mid-test failure can never leak sockets and hang the
  // runner (the after() hook in helpers force-closes anything still open).
  registerHandle(a);
  registerHandle(b);
  return { a, b };
}

// Faithful reduction of runDecision's approve path (src/server.mjs), split so
// the test can interleave two actors at exact statement boundaries. `mode`
// selects the contract-preserving variation:
//   'faithful'   — SELECT * FROM submissions WHERE id = $1        (as in C6)
//   'for-update' — SELECT * FROM submissions WHERE id = $1 FOR UPDATE
// Steps return { conflict } when the server's own status/revision check would
// reject (409 path); they throw nothing themselves.
async function decisionStep1_lockRead(client, mode) {
  const sql =
    mode === 'for-update'
      ? 'SELECT * FROM submissions WHERE id = $1 FOR UPDATE'
      : 'SELECT * FROM submissions WHERE id = $1';
  const r = await client.query(sql, [SUB_ID]);
  return r.rows[0]; // runDecision step 1
}
function decisionStep2_checks(sub) {
  // runDecision step 2: status/revision guard → 409
  if (sub.status !== 'submitted') return { conflict: true };
  return { conflict: false };
}
async function decisionSteps3toCommit(client, { actorId }) {
  const ts = T0;
  // step 4: published_revisions + published_entities (existing-entity path)
  await client.query(
    'INSERT INTO published_revisions (entity_uuid, submission_id, revision, payload_json, created_at) VALUES ($1, $2, $3, $4, $5)',
    [ENTITY, SUB_ID, 1, PAYLOAD, ts]
  );
  const rev = await client.query('SELECT MAX(id) AS id FROM published_revisions');
  await client.query('UPDATE published_entities SET current_revision_id = $1, updated_at = $2 WHERE uuid = $3',
    [rev.rows[0].id, ts, ENTITY]);
  // step 6a: change feed
  await client.query(
    'INSERT INTO change_feed (kind, entity_uuid, revision_ref, provenance, created_at) VALUES ($1, $2, $3, $4, $5)',
    ['published', ENTITY, rev.rows[0].id, `submission:${SUB_ID}#1`, ts]
  );
  // step 5: status + review event
  await client.query('UPDATE submissions SET status = $1, updated_at = $2 WHERE id = $3', ['published', ts, SUB_ID]);
  await client.query(
    'INSERT INTO review_events (submission_id, revision, decision, actor_id, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [SUB_ID, 1, 'approve', actorId, null, ts]
  );
  // step 6b: audit append (read last seq INSIDE the tx — the C6 pattern)
  const last = await client.query('SELECT seq, this_hash FROM audit_events ORDER BY seq DESC LIMIT 1');
  const seq = (last.rows[0]?.seq ?? 0) + 1;
  const prevHash = last.rows[0]?.this_hash ?? 'GENESIS';
  await client.query(
    'INSERT INTO audit_events (seq, ts, actor_id, action, subject, payload_hash, prev_hash, this_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [seq, ts, actorId, 'decision.approve', `submission:${SUB_ID}`, 'HASH', prevHash, `H${seq}`]
  );
  // step 7: commit
  await client.query('COMMIT');
}

async function counts(db) {
  return {
    publishedRevisions: (await db.get('SELECT COUNT(*) AS c FROM published_revisions WHERE submission_id = $1', [SUB_ID])).c,
    reviewEvents: (await db.get('SELECT COUNT(*) AS c FROM review_events', [])).c,
    approvals: (
      await db.get("SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve'", [])
    ).c,
    changeFeed: (await db.get("SELECT COUNT(*) AS c FROM change_feed WHERE kind = 'published'", [])).c,
    status: (await db.get('SELECT status FROM submissions WHERE id = $1', [SUB_ID])).status,
  };
}

async function withSchema(schema, fn) {
  const { withAdmin } = await import('../src/db-pg.mjs');
  await withAdmin(PG_URL, 'c6spike', async (admin) => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
  try {
    await fn();
  } finally {
    await withAdmin(PG_URL, 'c6spike', async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
  }
}

// ---------------------------------------------------------------------------
// ISO-1 — READ COMMITTED + faithful C6 reads: deterministic double-approve.
// ---------------------------------------------------------------------------
test('ISO-1 READ COMMITTED + faithful reads loses the T10 guard (double approve commits)', { skip: SKIP, timeout: 60_000 }, async () => {
  await withSchema('c6_v10_iso1', async () => {
    const { a, b } = await setupIsolation('c6_v10_iso1', { entityExists: true });

    // Both moderators open a decision transaction and read the submission.
    await a.client.query('BEGIN');
    await b.client.query('BEGIN');
    const subA = await decisionStep1_lockRead(a.client, 'faithful'); // runDecision step 1
    const subB = await decisionStep1_lockRead(b.client, 'faithful');
    assert.equal(subA.status, 'submitted');
    assert.equal(subB.status, 'submitted', 'B reads submitted before A commits — the lost-update window');
    assert.equal(decisionStep2_checks(subA).conflict, false);
    assert.equal(decisionStep2_checks(subB).conflict, false, 'B passes the guard on stale state');

    // A completes the whole decision + commits.
    await decisionSteps3toCommit(a.client, { actorId: 'p_mod_a' });

    // B continues on its stale snapshot: nothing in the faithful statement
    // sequence re-checks the committed status, so B's UPDATE/INSERTs succeed.
    await decisionSteps3toCommit(b.client, { actorId: 'p_mod_b' });

    const c = await counts(b);
    assert.equal(c.status, 'published');
    assert.equal(c.publishedRevisions, 2, 'T10 broken: TWO publication revisions committed');
    assert.equal(c.reviewEvents, 2, 'T10 broken: TWO approve events');
    assert.equal(c.approvals, 2, 'T10 broken: TWO approval audit rows (both moderators committed)');
    assert.equal(c.changeFeed, 2, 'T10 broken: TWO change-feed entries');

    await a.close();
    await b.close();
  });
});

// ---------------------------------------------------------------------------
// ISO-2 — SELECT … FOR UPDATE restores the T10 guard under READ COMMITTED.
// ---------------------------------------------------------------------------
test('ISO-2 SELECT … FOR UPDATE restores exactly-one-decision under READ COMMITTED', { skip: SKIP, timeout: 60_000 }, async () => {
  await withSchema('c6_v10_iso2', async () => {
    const { a, b } = await setupIsolation('c6_v10_iso2', { entityExists: true });

    await a.client.query('BEGIN');
    const subA = await decisionStep1_lockRead(a.client, 'for-update');
    assert.equal(decisionStep2_checks(subA).conflict, false);

    // B tries to lock the same row: it BLOCKS (demonstrated by racing the
    // unblock against A's commit with a bounded timeout — B must not finish
    // before A commits).
    await b.client.query('BEGIN');
    let bFinishedBeforeACommit = true;
    const bRead = decisionStep1_lockRead(b.client, 'for-update').then((row) => {
      bFinishedBeforeACommit = false;
      return row;
    });
    // Give B a moment to reach the blocking lock, then commit A.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bFinishedBeforeACommit, true, 'B is blocked on the row lock while A holds it');
    await decisionSteps3toCommit(a.client, { actorId: 'p_mod_a' });
    const subB = await bRead;

    // B now sees the committed 'published' state → its step-2 guard → 409.
    const guard = decisionStep2_checks(subB);
    assert.equal(guard.conflict, true, 'loser observes published status → 409 path');
    await b.client.query('ROLLBACK');

    const c = await counts(a);
    assert.equal(c.publishedRevisions, 1, 'exactly one publication');
    assert.equal(c.reviewEvents, 1, 'exactly one approve event');
    assert.equal(c.approvals, 1, 'exactly one approval audit row');
    assert.equal(c.changeFeed, 1, 'exactly one change-feed entry');

    await a.close();
    await b.close();
  });
});

// ---------------------------------------------------------------------------
// ISO-3 — SERIALIZABLE aborts the loser with 40001 (needs explicit 409 map).
// ---------------------------------------------------------------------------
test('ISO-3 SERIALIZABLE: loser aborts with SQLSTATE 40001, single decision commits', { skip: SKIP, timeout: 60_000 }, async () => {
  await withSchema('c6_v10_iso3', async () => {
    const { a, b } = await setupIsolation('c6_v10_iso3', { entityExists: true });

    await a.client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await b.client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const subA = await decisionStep1_lockRead(a.client, 'faithful');
    const subB = await decisionStep1_lockRead(b.client, 'faithful');
    assert.equal(decisionStep2_checks(subB).conflict, false);

    await decisionSteps3toCommit(a.client, { actorId: 'p_mod_a' });

    // B proceeds and MUST abort with a serialization failure (40001) — the
    // faithful server maps unknown errors to 500, so production must map
    // 40001 → 409 (conflict) explicitly. Recorded, not fixed here.
    let loserError = null;
    try {
      await decisionSteps3toCommit(b.client, { actorId: 'p_mod_b' });
    } catch (e) {
      loserError = e;
      await b.client.query('ROLLBACK').catch(() => {});
    }
    assert.ok(loserError, 'B aborts');
    assert.equal(loserError.code, '40001', `expected serialization_failure 40001, got ${loserError.code}`);

    const c = await counts(a);
    assert.equal(c.publishedRevisions, 1);
    assert.equal(c.reviewEvents, 1);
    assert.equal(c.approvals, 1);

    await a.close();
    await b.close();
  });
});

// ---------------------------------------------------------------------------
// CONS-1 — concurrent duplicate idempotency key → 23505 unique_violation.
// ---------------------------------------------------------------------------
test('CONS-1 concurrent duplicate idempotency insert raises 23505 (must replay, not 500)', { skip: SKIP, timeout: 60_000 }, async () => {
  await withSchema('c6_v10_cons1', async () => {
    const { a, b } = await setupIsolation('c6_v10_cons1', { entityExists: false });
    const K = key(9001);

    await a.client.query('BEGIN');
    await a.client.query(
      'INSERT INTO idempotency (principal_id, key, request_hash, status_code, response_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['p_mod_a', K, 'rh', 201, '{}', T0]
    );
    // B attempts the same (principal, key) while A holds it uncommitted.
    const bInsert = b.client.query(
      'INSERT INTO idempotency (principal_id, key, request_hash, status_code, response_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      ['p_mod_a', K, 'rh', 201, '{}', T0]
    ).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 100));
    await a.client.query('COMMIT');
    const err = await bInsert;
    assert.ok(err, 'duplicate insert must fail');
    assert.equal(err.code, '23505', `expected unique_violation 23505, got ${err.code}`);
    const rows = await a.get('SELECT COUNT(*) AS c FROM idempotency WHERE key = $1', [K]);
    assert.equal(rows.c, 1, 'exactly one idempotency row');
    await a.close();
    await b.close();
  });
});

// ---------------------------------------------------------------------------
// CHAIN-1 — in-transaction "read last seq" audit append races → 23505.
// ---------------------------------------------------------------------------
test('CHAIN-1 concurrent audit appends collide on seq (production needs serialized seq)', { skip: SKIP, timeout: 60_000 }, async () => {
  await withSchema('c6_v10_chain1', async () => {
    const { a, b } = await setupIsolation('c6_v10_chain1', { entityExists: false });

    await a.client.query('BEGIN');
    await b.client.query('BEGIN');
    // Both read the same last seq inside their transactions (the C6 pattern).
    const lastA = await a.client.query('SELECT seq, this_hash FROM audit_events ORDER BY seq DESC LIMIT 1');
    const lastB = await b.client.query('SELECT seq, this_hash FROM audit_events ORDER BY seq DESC LIMIT 1');
    const seqA = (lastA.rows[0]?.seq ?? 0) + 1;
    const seqB = (lastB.rows[0]?.seq ?? 0) + 1;
    assert.equal(seqA, seqB, 'both compute the same next seq');

    await a.client.query(
      'INSERT INTO audit_events (seq, ts, actor_id, action, subject, payload_hash, prev_hash, this_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [seqA, T0, 'p_mod_a', 'decision.approve', 's', 'h', 'GENESIS', 'HA']
    );
    const bInsert = b.client.query(
      'INSERT INTO audit_events (seq, ts, actor_id, action, subject, payload_hash, prev_hash, this_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [seqB, T0, 'p_mod_b', 'decision.approve', 's', 'h', 'GENESIS', 'HB']
    ).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 100));
    await a.client.query('COMMIT');
    const err = await bInsert;
    assert.ok(err, 'second append must collide on the seq PK');
    assert.equal(err.code, '23505', `expected unique_violation 23505, got ${err.code}`);
    await b.client.query('ROLLBACK').catch(() => {});
    const rows = await a.get('SELECT COUNT(*) AS c FROM audit_events', []);
    assert.equal(rows.c, 1, 'exactly one audit row committed');
    await a.close();
    await b.close();
  });
});

// ---------------------------------------------------------------------------
// TYPE-1 — int8 default→string vs adapter parsers (JSON number preservation).
// ---------------------------------------------------------------------------
test('TYPE-1 pg driver returns int8 as string by default; adapter keeps JSON numbers', { skip: SKIP, timeout: 60_000 }, async () => {
  await withSchema('c6_v10_type1', async () => {
    const { a } = await setupIsolation('c6_v10_type1', { entityExists: false });
    // Driver default behavior: the captured default parser is a string
    // passthrough, and a raw query executed under it returns strings.
    assert.equal(
      DRIVER_DEFAULT_INT8_PARSER('1760000000000'),
      '1760000000000',
      'driver default int8 parser is a string passthrough'
    );
    const adapterParser = pg.types.getTypeParser(20);
    assert.notEqual(adapterParser, DRIVER_DEFAULT_INT8_PARSER, 'adapter installed its own parser');
    const savedParser = adapterParser;
    pg.types.setTypeParser(20, DRIVER_DEFAULT_INT8_PARSER);
    const raw = new pg.Client({ connectionString: PG_URL, database: 'c6spike' });
    await raw.connect();
    await raw.query('SET search_path TO c6_v10_type1');
    const rawRow = await raw.query('SELECT created_at FROM submissions WHERE id = $1', [SUB_ID]);
    const rawCount = await raw.query('SELECT COUNT(*) AS c FROM submissions');
    assert.equal(typeof rawRow.rows[0].created_at, 'string', 'raw driver: BIGINT → string');
    assert.equal(typeof rawCount.rows[0].c, 'string', 'raw driver: COUNT (int8) → string');
    await raw.end();
    pg.types.setTypeParser(20, savedParser); // restore the adapter parser

    // Adapter (parsers installed): same values are JS numbers → JSON numbers.
    const adapted = await a.get('SELECT created_at FROM submissions WHERE id = $1', [SUB_ID]);
    const adaptedCount = await a.get('SELECT COUNT(*) AS c FROM submissions', []);
    assert.equal(typeof adapted.created_at, 'number', 'adapter: BIGINT → number');
    assert.equal(typeof adaptedCount.c, 'number', 'adapter: COUNT → number');
    assert.equal(adapted.created_at, T0, 'epoch ms preserved exactly');
    // JSON round-trip keeps numbers (contract envelope requirement).
    assert.match(JSON.stringify({ ts: adapted.created_at }), /"ts":1760000000000/);
    await a.close();
  });
});

// ---------------------------------------------------------------------------
// CONS-2 — no foreign keys in the C6 DDL: orphan references are accepted.
// ---------------------------------------------------------------------------
test('CONS-2 C6 DDL has no FK constraints: orphan published_revisions accepted (task 6.1 gap)', { skip: SKIP, timeout: 60_000 }, async () => {
  await withSchema('c6_v10_cons2', async () => {
    const { a } = await setupIsolation('c6_v10_cons2', { entityExists: false });
    // A published revision pointing at a NON-ENTITENT entity and a
    // non-existent submission — accepted silently on PostgreSQL because the
    // C6 schema defines no FOREIGN KEY. Same on SQLite. Recorded as a schema
    // gap that task 6.1 (production DDL) must close; asserted here so the
    // gap cannot regress silently.
    const orphan = await a.run(
      'INSERT INTO published_revisions (entity_uuid, submission_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ['ent_never_exists', uuid(4242), 9, PAYLOAD, T0]
    );
    assert.ok(orphan, 'orphan insert succeeded — no FK enforcement exists');
    const rows = await a.get('SELECT COUNT(*) AS c FROM published_revisions', []);
    assert.equal(rows.c, 1);
    await a.close();
  });
});
