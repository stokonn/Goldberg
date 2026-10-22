// Goldberg 0.11 Stage 6 — C6-PG CONCURRENCY HARDENING (EXPERIMENTAL, v11).
//
// ⚠ EXPERIMENTAL MITIGATION SUITE — not production verification, never merged.
// It compares two candidate mitigations for findings F1/F3/F4 (results/
// SUMMARY-PG.md) through the EXPERIMENTAL hardened server (src/harden.mjs):
//
//   H1/H2  in-process exactly-one-decision races through the REAL hardened
//          server, both strategies, both entity paths (new / pre-existing).
//   H3/H4  REPEATED multi-process barrier race (20 trials per strategy)
//          through the hardened server — the mitigation counterpart of the
//          v9 race that recorded 10/10 deviations on the faithful server.
//   H5     contract + negative behavior (happy path, replay, 403/400/409/503,
//          kill switch, fault-injection atomicity, concurrent same-key dup).
//   H6     F3 deterministic idempotency-store race: 23505 → stored replay.
//   H7     F4 audit integrity at scale: 20 concurrent decisions, consecutive
//          seqs, verifiable chain, per-strategy retry telemetry.
//
// PostgreSQL-only (skipped on the SQLite regression venue, which keeps
// exercising the UNMODIFIED faithful server — the SQLite regression guarantee).
// The original failing evidence under results/pg/ is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { seedPrincipal } from '../src/db.mjs';
import { createServer, verifyChain } from '../src/server.mjs';
import {
  createHardenedServer,
  ensureHardenedDdl,
  hardenedStoreIdempotency,
  STRATEGIES,
} from '../src/harden.mjs';
import {
  harness,
  seedStandardPrincipals,
  validPayload,
  key,
  ENGINE,
  T0,
  registerHandle,
} from './helpers.mjs';

const PG_ONLY = {
  skip: ENGINE !== 'postgres' ? 'PostgreSQL-only venue (concurrency hardening)' : false,
};
const PG_URL = process.env.C6_PG_URL;
const SCRATCH = fileURLToPath(new URL('../.scratch/', import.meta.url));
const CHILD = fileURLToPath(new URL('../tools/decide-hardened-child.mjs', import.meta.url));
const TRIALS = 20;

async function siblingHandle(schema) {
  const { openPgDb } = await import('../src/db-pg.mjs');
  return registerHandle(await openPgDb({ url: PG_URL, schema, ddl: false }));
}

async function currentSchemaOf(db) {
  const row = await db.get('SELECT current_schema() AS s');
  return row.s;
}

function sumRetries(servers) {
  const acc = { serialization: 0, deadlock: 0, uniqueViolation: 0, auditConflict: 0, mappedTo409: 0 };
  for (const s of servers) {
    for (const k of Object.keys(s.stats.retries)) acc[k] += s.stats.retries[k];
    acc.mappedTo409 += s.stats.mappedTo409;
  }
  acc.total =
    acc.serialization + acc.deadlock + acc.uniqueViolation + acc.auditConflict;
  return acc;
}

