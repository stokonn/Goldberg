// V3 — Existence hiding, ownership isolation and public read separation
// (API-CONTRACTS.md §4/§5; THREAT-MODEL rows T7, T8, T21-adjacent isolation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload } from './helpers.mjs';

function setup() {
  const h = harness();
  seedStandardPrincipals(h.db);
  const ownerSid = h.signIn('p_contrib_a');
  const otherSid = h.signIn('p_contrib_b');
  const modSid = h.signIn('p_mod_1');
  const created = h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(created.status, 201);
  return { h, ownerSid, otherSid, modSid, subId: created.body.submissionId };
}

test('V3.1 another contributor reads a pending submission by ID → 404 existence-hidden', () => {
  const { h, otherSid, subId } = setup();
  const r = h.req({ method: 'GET', path: `/v1/submissions/${subId}`, session: otherSid, query: {} });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
  // identical response to a genuinely nonexistent ID (no existence oracle)
  const ghost = h.req({ method: 'GET', path: '/v1/submissions/sub_999999', session: otherSid, query: {} });
  assert.equal(ghost.status, 404);
  assert.equal(Object.keys(r.body.error).sort().join(), Object.keys(ghost.body.error).sort().join());
});

test('V3.2 cross-user revision attempt → 404, row unchanged', () => {
  const { h, otherSid, subId } = setup();
  const before = h.db.prepare('SELECT * FROM submissions WHERE id = ?').get(subId);
  const r = h.req({
    method: 'POST',
    path: `/v1/submissions/${subId}/revisions`,
    session: otherSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(r.status, 404);
  const after = h.db.prepare('SELECT * FROM submissions WHERE id = ?').get(subId);
  assert.deepEqual(after, before);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM revisions').get().c, 1);
});

test('V3.3 cross-user withdrawal attempt → 404, row unchanged', () => {
  const { h, otherSid, subId } = setup();
  const r = h.req({
    method: 'POST',
    path: `/v1/submissions/${subId}/withdraw`,
    session: otherSid,
    body: { schemaVersion: 1 },
  });
  assert.equal(r.status, 404);
  assert.equal(
    h.db.prepare('SELECT status FROM submissions WHERE id = ?').get(subId).status,
    'submitted'
  );
});

test('V3.4 moderator can read any pending submission (queue.read)', () => {
  const { h, modSid, subId } = setup();
  const r = h.req({ method: 'GET', path: `/v1/submissions/${subId}`, session: modSid, query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, subId);
});

test('V3.5 owner reads own submission → 200 with full payload', () => {
  const { h, ownerSid, subId } = setup();
  const r = h.req({ method: 'GET', path: `/v1/submissions/${subId}`, session: ownerSid, query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.payload.schemaVersion, 1);
});

test('V3.6 pending submissions never appear in the public overlay or changes feed', () => {
  const { h, subId } = setup();
  const overlay = h.req({ method: 'GET', path: '/v1/catalogue/overlay', query: {} });
  assert.equal(overlay.status, 200);
  assert.equal(overlay.body.items.length, 0);
  const changes = h.req({ method: 'GET', path: '/v1/catalogue/changes', query: {} });
  assert.equal(changes.status, 200);
  assert.equal(changes.body.items.length, 0);
  // and identity/role data is never public
  const overlayDump = JSON.stringify(overlay.body);
  assert.ok(!overlayDump.includes('p_contrib_a'));
  assert.ok(!overlayDump.includes('p_mod_1'));
  assert.ok(!overlayDump.includes(subId));
});

test('V3.7 GET /v1/submissions/mine returns only own rows', () => {
  const { h, ownerSid, otherSid, subId } = setup();
  const mine = h.req({ method: 'GET', path: '/v1/submissions/mine', session: otherSid, query: {} });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.items.length, 0);
  const owner = h.req({ method: 'GET', path: '/v1/submissions/mine', session: ownerSid, query: {} });
  assert.equal(owner.body.items.length, 1);
  assert.equal(owner.body.items[0].id, subId);
});

test('V3.8 cursor paging is deterministic (≤20/page, stable order)', () => {
  const { h, ownerSid } = setup();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = h.req({
      method: 'POST',
      path: '/v1/submissions',
      session: ownerSid,
      body: { schemaVersion: 1, payload: validPayload() },
    });
    ids.push(r.body.submissionId);
  }
  const page1 = h.req({
    method: 'GET',
    path: '/v1/submissions/mine',
    session: ownerSid,
    query: { limit: '2' },
  });
  assert.equal(page1.body.items.length, 2);
  assert.ok(page1.body.nextCursor);
  const page2 = h.req({
    method: 'GET',
    path: '/v1/submissions/mine',
    session: ownerSid,
    query: { limit: '2', cursor: page1.body.nextCursor },
  });
  assert.equal(page2.body.items.length, 2);
  const seen = [...page1.body.items, ...page2.body.items].map((i) => i.id);
  const unique = new Set(seen);
  assert.equal(unique.size, 4, 'no duplicates across pages');
  // ordering by (created_at, id): ascending by id within the same frozen ms
  assert.deepEqual(
    seen,
    [...seen].sort()
  );
});

test('V3.9 unknown endpoint → 404 not_found (no route smuggling)', () => {
  const { h, ownerSid } = setup();
  const r = h.req({
    method: 'POST',
    path: '/v1/internal/execute',
    session: ownerSid,
    body: { schemaVersion: 1 },
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});
