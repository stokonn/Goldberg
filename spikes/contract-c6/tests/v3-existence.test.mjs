// V3 — Existence hiding, ownership isolation and public read separation
// (API-CONTRACTS.md §4/§5; THREAT-MODEL rows T7, T8, T21-adjacent isolation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload } from './helpers.mjs';

async function setup() {
  const h = await harness();
  await seedStandardPrincipals(h.db);
  const ownerSid = await h.signIn('p_contrib_a');
  const otherSid = await h.signIn('p_contrib_b');
  const modSid = await h.signIn('p_mod_1');
  const created = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(created.status, 201);
  return { h, ownerSid, otherSid, modSid, subId: created.body.submissionId };
}

test('V3.1 another contributor reads a pending submission by ID → 404 existence-hidden', async () => {
  const { h, otherSid, subId } = await setup();
  const r = await h.req({ method: 'GET', path: `/v1/submissions/${subId}`, session: otherSid, query: {} });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
  // identical response to a genuinely nonexistent ID (no existence oracle)
  const ghost = await h.req({ method: 'GET', path: '/v1/submissions/sub_999999', session: otherSid, query: {} });
  assert.equal(ghost.status, 404);
  assert.equal(Object.keys(r.body.error).sort().join(), Object.keys(ghost.body.error).sort().join());
});

test('V3.2 cross-user revision attempt → 404, row unchanged', async () => {
  const { h, otherSid, subId } = await setup();
  const before = (await h.db.get('SELECT * FROM submissions WHERE id = ?', [subId]));
  const r = await h.req({
    method: 'POST',
    path: `/v1/submissions/${subId}/revisions`,
    session: otherSid,
    body: { schemaVersion: 1, payload: validPayload() },
  });
  assert.equal(r.status, 404);
  const after = (await h.db.get('SELECT * FROM submissions WHERE id = ?', [subId]));
  assert.deepEqual(after, before);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM revisions', [])).c, 1);
});

test('V3.3 cross-user withdrawal attempt → 404, row unchanged', async () => {
  const { h, otherSid, subId } = await setup();
  const r = await h.req({
    method: 'POST',
    path: `/v1/submissions/${subId}/withdraw`,
    session: otherSid,
    body: { schemaVersion: 1 },
  });
  assert.equal(r.status, 404);
  assert.equal(
    (await h.db.get('SELECT status FROM submissions WHERE id = ?', [subId])).status,
    'submitted'
  );
});

test('V3.4 moderator can read any pending submission (queue.read)', async () => {
  const { h, modSid, subId } = await setup();
  const r = await h.req({ method: 'GET', path: `/v1/submissions/${subId}`, session: modSid, query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, subId);
});

test('V3.5 owner reads own submission → 200 with full payload', async () => {
  const { h, ownerSid, subId } = await setup();
  const r = await h.req({ method: 'GET', path: `/v1/submissions/${subId}`, session: ownerSid, query: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.payload.schemaVersion, 1);
});

test('V3.6 pending submissions never appear in the public overlay or changes feed', async () => {
  const { h, subId } = await setup();
  const overlay = await h.req({ method: 'GET', path: '/v1/catalogue/overlay', query: {} });
  assert.equal(overlay.status, 200);
  assert.equal(overlay.body.items.length, 0);
  const changes = await h.req({ method: 'GET', path: '/v1/catalogue/changes', query: {} });
  assert.equal(changes.status, 200);
  assert.equal(changes.body.items.length, 0);
  // and identity/role data is never public
  const overlayDump = JSON.stringify(overlay.body);
  assert.ok(!overlayDump.includes('p_contrib_a'));
  assert.ok(!overlayDump.includes('p_mod_1'));
  assert.ok(!overlayDump.includes(subId));
});

test('V3.7 GET /v1/submissions/mine returns only own rows', async () => {
  const { h, ownerSid, otherSid, subId } = await setup();
  const mine = await h.req({ method: 'GET', path: '/v1/submissions/mine', session: otherSid, query: {} });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.items.length, 0);
  const owner = await h.req({ method: 'GET', path: '/v1/submissions/mine', session: ownerSid, query: {} });
  assert.equal(owner.body.items.length, 1);
  assert.equal(owner.body.items[0].id, subId);
});

test('V3.8 cursor paging is deterministic (≤20/page, stable order)', async () => {
  const { h, ownerSid } = await setup();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await h.req({
      method: 'POST',
      path: '/v1/submissions',
      session: ownerSid,
      body: { schemaVersion: 1, payload: validPayload() },
    });
    ids.push(r.body.submissionId);
  }
  const page1 = await h.req({
    method: 'GET',
    path: '/v1/submissions/mine',
    session: ownerSid,
    query: { limit: '2' },
  });
  assert.equal(page1.body.items.length, 2);
  assert.ok(page1.body.nextCursor);
  const page2 = await h.req({
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

test('V3.9 unknown endpoint → 404 not_found (no route smuggling)', async () => {
  const { h, ownerSid } = await setup();
  const r = await h.req({
    method: 'POST',
    path: '/v1/internal/execute',
    session: ownerSid,
    body: { schemaVersion: 1 },
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
});
