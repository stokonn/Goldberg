// V8 — Audit chain integrity (DATA-MODEL.md §6; THREAT-MODEL row T18 local
// portion: append-only via API + tamper evidence on a copy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness, seedStandardPrincipals, validPayload, key } from './helpers.mjs';
import { verifyChain } from '../src/server.mjs';

async function setup() {
  const h = await harness();
  await seedStandardPrincipals(h.db);
  const ownerSid = await h.signIn('p_contrib_a');
  const modSid = await h.signIn('p_mod_1');
  const adminSid = await h.signIn('p_admin_1');
  return { h, ownerSid, modSid, adminSid };
}

test('V8.1 chain verifies after a full lifecycle sequence', async () => {
  const { h, ownerSid, modSid, adminSid } = await setup();
  // session.created ×2 + submission.created + decision + role change + suspend
  const created = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  const decided = await h.req({
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
  await h.req({
    method: 'POST',
    path: '/v1/admin/principals/p_contrib_b/roles',
    session: adminSid,
    body: { schemaVersion: 1, action: 'grant', role: 'moderator' },
  });
  await h.req({
    method: 'POST',
    path: '/v1/admin/principals/p_contrib_b/suspend',
    session: adminSid,
    body: { schemaVersion: 1, suspended: true },
  });

  // 3 session.created + submission + decision + role.grant + suspend
  const actual = (await h.db.get('SELECT COUNT(*) AS c FROM audit_events', [])).c;
  assert.equal(actual, 7, 'one audit row per transition, in order');
  assert.equal((await verifyChain(h.db)).ok, true);
  assert.equal((await verifyChain(h.db)).count, 7);
});

test('V8.2 tampering with a copied chain row is detected loudly (specific seq)', async () => {
  const { h, ownerSid, adminSid } = await setup();
  await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal((await verifyChain(h.db)).ok, true);
  // simulate an operator console edit on the audit copy (documented trust boundary)
  (await h.db.run("UPDATE audit_events SET action = 'decision.approve' WHERE seq = 3", []));
  const result = await verifyChain(h.db);
  assert.equal(result.ok, false);
  assert.equal(result.atSeq, 3, 'reports the exact broken link');
});

test('V8.3 deletion of a chain row is detected (prev_hash discontinuity)', async () => {
  const { h, ownerSid } = await setup();
  await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  const count = (await h.db.get('SELECT COUNT(*) AS c FROM audit_events', [])).c;
  assert.ok(count >= 2);
  (await h.db.run('DELETE FROM audit_events WHERE seq = 2', []));
  const result = await verifyChain(h.db);
  assert.equal(result.ok, false);
});

test('V8.4 no API route can mutate or delete audit rows (append-only surface)', async () => {
  const { h, adminSid } = await setup();
  const routes = h.server.listRoutes();
  const auditMutation = routes.filter(
    (r) => r.includes('audit') && (r.startsWith('POST') || r.startsWith('PATCH') || r.startsWith('DELETE') || r.startsWith('PUT'))
  );
  assert.equal(auditMutation.length, 0);
  for (const path of ['/v1/admin/audit', '/v1/admin/audit/1', '/v1/audit']) {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const r = await h.req({ method, path, session: adminSid, body: { schemaVersion: 1 } });
      assert.equal(r.status, 404, `${method} ${path} must not exist`);
    }
  }
});

test('V8.5 GET /v1/admin/audit exposes prev/this hashes and a chain head (admin only)', async () => {
  const { h, ownerSid, modSid, adminSid } = await setup();
  await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(
    (await h.req({ method: 'GET', path: '/v1/admin/audit', session: modSid, query: {} })).status,
    403
  );
  const audit = await h.req({ method: 'GET', path: '/v1/admin/audit', session: adminSid, query: {} });
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
  const row = (await h.db.get('SELECT seq, ts, actor_id, action, subject, payload_hash FROM audit_events WHERE seq = ?', [seq]));
  const recomputed = createHash('sha256')
    .update(`${row.seq}|${row.ts}|${row.actor_id}|${row.action}|${row.subject}|${row.payload_hash}|GENESIS`)
    .digest('hex');
  assert.equal(first.thisHash, recomputed);
});

test('V8.6 audit and data tables are separate: tamper test above cannot be triggered via submission routes', async () => {
  const { h, ownerSid } = await setup();
  const created = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  const before = (await h.db.get('SELECT this_hash FROM audit_events ORDER BY seq DESC LIMIT 1', [])).this_hash;
  // mutating a submission payload cannot rewrite history
  await h.req({
    method: 'POST',
    path: `/v1/submissions/${created.body.submissionId}/withdraw`,
    session: ownerSid,
    body: { schemaVersion: 1 },
  });
  const after = (await h.db.get('SELECT this_hash FROM audit_events ORDER BY seq DESC LIMIT 1', [])).this_hash;
  assert.notEqual(before, after, 'new append happened');
  assert.equal((await verifyChain(h.db)).ok, true, 'and the chain still verifies');
});
