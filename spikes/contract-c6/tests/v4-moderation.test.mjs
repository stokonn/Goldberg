// V4 — Moderation decisions, lifecycle state machine and conflict handling
// (API-CONTRACTS.md §6, DATA-MODEL.md §3–§4; THREAT-MODEL rows T10, T17
// ordering prerequisites). True multi-process concurrency is in v9-race.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload, key, uuid } from './helpers.mjs';

async function setup() {
  const h = await harness();
  await seedStandardPrincipals(h.db);
  const ownerSid = await h.signIn('p_contrib_a');
  const modSid = await h.signIn('p_mod_1');
  const mod2Sid = await h.signIn('p_mod_2');
  const adminSid = await h.signIn('p_admin_1');
  const created = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(created.status, 201);
  return { h, ownerSid, modSid, mod2Sid, adminSid, subId: created.body.submissionId };
}

const decide = async (h, sid, subId, body) =>
  await h.req({
    method: 'POST',
    path: `/v1/admin/submissions/${subId}/decisions`,
    session: sid,
    body: { schemaVersion: 1, ...body },
  });

test('V4.1 approve: single atomic transaction publishes (all-or-nothing effects)', async () => {
  const { h, modSid, subId } = await setup();
  const r = await decide(h, modSid, subId, {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(10),
    reason: 'synthetic approval',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'published');
  // all canonical-order effects present, exactly once
  assert.equal((await h.db.get('SELECT status FROM submissions WHERE id = ?', [subId])).status, 'published');
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c, 1);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_entities', [])).c, 1);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM review_events', [])).c, 1);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM change_feed', [])).c, 1);
  // no auto-approval exists: before this decision the overlay was empty (V3.6)
  const overlay = await h.req({ method: 'GET', path: '/v1/catalogue/overlay', query: {} });
  assert.equal(overlay.body.items.length, 1);
  assert.equal(overlay.body.items[0].title.startsWith('Synthetic Work'), true);
});

test('V4.2 reject: terminal state, no publication, events appended', async () => {
  const { h, modSid, subId } = await setup();
  const r = await decide(h, modSid, subId, {
    decision: 'reject',
    expectedRevision: 1,
    idempotencyKey: key(11),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'rejected');
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM review_events', [])).c, 1);
  // rejected is terminal: no further decision
  const again = await decide(h, modSid, subId, {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(12),
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'conflict');
});

test('V4.3 request_changes → immutable revision returns to in_review', async () => {
  const { h, ownerSid, modSid, subId } = await setup();
  const rc = await decide(h, modSid, subId, {
    decision: 'request_changes',
    expectedRevision: 1,
    idempotencyKey: key(13),
    reason: 'add a source URL',
  });
  assert.equal(rc.status, 201);
  assert.equal(rc.body.status, 'changes_requested');
  // old revision stays readable forever
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM revisions WHERE submission_id = ?', [subId])).c, 1);
  // author revises → new immutable revision, back to in_review
  const rev = await h.req({
    method: 'POST',
    path: `/v1/submissions/${subId}/revisions`,
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload({ contributorNote: 'revised' }) },
  });
  assert.equal(rev.status, 201);
  assert.equal(rev.body.revision, 2);
  assert.equal(rev.body.status, 'in_review');
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM revisions WHERE submission_id = ?', [subId])).c, 2);
  const sub = (await h.db.get('SELECT * FROM submissions WHERE id = ?', [subId]));
  assert.equal(sub.revision, 2);
  assert.equal(JSON.parse(sub.payload_json).contributorNote, 'revised');
  // moderator can now approve at the new revision
  const ok = await decide(h, modSid, subId, {
    decision: 'approve',
    expectedRevision: 2,
    idempotencyKey: key(14),
  });
  assert.equal(ok.status, 201);
});

test('V4.4 stale expectedRevision → 409 conflict with current server state, no effect', async () => {
  const { h, ownerSid, modSid, subId } = await setup();
  // Contract flow: revision only exists after request_changes (API-CONTRACTS §4)
  await h.req({
    method: 'POST',
    path: `/v1/admin/submissions/${subId}/decisions`,
    session: modSid,
    body: {
      schemaVersion: 1,
      decision: 'request_changes',
      expectedRevision: 1,
      idempotencyKey: key(15),
    },
  });
  const rev = await h.req({
    method: 'POST',
    path: `/v1/submissions/${subId}/revisions`,
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload({ contributorNote: 'bumped' }) },
  });
  assert.equal(rev.status, 201);
  assert.equal(rev.body.revision, 2);
  const stale = await decide(h, modSid, subId, {
    decision: 'approve',
    expectedRevision: 1, // stale — server is at revision 2
    idempotencyKey: key(151),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'conflict');
  assert.equal(stale.body.error.details.currentRevision, 2);
  assert.equal(stale.body.error.details.currentStatus, 'in_review');
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c, 0);
});

