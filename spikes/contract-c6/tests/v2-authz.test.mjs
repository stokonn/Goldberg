// V2 — Authentication, roles and permission denial (API-CONTRACTS.md §3/§6,
// AUTH.md §6 semantics; THREAT-MODEL rows T5 live revocation/suspension,
// T22 bootstrap abuse). Token cryptography was verified in C2 S1–S19 and is
// not re-tested here — fake sessions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload, key } from './helpers.mjs';

function setup() {
  const h = harness();
  seedStandardPrincipals(h.db);
  return { h };
}

const write = (h, sid, path, body) =>
  h.req({ method: 'POST', path, session: sid, body: { schemaVersion: 1, ...body } });
const read = (h, sid, path) => h.req({ method: 'GET', path, session: sid, query: {} });

test('V2.1 missing session on a protected route → 401 unauthenticated', () => {
  const { h } = setup();
  const r = h.req({ method: 'POST', path: '/v1/submissions', body: { schemaVersion: 1 } });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'unauthenticated');
  const g = h.req({ method: 'GET', path: '/v1/admin/queue', query: {} });
  assert.equal(g.status, 401);
});

test('V2.2 garbage session token → 401', () => {
  const { h } = setup();
  const r = read(h, 'sess_garbage_not_a_session', '/v1/submissions/mine');
  assert.equal(r.status, 401);
});

test('V2.3 expired session (fake clock) → 401, session row removed', () => {
  const { h } = setup();
  const sid = h.signIn('p_contrib_a');
  assert.equal(read(h, sid, '/v1/submissions/mine').status, 200);
  h.advance(60 * 60 * 1000 + 1); // > SESSION_TTL
  const r = read(h, sid, '/v1/submissions/mine');
  assert.equal(r.status, 401);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE sid = ?').get(sid).c, 0);
});

test('V2.4 revoked session (DELETE /v1/session) → subsequent request 401', () => {
  const { h } = setup();
  const sid = h.signIn('p_contrib_a');
  const del = h.req({ method: 'DELETE', path: '/v1/session', session: sid, body: {} });
  assert.equal(del.status, 200);
  assert.equal(read(h, sid, '/v1/submissions/mine').status, 401);
  // contract: revocation is idempotent — repeating it is not an error state
  const delAgain = h.req({ method: 'DELETE', path: '/v1/session', session: sid, body: {} });
  assert.equal(delAgain.status, 200);
  assert.equal(delAgain.body.revoked, true);
});

test('V2.5 contributor → admin queue: 403 forbidden (default-deny), not 401', () => {
  const { h } = setup();
  const sid = h.signIn('p_contrib_a');
  const r = read(h, sid, '/v1/admin/queue');
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden');
});

