// V8 — Audit chain integrity (DATA-MODEL.md §6; THREAT-MODEL row T18 local
// portion: append-only via API + tamper evidence on a copy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness, seedStandardPrincipals, validPayload, key } from './helpers.mjs';
import { verifyChain } from '../src/server.mjs';

function setup() {
  const h = harness();
  seedStandardPrincipals(h.db);
  const ownerSid = h.signIn('p_contrib_a');
  const modSid = h.signIn('p_mod_1');
  const adminSid = h.signIn('p_admin_1');
  return { h, ownerSid, modSid, adminSid };
}

test('V8.1 chain verifies after a full lifecycle sequence', () => {
  const { h, ownerSid, modSid, adminSid } = setup();
  // session.created ×2 + submission.created + decision + role change + suspend
  const created = h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  const decided = h.req({
    method: 'POST',
    path: `/v1/admin/submissions/${created.body.submissionId}/decisions`,
    session: modSid,
    body: {
      schemaVersion: 1,
      decision: 'approve',
      expectedRevision: 1,
      idempotencyKey: key(50),
    },
  });
  assert.equal(decided.status, 201);
  h.req({
    method: 'POST',
    path: '/v1/admin/principals/p_contrib_b/roles',
    session: adminSid,
    body: { schemaVersion: 1, action: 'grant', role: 'moderator' },
  });
  h.req({
    method: 'POST',
    path: '/v1/admin/principals/p_contrib_b/suspend',
    session: adminSid,
    body: { schemaVersion: 1, suspended: true },
  });

  // 3 session.created + submission + decision + role.grant + suspend
  const actual = h.db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c;
  assert.equal(actual, 7, 'one audit row per transition, in order');
  assert.equal(verifyChain(h.db).ok, true);
  assert.equal(verifyChain(h.db).count, 7);
});

test('V8.2 tampering with a copied chain row is detected loudly (specific seq)', () => {
  const { h, ownerSid, adminSid } = setup();
  h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(verifyChain(h.db).ok, true);
  // simulate an operator console edit on the audit copy (documented trust boundary)
  h.db
    .prepare("UPDATE audit_events SET action = 'decision.approve' WHERE seq = 3")
    .run();
  const result = verifyChain(h.db);
  assert.equal(result.ok, false);
  assert.equal(result.atSeq, 3, 'reports the exact broken link');
});

test('V8.3 deletion of a chain row is detected (prev_hash discontinuity)', () => {
  const { h, ownerSid } = setup();
  h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  const count = h.db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c;
  assert.ok(count >= 2);
  h.db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
  const result = verifyChain(h.db);
  assert.equal(result.ok, false);
});

test('V8.4 no API route can mutate or delete audit rows (append-only surface)', () => {
  const { h, adminSid } = setup();
  const routes = h.server.listRoutes();
  const auditMutation = routes.filter(
    (r) => r.includes('audit') && (r.startsWith('POST') || r.startsWith('PATCH') || r.startsWith('DELETE') || r.startsWith('PUT'))
  );
  assert.equal(auditMutation.length, 0);
  for (const path of ['/v1/admin/audit', '/v1/admin/audit/1', '/v1/audit']) {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const r = h.req({ method, path, session: adminSid, body: { schemaVersion: 1 } });
      assert.equal(r.status, 404, `${method} ${path} must not exist`);
    }
  }
});

test('V8.5 GET /v1/admin/audit exposes prev/this hashes and a chain head (admin only)', () => {
  const { h, ownerSid, modSid, adminSid } = setup();
  h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(
    h.req({ method: 'GET', path: '/v1/admin/audit', session: modSid, query: {} }).status,
    403
  );
  const audit = h.req({ method: 'GET', path: '/v1/admin/audit', session: adminSid, query: {} });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.chainHead);
  assert.equal(audit.body.items[0].prevHash, 'GENESIS');
  for (const item of audit.body.items) {
    assert.match(item.thisHash, /^[0-9a-f]{64}$/);
    if (item.seq === 1) {
      assert.equal(item.prevHash, 'GENESIS', 'first link anchors the chain');
    } else {
      assert.match(item.prevHash, /^[0-9a-f]{64}$/);
    }
  }
  // independent recomputation of the first link
  const first = audit.body.items[0];
  const seq = first.seq;
  const row = h.db
    .prepare('SELECT seq, ts, actor_id, action, subject, payload_hash FROM audit_events WHERE seq = ?')
    .get(seq);
  const recomputed = createHash('sha256')
    .update(`${row.seq}|${row.ts}|${row.actor_id}|${row.action}|${row.subject}|${row.payload_hash}|GENESIS`)
    .digest('hex');
  assert.equal(first.thisHash, recomputed);
});

test('V8.6 audit and data tables are separate: tamper test above cannot be triggered via submission routes', () => {
  const { h, ownerSid } = setup();
  const created = h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  const before = h.db.prepare('SELECT this_hash FROM audit_events ORDER BY seq DESC LIMIT 1').get().this_hash;
  // mutating a submission payload cannot rewrite history
  h.req({
    method: 'POST',
    path: `/v1/submissions/${created.body.submissionId}/withdraw`,
    session: ownerSid,
    body: { schemaVersion: 1 },
  });
  const after = h.db.prepare('SELECT this_hash FROM audit_events ORDER BY seq DESC LIMIT 1').get().this_hash;
  assert.notEqual(before, after, 'new append happened');
  assert.equal(verifyChain(h.db).ok, true, 'and the chain still verifies');
});