// ---------------------------------------------------------------------------
// H1 / H2 — in-process exactly-one-decision races through the REAL server
// ---------------------------------------------------------------------------
async function inProcessRace(t, strategy) {
  assert.ok(PG_URL, 'C6_ENGINE=postgres requires C6_PG_URL');
  for (const entityCase of ['new entity', 'pre-existing entity']) {
    await t.test(`approve race, ${entityCase}`, async () => {
      const h = await harness();
      await ensureHardenedDdl(h.db);
      await seedStandardPrincipals(h.db);
      const db2 = await siblingHandle(await currentSchemaOf(h.db));

      const contrib = await h.signIn('p_contrib_a');
      const created = await h.req({
        method: 'POST',
        path: '/v1/submissions',
        session: contrib,
        body: { schemaVersion: 1, payload: validPayload() },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const subId = created.body.submissionId;
      const sidA = await h.signIn('p_mod_1');
      const sidB = await h.signIn('p_mod_2');

      let seededRevision = 0;
      if (entityCase === 'pre-existing entity') {
        const ent = `ent_${subId}`;
        await h.db.run(
          'INSERT INTO published_revisions (entity_uuid, submission_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
          [ent, 'seed_sub', 0, '{}', T0]
        );
        const rid = (await h.db.get('SELECT MAX(id) AS id FROM published_revisions')).id;
        await h.db.run(
          'INSERT INTO published_entities (uuid, kind, current_revision_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [ent, 'work', rid, 'published', T0, T0]
        );
        seededRevision = 1;
      }

      const A = createHardenedServer({ db: h.db, now: h.now, strategy });
      const B = createHardenedServer({ db: db2, now: h.now, strategy });
      const dec = (srv, sid, k) =>
        srv.handle({
          method: 'POST',
          path: `/v1/admin/submissions/${subId}/decisions`,
          session: sid,
          body: { schemaVersion: 1, decision: 'approve', expectedRevision: 1, idempotencyKey: k },
        });

      const [ra, rb] = await Promise.all([dec(A, sidA, key(2101)), dec(B, sidB, key(2102))]);
      // THE invariant: exactly one commit, loser 409 — never 2×201, never 500.
      assert.deepEqual(
        [ra.status, rb.status].sort((x, y) => x - y),
        [201, 409],
        `strategy=${strategy} case=${entityCase}: got ${ra.status}/${rb.status} ${JSON.stringify([ra.body, rb.body])}`
      );

      const rev = await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', []);
      const ent = await h.db.get('SELECT COUNT(*) AS c FROM published_entities', []);
      const revs = await h.db.get('SELECT COUNT(*) AS c FROM review_events', []);
      const appr = await h.db.get(
        "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve'",
        []
      );
      const st = await h.db.get('SELECT status FROM submissions WHERE id = ?', [subId]);
      const chain = await verifyChain(h.db);
      assert.equal(revs.c, 1, 'exactly one review event');
      assert.equal(appr.c, 1, 'exactly one approval audit row');
      assert.equal(rev.c, 1 + seededRevision, 'exactly one published revision (plus seed if any)');
      assert.equal(ent.c, 1, 'single entity row');
      assert.equal(st.status, 'published');
      assert.equal(chain.ok, true, 'audit chain coherent');

      const retries = sumRetries([A, B]);
      process.stdout.write(
        `V11 race [${strategy}, ${entityCase}] telemetry: ${JSON.stringify(retries)}\n`
      );
      if (strategy === 'for-update') {
        assert.equal(retries.total, 0, 'for-update never triggers SQLSTATE retries');
        assert.equal(retries.mappedTo409, 0, 'for-update never exhausts retry');
      }
    });
  }
}

test('V11-1 for-update: exactly-one-decision through the real hardened server (in-process)', PG_ONLY, async (t) => {
  await inProcessRace(t, 'for-update');
});

test('V11-2 serializable: exactly-one-decision with SQLSTATE handling (in-process)', PG_ONLY, async (t) => {
  await inProcessRace(t, 'serializable');
});

// ---------------------------------------------------------------------------
// H3 / H4 — REPEATED multi-process barrier race through the hardened server
// ---------------------------------------------------------------------------
function launchChild(args) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '' };
  const ready = new Promise((resolveReady) => {
    child.stdout.on('data', (d) => {
      state.out += d.toString();
      if (state.out.includes('READY')) resolveReady(true);
    });
    // A child that dies before READY must not hang the parent: resolve false.
    child.on('close', () => resolveReady(false));
  });
  child.stderr.on('data', (d) => {
    state.err += d.toString();
  });
  const exited = new Promise((resolveExit) => {
    child.on('close', (code) => resolveExit(code));
  });
  return { child, ready, exited, state };
}