test('V2.6 contributor → decisions endpoint: 403 (capability missing)', () => {
  const { h } = setup();
  const sid = h.signIn('p_contrib_a');
  const r = write(h, sid, '/v1/admin/submissions/sub_000001/decisions', {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(1),
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden');
});

test('V2.7 moderator → roles.manage and audit.read: 403', () => {
  const { h } = setup();
  const mod = h.signIn('p_mod_1');
  const roles = write(h, mod, '/v1/admin/principals/p_contrib_a/roles', {
    action: 'grant',
    role: 'moderator',
  });
  assert.equal(roles.status, 403);
  const audit = read(h, mod, '/v1/admin/audit');
  assert.equal(audit.status, 403);
});

test('V2.8 actor≠author: moderator deciding on own submission → 403', () => {
  const { h } = setup();
  // A moderator can also submit (submit is a base capability).
  const modSid = h.signIn('p_mod_1');
  const created = write(h, modSid, '/v1/submissions', { payload: validPayload() });
  assert.equal(created.status, 201);
  const r = write(h, modSid, `/v1/admin/submissions/${created.body.submissionId}/decisions`, {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(2),
  });
  assert.equal(r.status, 403);
  const row = h.db.prepare('SELECT status FROM submissions WHERE id = ?').get(created.body.submissionId);
  assert.equal(row.status, 'submitted');
});

test('V2.9 suspended principal → 403 at next request while session still valid', () => {
  const { h } = setup();
  const victimSid = h.signIn('p_contrib_a');
  const adminSid = h.signIn('p_admin_1');
  assert.equal(read(h, victimSid, '/v1/submissions/mine').status, 200);
  const susp = write(h, adminSid, '/v1/admin/principals/p_contrib_a/suspend', { suspended: true });
  assert.equal(susp.status, 200);
  const r = read(h, victimSid, '/v1/submissions/mine');
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /suspended/);
  // suspended principal cannot mint a fresh session either
  const newSession = h.req({
    method: 'POST',
    path: '/v1/session',
    body: { schemaVersion: 1, credential: 'synthetic:p_contrib_a' },
  });
  assert.equal(newSession.status, 403);
});

test('V2.10 live role revocation: moderator loses decide at next request (no expiry wait)', () => {
  const { h } = setup();
  const adminSid = h.signIn('p_admin_1');
  const modSid = h.signIn('p_mod_1');
  const contribSid = h.signIn('p_contrib_a');
  const created = write(h, contribSid, '/v1/submissions', { payload: validPayload() });
  const target = `/v1/admin/submissions/${created.body.submissionId}/decisions`;
  const before = write(h, modSid, target, {
    decision: 'request_changes',
    expectedRevision: 1,
    idempotencyKey: key(3),
  });
  assert.equal(before.status, 201);
  const revoke = write(h, adminSid, '/v1/admin/principals/p_mod_1/roles', {
    action: 'revoke',
    role: 'moderator',
  });
  assert.equal(revoke.status, 200);
  const after = write(h, modSid, target, {
    decision: 'approve',
    expectedRevision: 2,
    idempotencyKey: key(4),
  });
  assert.equal(after.status, 403);
});

test('V2.11 GET /v1/me/capabilities reflects server-computed list only', () => {
  const { h } = setup();
  const mod = h.signIn('p_mod_1');
  const caps = read(h, mod, '/v1/me/capabilities');
  assert.equal(caps.status, 200);
  assert.deepEqual(caps.body.capabilities, ['decide', 'queue.read', 'submit']);
  const anon = h.req({ method: 'GET', path: '/v1/me/capabilities', query: {} });
  assert.equal(anon.status, 401);
});

test('V2.12 unknown synthetic credential → 401 (fake Google verification)', () => {
  const { h } = setup();
  const r = h.req({
    method: 'POST',
    path: '/v1/session',
    body: { schemaVersion: 1, credential: 'synthetic:p_does_not_exist' },
  });
  assert.equal(r.status, 401);
  const malformed = h.req({
    method: 'POST',
    path: '/v1/session',
    body: { schemaVersion: 1, credential: 'stolen-real-token-shape' },
  });
  assert.equal(malformed.status, 400);
});

test('V2.13 T22 bootstrap abuse: anonymous self-grant → 401; admin self-grant → 403; audit self-edit → no endpoint', () => {
  const { h } = setup();
  const anonymous = h.req({
    method: 'POST',
    path: '/v1/admin/principals/p_contrib_a/roles',
    body: { schemaVersion: 1, action: 'grant', role: 'admin' },
  });
  assert.equal(anonymous.status, 401);

  const adminSid = h.signIn('p_admin_1');
  const selfGrant = write(h, adminSid, '/v1/admin/principals/p_admin_1/roles', {
    action: 'grant',
    role: 'admin',
  });
  assert.equal(selfGrant.status, 403);
  const selfRevoke = write(h, adminSid, '/v1/admin/principals/p_admin_1/roles', {
    action: 'revoke',
    role: 'admin',
  });
  assert.equal(selfRevoke.status, 403);

  // no client route exists that mutates the audit log
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const r = h.req({
      method,
      path: '/v1/admin/audit',
      session: adminSid,
      body: { schemaVersion: 1 },
    });
    assert.equal(r.status, 404, `${method} /v1/admin/audit must not exist`);
    assert.equal(r.body.error.code, 'not_found');
  }
  const routes = h.server.listRoutes();
  assert.equal(routes.filter((r) => r.includes('audit') && !r.startsWith('GET ')).length, 0);
  assert.equal(
    routes.filter((r) => r.startsWith('DELETE')).length,
    1,
    'the only DELETE route is the session revocation'
  );
  assert.ok(
    routes.some((r) => r.startsWith('DELETE') && r.includes('\\/v1\\/session')),
    'DELETE /v1/session exists'
  );
  assert.ok(
    !routes.some((r) => r.includes('\\/v1\\/me$')),
    'DELETE /v1/me stays unimplemented (D5d)'
  );
});

test('V2.14 quota/role interplay: suspension does not delete anything (state preserved)', () => {
  const { h } = setup();
  const contribSid = h.signIn('p_contrib_a');
  write(h, contribSid, '/v1/submissions', { payload: validPayload() });
  const adminSid = h.signIn('p_admin_1');
  write(h, adminSid, '/v1/admin/principals/p_contrib_a/suspend', { suspended: true });
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM audit_events').get().c >= 3, true);
});
