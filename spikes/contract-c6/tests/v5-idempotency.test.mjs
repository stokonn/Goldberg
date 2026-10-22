// V5 — Idempotency engine (API-CONTRACTS.md §1, DATA-MODEL.md §4;
// THREAT-MODEL rows T11 replay-without-second-effect, T12 mismatch).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload, key } from './helpers.mjs';

function setup() {
  const h = harness();
  seedStandardPrincipals(h.db);
  const ownerSid = h.signIn('p_contrib_a');
  const modSid = h.signIn('p_mod_1');
  return { h, ownerSid, modSid };
}

const submit = (h, sid, payload, idempotencyKey) =>
  h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 1, payload, idempotencyKey },
  });

const stripId = (body) => {
  const { requestId, ...rest } = body;
  return rest;
};

test('V5.1 replay: same key + identical body → original result, no second effect', () => {
  const { h, ownerSid } = setup();
  const p = validPayload();
  const first = submit(h, ownerSid, p, key(30));
  assert.equal(first.status, 201);
  const replay = submit(h, ownerSid, p, key(30));
  assert.equal(replay.status, 201);
  assert.deepEqual(stripId(replay.body), stripId(first.body));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM idempotency').get().c, 1);
});

test('V5.2 same key + different body → 422 idempotency_mismatch, no effect', () => {
  const { h, ownerSid } = setup();
  const first = submit(h, ownerSid, validPayload({ contributorNote: 'one' }), key(31));
  assert.equal(first.status, 201);
  const before = h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
  const clash = submit(h, ownerSid, validPayload({ contributorNote: 'two' }), key(31));
  assert.equal(clash.status, 422);
  assert.equal(clash.body.error.code, 'idempotency_mismatch');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, before);
});

test('V5.3 decision replay: one publication, loser-conflict NOT created', () => {
  const { h, ownerSid, modSid } = setup();
  const payload = validPayload();
  const created = submit(h, ownerSid, payload, key(32));
  const decisionBody = {
    schemaVersion: 1,
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(33),
  };
  const first = h.req({
    method: 'POST',
    path: `/v1/admin/submissions/${created.body.submissionId}/decisions`,
    session: modSid,
    body: decisionBody,
  });
  assert.equal(first.status, 201);
  const replay = h.req({
    method: 'POST',
    path: `/v1/admin/submissions/${created.body.submissionId}/decisions`,
    session: modSid,
    body: decisionBody,
  });
  assert.equal(replay.status, 201);
  assert.deepEqual(stripId(replay.body), stripId(first.body));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM published_revisions').get().c, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM review_events').get().c, 1);
  // same decision key with a different decision body → 422, no state change
  const clash = h.req({
    method: 'POST',
    path: `/v1/admin/submissions/${created.body.submissionId}/decisions`,
    session: modSid,
    body: { schemaVersion: 1, decision: 'reject', expectedRevision: 1, idempotencyKey: key(33) },
  });
  assert.equal(clash.status, 422);
  assert.equal(h.db.prepare('SELECT status FROM submissions').get().status, 'published');
});

test('V5.4 keys are scoped per principal (same key text, different principals)', () => {
  const { h, ownerSid } = setup();
  seedStandardPrincipalsSecond(h);
  const otherSid = h.signIn('p_contrib_b');
  const a = submit(h, ownerSid, validPayload(), key(34));
  const b = submit(h, otherSid, validPayload(), key(34));
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.body.submissionId, b.body.submissionId);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 2);
});

function seedStandardPrincipalsSecond(h) {
  // p_contrib_b is seeded by seedStandardPrincipals; guard against double-call
  const row = h.db.prepare('SELECT id FROM principals WHERE id = ?').get('p_contrib_b');
  if (!row) throw new Error('p_contrib_b missing — seed standard principals first');
}

test('V5.5 expiry: key is ignored after ≥24 h (fake clock) → request executes fresh', () => {
  const { h, ownerSid } = setup();
  const p = validPayload();
  const first = submit(h, ownerSid, p, key(35));
  assert.equal(first.status, 201);
  // still replayable just before 24 h (fresh sign-in: sessions last 1h, so
  // the fake clock jump expires the session — that is V2.3's behavior)
  h.advance(24 * 60 * 60 * 1000 - 1000);
  const sidLater = h.signIn('p_contrib_a');
  const stillReplay = submit(h, sidLater, p, key(35));
  assert.equal(stillReplay.status, 201);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 1);
  // expired: >24 h later the key is unknown → executes fresh (documented semantics)
  h.advance(2000);
  const sidExpired = h.signIn('p_contrib_a');
  const fresh = submit(h, sidExpired, p, key(35));
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.body.submissionId, first.body.submissionId);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 2);
});

test('V5.6 failed requests do not consume the key (retry is possible)', () => {
  const { h, ownerSid } = setup();
  const p = validPayload();
  p.smuggled = 'bad'; // → 400 validation_failed
  const fail = submit(h, ownerSid, p, key(36));
  assert.equal(fail.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM idempotency').get().c, 0);
  const good = submit(h, ownerSid, validPayload(), key(36));
  assert.equal(good.status, 201, 'same key becomes usable after the failing attempt');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 1);
});

test('V5.7 quota rejection does not consume the key either', () => {
  const { h, ownerSid } = setup();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(submit(h, ownerSid, validPayload()).status, 201);
  }
  const blocked = submit(h, ownerSid, validPayload(), key(37));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'rate_limited');
  assert.equal(blocked.body.error.details.retryAfter, 3600);
  const keyRows = h.db
    .prepare('SELECT COUNT(*) AS c FROM idempotency WHERE key = ?')
    .get(key(37)).c;
  assert.equal(keyRows, 0);
  // nothing was deleted by the quota path
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 5);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c >= 6, true);
});