async function runHardenedRace(strategy) {
  assert.ok(PG_URL, 'C6_ENGINE=postgres requires C6_PG_URL');
  const { openPgDb, withAdmin } = await import('../src/db-pg.mjs');
  mkdirSync(SCRATCH, { recursive: true });
  const outcomes = [];
  const telemetry = {
    serialization: 0,
    deadlock: 0,
    uniqueViolation: 0,
    auditConflict: 0,
    mappedTo409: 0,
    total: 0,
  };

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const schema = `c6_hard_${strategy.replace('-', '')}_${trial}`;
    await withAdmin(PG_URL, 'c6spike', async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
    });
    const db = await openPgDb({ url: PG_URL, schema });
    await ensureHardenedDdl(db);
    await seedPrincipal(db, 'p_contrib_r', 'Synthetic Racer', []);
    await seedPrincipal(db, 'p_mod_a', 'Synthetic Mod A', ['moderator']);
    await seedPrincipal(db, 'p_mod_b', 'Synthetic Mod B', ['moderator']);

    // Faithful server for setup only (sign-in + submission creation) —
    // the race itself runs through the EXPERIMENTAL hardened child.
    const faithful = createServer({ db, now: () => T0 });
    const signIn = async (pid) => {
      const r = await faithful.handle({
        method: 'POST',
        path: '/v1/session',
        body: { schemaVersion: 1, credential: `synthetic:${pid}` },
      });
      assert.equal(r.status, 201);
      return r.body.sid;
    };
    const contribRes = await faithful.handle({
      method: 'POST',
      path: '/v1/session',
      body: { schemaVersion: 1, credential: 'synthetic:p_contrib_r' },
    });
    const created = await faithful.handle({
      method: 'POST',
      path: '/v1/submissions',
      session: contribRes.body.sid,
      body: { schemaVersion: 1, payload: validPayload() },
    });
    assert.equal(created.status, 201);
    const subId = created.body.submissionId;
    const sidA = await signIn('p_mod_a');
    const sidB = await signIn('p_mod_b');

    const barrierPath = join(SCRATCH, `hgo-${strategy}-${trial}`);
    if (existsSync(barrierPath)) rmSync(barrierPath, { force: true });

    const common = ['postgres', PG_URL, schema];
    const a = launchChild([...common, sidA, subId, barrierPath, key(3000 + trial * 2), strategy]);
    const b = launchChild([...common, sidB, subId, barrierPath, key(3001 + trial * 2), strategy]);
    const [readyA, readyB] = await Promise.all([a.ready, b.ready]);
    assert.ok(
      readyA && readyB,
      `both children must reach READY before the barrier (A: ${a.state.out}${a.state.err} | B: ${b.state.out}${b.state.err})`
    );
    writeFileSync(barrierPath, 'go');
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    assert.equal(codeA, 0, `child A exit 0 (stderr: ${a.state.err})`);
    assert.equal(codeB, 0, `child B exit 0 (stderr: ${b.state.err})`);

    const resA = JSON.parse(a.state.out.trim().split('\n').at(-1));
    const resB = JSON.parse(b.state.out.trim().split('\n').at(-1));
    outcomes.push([resA.status, resB.status]);

    // THE mitigation invariant (v9 recorded 10/10 deviations here on the
    // faithful server): exactly [201, 409] every trial — no double-approve,
    // no loser 500.
    assert.deepEqual(
      [resA.status, resB.status].sort((x, y) => x - y),
      [201, 409],
      `trial ${trial}: expected [201,409], got ${JSON.stringify([resA, resB])}`
    );
    for (const r of [resA, resB]) {
      telemetry.serialization += r.stats.retries.serialization;
      telemetry.deadlock += r.stats.retries.deadlock;
      telemetry.uniqueViolation += r.stats.retries.uniqueViolation;
      telemetry.auditConflict += r.stats.retries.auditConflict;
      telemetry.mappedTo409 += r.stats.mappedTo409;
    }

    // Exact committed-state invariants (strict — one decision only).
    const checkDb = await openPgDb({ url: PG_URL, schema, ddl: false });
    const publishedRev = await checkDb.get('SELECT COUNT(*) AS c FROM published_revisions', []);
    const publishedEnt = await checkDb.get('SELECT COUNT(*) AS c FROM published_entities', []);
    const reviewEvents = await checkDb.get('SELECT COUNT(*) AS c FROM review_events', []);
    const approvals = await checkDb.get(
      "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve'",
      []
    );
    const statusRow = await checkDb.get('SELECT status FROM submissions WHERE id = ?', [subId]);
    const chain = await verifyChain(checkDb);
    assert.equal(publishedRev.c, 1, `trial ${trial}: exactly one published revision`);
    assert.equal(publishedEnt.c, 1, `trial ${trial}: single entity row`);
    assert.equal(reviewEvents.c, 1, `trial ${trial}: exactly one review event`);
    assert.equal(approvals.c, 1, `trial ${trial}: exactly one approval audit row`);
    assert.equal(statusRow.status, 'published');
    assert.equal(chain.ok, true, `trial ${trial}: audit chain coherent`);

    await checkDb.close();
    await db.close();
    await withAdmin(PG_URL, 'c6spike', (admin) => admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    rmSync(barrierPath, { force: true });
  }

  telemetry.total = telemetry.serialization + telemetry.deadlock + telemetry.uniqueViolation + telemetry.auditConflict;
  process.stdout.write(`V11 race [${strategy}] outcomes across ${TRIALS} trials: ${JSON.stringify(outcomes)}\n`);
  process.stdout.write(`V11 race [${strategy}] telemetry: ${JSON.stringify(telemetry)}\n`);
  return telemetry;
}

