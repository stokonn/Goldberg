// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: V9 multi-process
// concurrent-decision race (THREAT-MODEL row T10: two moderators approve
// simultaneously from separate processes → exactly one decision commits,
// the loser gets 409, never double-approve / last-write-wins).
//
// Method: a shared trial database (SQLite scratch file — WAL + busy_timeout —
// or a pinned per-trial PostgreSQL schema), two independent Node processes
// barrier-synced on a sentinel file, each running the full approval
// transaction. The invariant asserted is the OUTCOME; wall-clock interleaving
// order between processes is not asserted.
//
// C6-PG PORT (2026-10-22): engine-aware via C6_ENGINE. SQLite venue asserts
// the original invariant ([201, 409] every trial — the SQLite write lock
// serializes BEGIN IMMEDIATE writers). The PostgreSQL venue (default READ
// COMMITTED — the same default as Supabase's PostgREST pool) records the
// actual outcomes and asserts only structural invariants that MUST hold under
// any interleaving (coherent row counts matching the number of committed
// decisions, verifiable audit chain); the deterministic isolation probes that
// explain the observed PostgreSQL outcomes live in v10-pg-isolation.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDb, seedPrincipal } from '../src/db.mjs';
import { createServer, verifyChain } from '../src/server.mjs';
import { validPayload, key, ENGINE } from './helpers.mjs';

const T0 = 1_760_000_000_000;
const SCRATCH = fileURLToPath(new URL('../.scratch/', import.meta.url));
const CHILD = fileURLToPath(new URL('../tools/decide-child.mjs', import.meta.url));
const TRIALS = 10;
const PG_URL = process.env.C6_PG_URL;

// Spawn helper: resolves `ready` when the child prints READY, `exited` with
// its exit code; stdout/stderr accumulate in `state`.
function launchChild(args) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '' };
  const ready = new Promise((resolveReady) => {
    child.stdout.on('data', (d) => {
      state.out += d.toString();
      if (state.out.includes('READY')) resolveReady(true);
    });
  });
  child.stderr.on('data', (d) => {
    state.err += d.toString();
  });
  const exited = new Promise((resolveExit) => {
    child.on('close', (code) => resolveExit(code));
  });
  return { child, ready, exited, state };
}