test('V4.5 two moderators, same expectedRevision (sequential interleave): exactly one commits', async () => {
  const { h, modSid, mod2Sid, subId } = await setup();
  const first = await decide(h, modSid, subId, {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(16),
  });
  const second = await decide(h, mod2Sid, subId, {
    decision: 'reject',
    expectedRevision: 1,
    idempotencyKey: key(17),
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.details.currentStatus, 'published');
  // never double-decided, never last-write-wins
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c, 1);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM review_events', [])).c, 1);
  assert.equal((await h.db.get('SELECT status FROM submissions WHERE id = ?', [subId])).status, 'published');
});

test('V4.6 withdrawal pre-approval is terminal; later decision → 409', async () => {
  const { h, ownerSid, modSid, subId } = await setup();
  const w = await h.req({
    method: 'POST',
    path: `/v1/submissions/${subId}/withdraw`,
    session: ownerSid,
    body: { schemaVersion: 1, reason: 'changed my mind' },
  });
  assert.equal(w.status, 200);
  assert.equal(w.body.status, 'withdrawn');
  const d = await decide(h, modSid, subId, {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(18),
  });
  assert.equal(d.status, 409);
  // withdrawal after a decision is not possible either (approval path only)
  const h2 = await setup();
  const decided = await decide(h2.h, h2.modSid, h2.subId, {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(19),
  });
  assert.equal(decided.status, 201);
  const lateWithdraw = await h2.h.req({
    method: 'POST',
    path: `/v1/submissions/${h2.subId}/withdraw`,
    session: h2.ownerSid,
    body: { schemaVersion: 1 },
  });
  assert.equal(lateWithdraw.status, 409);
});

test('V4.7 decision body validation: missing idempotencyKey / bad decision / bad revision → 400', async () => {
  const { h, modSid, subId } = await setup();
  assert.equal((await decide(h, modSid, subId, { decision: 'approve', expectedRevision: 1 })).status, 400);
  assert.equal(
    (await decide(h, modSid, subId, { decision: 'yolo', expectedRevision: 1, idempotencyKey: key(20) })).status,
    400
  );
  assert.equal(
    (await decide(h, modSid, subId, { decision: 'approve', expectedRevision: 'x', idempotencyKey: key(21) })).status,
    400
  );
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM review_events', [])).c, 0);
});

test('V4.8 decision on nonexistent submission → 404 (not 500)', async () => {
  const { h, modSid } = await setup();
  const r = await decide(h, modSid, 'sub_999999', {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(22),
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});

test('V4.9 queue and admin detail expose immutable history with deterministic order', async () => {
  const { h, modSid, subId } = await setup();
  const queue = await h.req({ method: 'GET', path: '/v1/admin/queue', session: modSid, query: {} });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.items.length, 1);
  assert.equal(queue.body.items[0].id, subId);
  assert.equal(queue.body.items[0].evidenceCount, 1);
  const detail = await h.req({
    method: 'GET',
    path: `/v1/admin/submissions/${subId}`,
    session: modSid,
    query: {},
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.revisions.length, 1);
  assert.deepEqual(detail.body.reviewEvents, []);
  // queue defaults to pending statuses; a status filter narrows it
  const rejected = await h.req({
    method: 'GET',
    path: '/v1/admin/queue',
    session: modSid,
    query: { status: 'rejected' },
  });
  assert.equal(rejected.body.items.length, 0);
});

test('V4.10 quarantine: read projection stops serving; history and feed keep evidence', async () => {
  const { h, adminSid, modSid, subId } = await setup();
  const approved = await decide(h, modSid, subId, {
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: key(23),
  });
  assert.equal(approved.status, 201);
  const entityUuid = approved.body.entityUuid;
  // moderator lacks quarantine capability
  const modAttempt = await h.req({
    method: 'POST',
    path: `/v1/admin/entities/${entityUuid}/quarantine`,
    session: modSid,
    body: { schemaVersion: 1, reason: 'x', idempotencyKey: key(24) },
  });
  assert.equal(modAttempt.status, 403);
  // quarantine requires a reason
  const noReason = await h.req({
    method: 'POST',
    path: `/v1/admin/entities/${entityUuid}/quarantine`,
    session: adminSid,
    body: { schemaVersion: 1, idempotencyKey: key(25) },
  });
  assert.equal(noReason.status, 400);
  const q = await h.req({
    method: 'POST',
    path: `/v1/admin/entities/${entityUuid}/quarantine`,
    session: adminSid,
    body: { schemaVersion: 1, reason: 'synthetic quarantine', idempotencyKey: key(26) },
  });
  assert.equal(q.status, 200);
  const overlay = await h.req({ method: 'GET', path: '/v1/catalogue/overlay', query: {} });
  assert.equal(overlay.body.items.length, 0, 'quarantined entity no longer served');
  const changes = await h.req({ method: 'GET', path: '/v1/catalogue/changes', query: {} });
  assert.deepEqual(
    changes.body.items.map((c) => c.kind),
    ['published', 'quarantined'],
    'feed keeps both events with provenance'
  );
  const history = (await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c;
  assert.equal(history, 1, 'full history retained');
  // double quarantine → 409
  const again = await h.req({
    method: 'POST',
    path: `/v1/admin/entities/${entityUuid}/quarantine`,
    session: adminSid,
    body: { schemaVersion: 1, reason: 'again', idempotencyKey: key(27) },
  });
  assert.equal(again.status, 409);
});