test('V11-3 repeated multi-process race, for-update strategy (20 trials)', { ...PG_ONLY, timeout: 600_000 }, async () => {
  const telemetry = await runHardenedRace('for-update');
  // Row locking prevents the conflict outright: no SQLSTATE retry was ever
  // needed and no bounded retry was ever exhausted across all 20 trials.
  assert.equal(telemetry.total, 0, `for-update: zero SQLSTATE retries, got ${JSON.stringify(telemetry)}`);
  assert.equal(telemetry.mappedTo409, 0, 'for-update: zero exhausted retries');
});

test('V11-4 repeated multi-process race, serializable strategy (20 trials)', { ...PG_ONLY, timeout: 600_000 }, async () => {
  await runHardenedRace('serializable');
  // Retry counts are recorded as telemetry (a loser may also observe the
  // winner's committed row directly and answer 409 without an abort), but the
  // OUTCOME invariant [201,409] is asserted strictly inside every trial, and
  // an exhausted retry maps to 409 — never to a 500.
});

// ---------------------------------------------------------------------------
// H5 — contract + negative behavior through the hardened server
// ---------------------------------------------------------------------------
test('V11-5 contract and negative behavior (both strategies)', PG_ONLY, async (t) => {
  assert.ok(PG_URL, 'C6_ENGINE=postgres requires C6_PG_URL');
  for (const strategy of STRATEGIES) {
    await t.test(strategy, async (tt) => {
      const h = await harness();
      await ensureHardenedDdl(h.db);
      await seedStandardPrincipals(h.db);
      await seedPrincipal(h.db, 'p_contrib_c', 'Synthetic Cora', []);
      await seedPrincipal(h.db, 'p_contrib_d', 'Synthetic Dev', []);
      const db2 = await siblingHandle(await currentSchemaOf(h.db));
      const hs = createHardenedServer({ db: h.db, now: h.now, strategy });
      const hs2 = createHardenedServer({ db: db2, now: h.now, strategy });
      const decide = (srv, sid, subId, body) =>
        srv.handle({
          method: 'POST',
          path: `/v1/admin/submissions/${subId}/decisions`,
          session: sid,
          body: { schemaVersion: 1, ...body },
        });
      // Rotate creators: the daily submission quota is 5 per principal and all
      // subtests share one harness.
      const creators = ['p_contrib_a', 'p_contrib_b', 'p_contrib_c', 'p_contrib_d'];
      let mkCount = 0;
      const mkSub = async () => {
        const c = await h.signIn(creators[mkCount % creators.length]);
        mkCount += 1;
        const r = await h.req({
          method: 'POST',
          path: '/v1/submissions',
          session: c,
          body: { schemaVersion: 1, payload: validPayload() },
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return r.body.submissionId;
      };
      const mod1 = await h.signIn('p_mod_1');
      const mod2 = await h.signIn('p_mod_2');

      await tt.test('single approve → 201 (happy path intact)', async () => {
        const subId = await mkSub();
        const r = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4001),
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.status, 'published');
        assert.ok(r.body.publishedRevisionId && r.body.entityUuid);
        assert.equal((await verifyChain(h.db)).ok, true);
      });

      await tt.test('sequential same-key duplicate → stored replay verbatim', async () => {
        const subId = await mkSub();
        const body = { decision: 'approve', expectedRevision: 1, idempotencyKey: key(4002) };
        const first = await decide(hs, mod1, subId, body);
        assert.equal(first.status, 201);
        const second = await decide(hs, mod1, subId, body);
        assert.equal(second.status, 201);
        // Faithful replay semantics (v5-idempotency uses the same stripId
        // comparison): identical payload, requestId is per-response.
        const stripId = ({ requestId, ...rest }) => rest;
        assert.deepEqual(stripId(second.body), stripId(first.body), 'replay serves the stored response');
        const rows = await h.db.get('SELECT COUNT(*) AS c FROM idempotency WHERE key = ?', [key(4002)]);
        assert.equal(rows.c, 1);
        const approvals = await h.db.get(
          "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve' AND subject = ?",
          [`submission:${subId}`]
        );
        assert.equal(approvals.c, 1, 'replay did not execute a second decision');
      });

      await tt.test('reject → 201 rejected (full decision vocabulary)', async () => {
        const subId = await mkSub();
        const r = await decide(hs, mod2, subId, {
          decision: 'reject',
          expectedRevision: 1,
          idempotencyKey: key(4003),
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.status, 'rejected');
      });

      await tt.test('unauthenticated session → 401', async () => {
        const subId = await mkSub();
        const r = await decide(hs, 'sid_does_not_exist', subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4004),
        });
        assert.equal(r.status, 401);
        assert.equal(r.body.error.code, 'unauthenticated');
      });

      await tt.test('moderator deciding own submission → 403 actor≠author', async () => {
        const modSid = await h.signIn('p_mod_1');
        const created = await h.req({
          method: 'POST',
          path: '/v1/submissions',
          session: modSid,
          body: { schemaVersion: 1, payload: validPayload() },
        });
        assert.equal(created.status, 201);
        const r = await decide(hs, modSid, created.body.submissionId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4005),
        });
        assert.equal(r.status, 403);
        assert.match(r.body.error.message, /actor≠author/);
      });

      await tt.test('stale expectedRevision → 409 with current state', async () => {
        const subId = await mkSub();
        const r = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 0,
          idempotencyKey: key(4006),
        });
        assert.equal(r.status, 409);
        assert.equal(r.body.error.code, 'conflict');
        assert.equal(r.body.error.details.currentRevision, 1);
        assert.equal(r.body.error.details.currentStatus, 'submitted');
      });

      await tt.test('non-decidable (already published) → 409', async () => {
        const subId = await mkSub();
        const first = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4007),
        });
        assert.equal(first.status, 201);
        const again = await decide(hs, mod2, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4008),
        });
        assert.equal(again.status, 409);
        assert.equal(again.body.error.details.currentStatus, 'published');
      });

      await tt.test('validation failures → 400 (missing key, bad decision, unknown field)', async () => {
        const subId = await mkSub();
        const noKey = await decide(hs, mod1, subId, { decision: 'approve', expectedRevision: 1 });
        assert.equal(noKey.status, 400);
        const badDecision = await decide(hs, mod1, subId, {
          decision: 'rubber_stamp',
          expectedRevision: 1,
          idempotencyKey: key(4009),
        });
        assert.equal(badDecision.status, 400);
        const unknownField = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4010),
          bogusField: true,
        });
        assert.equal(unknownField.status, 400);
        assert.match(JSON.stringify(unknownField.body), /unknown field rejected/);
        const badRevision = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 'one',
          idempotencyKey: key(4011),
        });
        assert.equal(badRevision.status, 400);
      });

      await tt.test('concurrent same-key duplicate → [201,409], one decision, one stored row', async () => {
        const subId = await mkSub();
        const body = { decision: 'approve', expectedRevision: 1, idempotencyKey: key(4012) };
        const [ra, rb] = await Promise.all([
          decide(hs, mod1, subId, body),
          decide(hs2, mod1, subId, body),
        ]);
        // Known design observation (documented): a CONCURRENT duplicate on the
        // decision endpoint answers [201,409] (the decision is exactly-once);
        // the stored replay serves SEQUENTIAL duplicates (test 2 above).
        assert.deepEqual(
          [ra.status, rb.status].sort((x, y) => x - y),
          [201, 409],
          JSON.stringify([ra.body, rb.body])
        );
        const rows = await h.db.get('SELECT COUNT(*) AS c FROM idempotency WHERE key = ?', [key(4012)]);
        assert.equal(rows.c, 1, 'exactly one stored idempotency row');
        const approvals = await h.db.get(
          "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve' AND subject = ?",
          [`submission:${subId}`]
        );
        assert.equal(approvals.c, 1, 'exactly one decision executed');
      });

      await tt.test('kill switch on → 503; off → 201 (fail-closed intake)', async () => {
        const subId = await mkSub();
        await h.db.run("UPDATE config SET value = 'on' WHERE key = 'kill_switch'", []);
        const blocked = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4013),
        });
        assert.equal(blocked.status, 503);
        assert.equal(blocked.body.error.code, 'service_unavailable');
        await h.db.run("UPDATE config SET value = 'off' WHERE key = 'kill_switch'", []);
        const allowed = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4014),
        });
        assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
      });

      await tt.test('fault injection → 500 with full rollback, then clean retry → 201', async () => {
        const subId = await mkSub();
        hs.injectFault('before_publish_row');
        const faulted = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4015),
        });
        assert.equal(faulted.status, 500);
        assert.equal(faulted.body.error.code, 'internal');
        const residue = {
          rev: await h.db.get('SELECT COUNT(*) AS c FROM published_revisions WHERE submission_id = ?', [subId]),
          review: await h.db.get('SELECT COUNT(*) AS c FROM review_events WHERE submission_id = ?', [subId]),
          audit: await h.db.get("SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve' AND subject = ?", [`submission:${subId}`]),
          st: await h.db.get('SELECT status FROM submissions WHERE id = ?', [subId]),
        };
        assert.equal(residue.rev.c, 0, 'no published revision residue');
        assert.equal(residue.review.c, 0, 'no review event residue');
        assert.equal(residue.audit.c, 0, 'no audit residue');
        assert.equal(residue.st.status, 'submitted', 'status unchanged (atomic rollback)');
        assert.equal((await verifyChain(h.db)).ok, true);
        const retry = await decide(hs, mod1, subId, {
          decision: 'approve',
          expectedRevision: 1,
          idempotencyKey: key(4015),
        });
        assert.equal(retry.status, 201, JSON.stringify(retry.body));
        const entAfter = await h.db.get('SELECT COUNT(*) AS c FROM published_entities', []);
        assert.ok(entAfter.c >= 1, 'retry published cleanly');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// H6 — F3 deterministic idempotency store race