function cleanup(files) {
  for (const f of files) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

test('V9 multi-process concurrent approve race (T10)', { timeout: 120_000 }, async () => {
  assert.ok(ENGINE !== 'postgres' || PG_URL, 'C6_ENGINE=postgres requires C6_PG_URL');
  mkdirSync(SCRATCH, { recursive: true });
  const outcomes = [];

  for (let trial = 0; trial < TRIALS; trial += 1) {
    let db;
    let childArgsCommon;
    let reopen;
    let dropTrial;

    if (ENGINE === 'postgres') {
      const { openPgDb, withAdmin } = await import('../src/db-pg.mjs');
      const schema = `c6_race_${trial}`;
      await withAdmin(PG_URL, 'c6spike', async (admin) => {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.query(`CREATE SCHEMA ${schema}`);
      });
      db = await openPgDb({ url: PG_URL, schema });
      childArgsCommon = ['postgres', PG_URL, schema];
      reopen = () => openPgDb({ url: PG_URL, schema, ddl: false });
      dropTrial = async () => {
        await db.close();
        await withAdmin(PG_URL, 'c6spike', (admin) => admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
      };
    } else {
      const dbPath = join(SCRATCH, `race-${trial}.db`);
      cleanup([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
      db = openDb(dbPath);
      childArgsCommon = ['sqlite', dbPath, '-']; // '-' = unused schema slot
      reopen = () => openDb(dbPath, { schema: false });
      dropTrial = async () => {
        await db.close();
        cleanup([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
      };
    }

    const barrierPath = join(SCRATCH, `go-${trial}-${ENGINE}`);
    cleanup([barrierPath]);

    await seedPrincipal(db, 'p_contrib_r', 'Synthetic Racer', []);
    await seedPrincipal(db, 'p_mod_a', 'Synthetic Mod A', ['moderator']);
    await seedPrincipal(db, 'p_mod_b', 'Synthetic Mod B', ['moderator']);
    const server = createServer({ db, now: () => T0 });
    const signIn = async (pid) => {
      const r = await server.handle({
        method: 'POST',
        path: '/v1/session',
        body: { schemaVersion: 1, credential: `synthetic:${pid}` },
      });
      assert.equal(r.status, 201);
      return r.body.sid;
    };
    const contribRes = await server.handle({
      method: 'POST',
      path: '/v1/session',
      body: { schemaVersion: 1, credential: 'synthetic:p_contrib_r' },
    });
    const created = await server.handle({
      method: 'POST',
      path: '/v1/submissions',
      session: contribRes.body.sid,
      body: { schemaVersion: 1, payload: validPayload() },
    });
    assert.equal(created.status, 201);
    const subId = created.body.submissionId;
    const sidA = await signIn('p_mod_a');
    const sidB = await signIn('p_mod_b');

    const a = launchChild([...childArgsCommon, sidA, subId, barrierPath, key(200 + trial * 2)]);
    const b = launchChild([...childArgsCommon, sidB, subId, barrierPath, key(201 + trial * 2)]);
    await Promise.all([a.ready, b.ready]);
    writeFileSync(barrierPath, 'go');
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    assert.equal(codeA, 0, `child A exit 0 (stderr: ${a.state.err})`);
    assert.equal(codeB, 0, `child B exit 0 (stderr: ${b.state.err})`);

    const lineA = a.state.out.trim().split('\n').at(-1);
    const lineB = b.state.out.trim().split('\n').at(-1);
    const resA = JSON.parse(lineA);
    const resB = JSON.parse(lineB);
    outcomes.push([resA.status, resB.status]);

    // Structural invariants that MUST hold under ANY interleaving on BOTH
    // engines: coherent committed state and a verifiable audit chain. The
    // contract-level outcome invariant ([201, 409] exactly) is asserted only
    // for SQLite (where BEGIN IMMEDIATE guarantees it); the PostgreSQL venue
    // RECORDS actual outcomes as evidence — deviations (double-approve or a
    // loser 500 instead of 409) are the T10 finding, demonstrated
    // deterministically in v10-pg-isolation.test.mjs.
    const statuses = [resA.status, resB.status];
    for (const s of statuses) {
      assert.ok(
        [201, 409, 500].includes(s),
        `trial ${trial}: unexpected status class, got ${lineA} / ${lineB}`
      );
    }
    const commits = statuses.filter((s) => s === 201).length;
    assert.ok(commits >= 1, `trial ${trial}: at least one decision must commit`);

    const checkDb = await reopen();
    const publishedRev = await checkDb.get('SELECT COUNT(*) AS c FROM published_revisions', []);
    const publishedEnt = await checkDb.get('SELECT COUNT(*) AS c FROM published_entities', []);
    const reviewEvents = await checkDb.get('SELECT COUNT(*) AS c FROM review_events', []);
    const approvals = await checkDb.get(
      "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve'",
      []
    );
    const statusRow = await checkDb.get('SELECT status FROM submissions WHERE id = ?', [subId]);
    const chain = await verifyChain(checkDb);

    if (ENGINE === 'sqlite') {
      // SQLite venue: BEGIN IMMEDIATE + the write lock MUST yield exactly one
      // winner every trial (original C6 invariant).
      assert.deepEqual(
        statuses.sort(),
        [201, 409],
        `trial ${trial}: expected one 201 and one 409, got ${lineA} / ${lineB}`
      );
      assert.equal(publishedRev.c, 1);
      assert.equal(publishedEnt.c, 1);
      assert.equal(reviewEvents.c, 1);
      assert.equal(approvals.c, 1, 'exactly one approval audit row');
    } else {
      // PostgreSQL venue (READ COMMITTED): the counts must at minimum be
      // CONSISTENT with how many decisions actually committed — the observed
      // outcome itself is evidence for v10, not asserted away here.
      assert.equal(publishedRev.c, commits, `trial ${trial}: published_revisions == committed decisions`);
      assert.equal(reviewEvents.c, commits, `trial ${trial}: review_events == committed decisions`);
      assert.equal(approvals.c, commits, `trial ${trial}: approval audits == committed decisions`);
    }
    assert.equal(publishedEnt.c, 1, 'single entity row (upsert semantics)');
    assert.equal(statusRow.status, 'published');
    assert.equal(chain.ok, true, 'audit chain coherent after race');

    await checkDb.close();
    await dropTrial();
    cleanup([barrierPath]);
  }

  assert.equal(outcomes.length, TRIALS);
  process.stdout.write(
    `V9 race outcomes [${ENGINE}] across ${TRIALS} trials: ${JSON.stringify(outcomes)}\n`
  );
  if (ENGINE === 'postgres') {
    const deviations = outcomes.filter((o) => o.slice().sort().join(',') !== '201,409');
    process.stdout.write(
      `V9 [postgres] T10-invariant deviations (not [201,409]): ${deviations.length}/${TRIALS} — ${JSON.stringify(deviations)}\n`
    );
  }
});

test('V9 scratch dir is disposable and contains no committed data', () => {
  // .scratch must be gitignored (README + .gitignore) — presence check only
  const gitignore = readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf-8');
  assert.match(gitignore, /\.scratch\//);
  assert.match(gitignore, /node_modules\//);
});