// ---------------------------------------------------------------------------
test('V11-6 F3: concurrent idempotency store race — 23505 serves the stored replay', PG_ONLY, async () => {
  assert.ok(PG_URL, 'C6_ENGINE=postgres requires C6_PG_URL');
  const h = await harness();
  await seedStandardPrincipals(h.db);
  const db2 = await siblingHandle(await currentSchemaOf(h.db));

  const method = 'POST';
  const path = '/v1/submissions';
  const k = key(9901);
  const body = { schemaVersion: 1, payload: validPayload() };
  // As in route(): `response` is the response BODY (status travels separately).
  const responseBody = { submissionId: 'sub_x', requestId: 'req_000001' };

  // A: uncommitted winning insert (explicit transaction).
  await h.db.exec('BEGIN');
  const rA = await hardenedStoreIdempotency(h.db, {
    principalId: 'p_contrib_a',
    key: k,
    method,
    path,
    body,
    status: 201,
    response: responseBody,
    ts: T0,
  });
  assert.deepEqual(rA, { stored: true });

  // B: concurrent duplicate — its INSERT blocks on A's transaction lock and
  // resolves to 23505 after A commits (deterministic, no wall-clock race).
  const pB = hardenedStoreIdempotency(db2, {
    principalId: 'p_contrib_a',
    key: k,
    method,
    path,
    body,
    status: 201,
    response: { submissionId: 'loser', requestId: 'req_000002' },
    ts: T0,
  });
  await h.db.exec('COMMIT');
  const rB = await pB;

  assert.ok(rB.replay, 'F3: the loser serves the stored replay instead of 23505 → HTTP 500');
  assert.deepEqual(rB.replay.body, responseBody, 'replay equals the winner’s stored response');
  const rows = await h.db.get('SELECT COUNT(*) AS c FROM idempotency WHERE principal_id = ? AND key = ?', [
    'p_contrib_a',
    k,
  ]);
  assert.equal(rows.c, 1, 'exactly one idempotency row');

  // Negative: same key + different body → the faithful 422 contract envelope.
  await assert.rejects(
    () =>
      hardenedStoreIdempotency(db2, {
        principalId: 'p_contrib_a',
        key: k,
        method,
        path,
        body: { schemaVersion: 1, payload: validPayload() },
        status: 201,
        response: responseBody,
        ts: T0,
      }),
    (e) => e instanceof Error && e.status === 422 && e.code === 'idempotency_mismatch'
  );
});

// ---------------------------------------------------------------------------
// H7 — F4 audit integrity at scale
// ---------------------------------------------------------------------------
test('V11-7 F4: audit integrity at scale — 20 concurrent decisions (both strategies)', { ...PG_ONLY, timeout: 300_000 }, async (t) => {
  assert.ok(PG_URL, 'C6_ENGINE=postgres requires C6_PG_URL');
  for (const strategy of STRATEGIES) {
    await t.test(strategy, async () => {
      const h = await harness();
      await ensureHardenedDdl(h.db);
      await seedStandardPrincipals(h.db);
      await seedPrincipal(h.db, 'p_contrib_c', 'Synthetic Cora', []);
      await seedPrincipal(h.db, 'p_contrib_d', 'Synthetic Dev', []);
      const schema = await currentSchemaOf(h.db);

      // 20 submissions — 5 per contributor (daily quota limit is 5).
      const subs = [];
      for (const pid of ['p_contrib_a', 'p_contrib_b', 'p_contrib_c', 'p_contrib_d']) {
        const sid = await h.signIn(pid);
        for (let i = 0; i < 5; i += 1) {
          const r = await h.req({
            method: 'POST',
            path: '/v1/submissions',
            session: sid,
            body: { schemaVersion: 1, payload: validPayload() },
          });
          assert.equal(r.status, 201, JSON.stringify(r.body));
          subs.push(r.body.submissionId);
        }
      }
      const modSid = await h.signIn('p_mod_1');

      // True 20-way concurrency: 20 connections, one hardened server each.
      const handles = [h.db];
      for (let i = 1; i < 20; i += 1) handles.push(await siblingHandle(schema));
      const servers = handles.map((d) =>
        createHardenedServer({
          db: d,
          now: h.now,
          strategy,
          // Serializable + faithful read-last-seq needs enough bounded
          // attempts for 20-way audit-head contention (the cost difference IS
          // the comparison evidence; for-update queues without any retry).
          ...(strategy === 'serializable' ? { maxAttempts: 64 } : {})
        })
      );

      const results = await Promise.all(
        subs.map((subId, i) =>
          servers[i].handle({
            method: 'POST',
            path: `/v1/admin/submissions/${subId}/decisions`,
            session: modSid,
            body: {
              schemaVersion: 1,
              decision: 'approve',
              expectedRevision: 1,
              idempotencyKey: key(5000 + i),
            },
          })
        )
      );
      const statuses = results.map((r) => r.status);
      assert.ok(
        statuses.every((s) => s === 201),
        `all 20 decisions must commit: ${JSON.stringify(statuses.map((s, i) => [s, statuses[i] === 201 ? '' : JSON.stringify(results[i].body)]))}`
      );

      const seqs = (await h.db.all('SELECT seq FROM audit_events ORDER BY seq ASC', [])).map((r) =>
        Number(r.seq)
      );
      // The FULL audit table (submission.created / session.created rows from
      // setup + the 20 decision rows) must be strictly consecutive — any
      // collision (F4) would have broken the chain or failed an insert.
      assert.deepEqual(
        seqs,
        Array.from({ length: seqs.length }, (_, i) => i + 1),
        'audit seqs strictly consecutive — no gaps, no collisions (F4)'
      );
      const decisionSeqs = (
        await h.db.all("SELECT seq FROM audit_events WHERE action = 'decision.approve' ORDER BY seq ASC", [])
      ).map((r) => Number(r.seq));
      assert.equal(decisionSeqs.length, 20, '20 approval audit rows');
      assert.equal(new Set(decisionSeqs).size, 20, 'every decision got its own distinct seq');
      const rev = await h.db.get('SELECT COUNT(*) AS c FROM review_events', []);
      assert.equal(rev.c, 20);
      const appr = await h.db.get(
        "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve'",
        []
      );
      assert.equal(appr.c, 20);
      const chain = await verifyChain(h.db);
      assert.equal(chain.ok, true, 'audit chain coherent at scale');
      // verifyChain walks EVERY row (setup session/submission audits + the 20
      // decisions) — count must match the full consecutive table.
      assert.equal(chain.count, seqs.length);

      const retries = sumRetries(servers);
      process.stdout.write(`V11-7 [${strategy}] telemetry: ${JSON.stringify(retries)}\n`);
      if (strategy === 'for-update') {
        assert.equal(retries.total, 0, 'for-update: zero SQLSTATE retries at scale');
        assert.equal(retries.mappedTo409, 0);
      }
      // serializable: retries are the honest cost — asserted indirectly through
      // all-201 + consecutive seqs; totals recorded as telemetry evidence.
      for (const d of handles.slice(1)) {
        try {
          await d.close();
        } catch {
          /* already closed */
        }
      }
    });
  }
});
