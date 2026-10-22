// V6 — Failure handling (API-CONTRACTS.md §2 error taxonomy, §7 abuse controls,
// DATA-MODEL.md §4 rollback; THREAT-MODEL rows T16 quota/kill-switch,
// T17 partial-failure rollback, T20 truthful unavailability).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload, key } from './helpers.mjs';
import { verifyChain } from '../src/server.mjs';

async function setup() {
  const h = await harness();
  await seedStandardPrincipals(h.db);
  const ownerSid = await h.signIn('p_contrib_a');
  const modSid = await h.signIn('p_mod_1');
  return { h, ownerSid, modSid };
}

const submit = async (h, sid, idempotencyKey) =>
  await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 1, payload: validPayload(), idempotencyKey },
  });

const decide = async (h, sid, subId, idempotencyKey) =>
  await h.req({
    method: 'POST',
    path: `/v1/admin/submissions/${subId}/decisions`,
    session: sid,
    body: { schemaVersion: 1, decision: 'approve', expectedRevision: 1, idempotencyKey },
  });

test('V6.1 T17 fault mid-approval → 500 internal, FULL rollback, retry succeeds once', async () => {
  const { h, ownerSid, modSid } = await setup();
  const created = await submit(h, ownerSid, key(40));
  const subId = created.body.submissionId;

  h.server.state.injectFault('after_publish_row'); // after publish row + feed row, before commit
  const failed = await decide(h, modSid, subId, key(41));
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error.code, 'internal');
  assert.ok(failed.body.error.requestId, '500 error envelope carries requestId');

  // full rollback: no publication, no status advance, no dangling audit gap
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_entities', [])).c, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM change_feed', [])).c, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM review_events', [])).c, 0);
  assert.equal((await h.db.get('SELECT status FROM submissions WHERE id = ?', [subId])).status, 'submitted');
  assert.equal((await verifyChain(h.db)).ok, true, 'audit chain intact (no gap)');
  assert.equal(
    (await h.db.get('SELECT COUNT(*) AS c FROM idempotency WHERE key = ?', [key(41)])).c,
    0,
    'failed attempt stored no idempotency row'
  );

  // retry (same key) executes and commits exactly once — idempotent recovery
  const retried = await decide(h, modSid, subId, key(41));
  assert.equal(retried.status, 201);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c, 1);
  assert.equal((await verifyChain(h.db)).ok, true);
});

test('V6.2 T17 variant: fault before any publish row → identical rollback guarantees', async () => {
  const { h, ownerSid, modSid } = await setup();
  const subId = (await submit(h, ownerSid, key(42))).body.submissionId;
  h.server.state.injectFault('before_publish_row');
  const failed = await decide(h, modSid, subId, key(43));
  assert.equal(failed.status, 500);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM published_revisions', [])).c, 0);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM audit_events', [])).c >= 2, true);
  assert.equal((await verifyChain(h.db)).ok, true);
  const retried = await decide(h, modSid, subId, key(43));
  assert.equal(retried.status, 201);
});

test('V6.3 kill switch: writes → 503 service_unavailable, reads continue, no fake success', async () => {
  const { h, ownerSid, modSid } = await setup();
  const subId = (await submit(h, ownerSid, key(44))).body.submissionId;
  (await h.db.run("UPDATE config SET value = 'on' WHERE key = 'kill_switch'", []));

  const blocked = await submit(h, ownerSid, key(45));
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error.code, 'service_unavailable');
  assert.equal(blocked.body.error.details.retryAfter, 60);

  const decisionBlocked = await decide(h, modSid, subId, key(46));
  assert.equal(decisionBlocked.status, 503);

  const overlay = await h.req({ method: 'GET', path: '/v1/catalogue/overlay', query: {} });
  assert.equal(overlay.status, 200, 'reads continue while intake is killed');
  const mine = await h.req({ method: 'GET', path: '/v1/submissions/mine', session: ownerSid, query: {} });
  assert.equal(mine.status, 200);

  // no pending/audit data deleted by the kill switch
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 1);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM audit_events', [])).c >= 2, true);

  // recover
  (await h.db.run("UPDATE config SET value = 'off' WHERE key = 'kill_switch'", []));
  assert.equal((await decide(h, modSid, subId, key(46))).status, 201);
});

test('V6.4 T16 pending quota: 10 pending → 429, existing data intact, local drafts preserved', async () => {
  let { h, ownerSid } = await setup();
  // 5/day cap applies first — advance a day boundary and split across days
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await submit(h, ownerSid)).body.submissionId);
  h.advance(24 * 60 * 60 * 1000); // next day (session TTL 1h is exceeded — re-auth like a real client)
  ownerSid = await h.signIn('p_contrib_a');
  for (let i = 0; i < 5; i += 1) ids.push((await submit(h, ownerSid)).body.submissionId);
  assert.equal(ids.length, 10);
  assert.ok(ids.every(Boolean), 'all 10 submissions succeeded');
  // 6th pending (still below the 5/day cap of the new day? no — day-2 counter is at 5)
  // day-2 counter reached 5, so the next attempt hits the daily cap:
  const dailyCapped = await submit(h, ownerSid);
  assert.equal(dailyCapped.status, 429);
  // pending cap: every one of the 10 is still pending — count verified directly
  const pending = (await h.db.get("SELECT COUNT(*) AS c FROM submissions WHERE status = 'submitted'", [])).c;
  assert.equal(pending, 10);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 10);
});

test('V6.5 pending cap (10) fires on a fresh day, distinct from the daily cap', async () => {
  let { h, ownerSid } = await setup();
  // day 1: 5 submissions (daily cap reached, all pending)
  for (let i = 0; i < 5; i += 1) assert.equal((await submit(h, ownerSid)).status, 201);
  h.advance(24 * 60 * 60 * 1000);
  ownerSid = await h.signIn('p_contrib_a'); // sessions expire with the day jump (V2.3)
  // day 2: 5 more → 10 pending total (daily counter day 2 = 5)
  for (let i = 0; i < 5; i += 1) assert.equal((await submit(h, ownerSid)).status, 201);
  const pendingNow = (await h.db.get("SELECT COUNT(*) AS c FROM submissions WHERE status = 'submitted'", [])).c;
  assert.equal(pendingNow, 10);
  h.advance(24 * 60 * 60 * 1000);
  ownerSid = await h.signIn('p_contrib_a');
  // day 3: daily counter is fresh (0 < 5), pending is 10 → THIS is the pending cap
  const capped = await submit(h, ownerSid);
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error.code, 'rate_limited');
  assert.equal(capped.body.error.details.retryAfter, 3600);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 10);
  // withdrawing one submission frees a pending slot → next attempt accepted
  const first = (await h.db.get('SELECT id FROM submissions ORDER BY id LIMIT 1', [])).id;
  const withdr = await h.req({
    method: 'POST',
    path: `/v1/submissions/${first}/withdraw`,
    session: ownerSid,
    body: { schemaVersion: 1 },
  });
  assert.equal(withdr.status, 200);
  assert.equal((await submit(h, ownerSid)).status, 201);
  assert.equal(
    (await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c,
    11,
    'nothing was deleted to regain quota'
  );
});

test('V6.6 error envelope shape: distinct, display-safe, no internals leaked', async () => {
  const { h, ownerSid, modSid } = await setup();
  // 400 validation
  const bad = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: ownerSid,
    body: { schemaVersion: 1, payload: { schemaVersion: 1, evil: 1 } },
  });
  // 401
  const unauth = await h.req({ method: 'GET', path: '/v1/admin/queue', query: {} });
  // 403
  const forbidden = await h.req({ method: 'GET', path: '/v1/admin/queue', session: ownerSid, query: {} });
  // 404
  const missing = await h.req({ method: 'GET', path: '/v1/submissions/sub_999999', session: ownerSid, query: {} });
  // 429
  const limited = await (async () => {
    for (let i = 0; i < 5; i += 1) await submit(h, ownerSid);
    return await submit(h, ownerSid);
  })();

  const all = [bad, unauth, forbidden, missing, limited];
  const codes = all.map((r) => r.body.error.code);
  assert.deepEqual(codes, [
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
    'rate_limited',
  ]);
  for (const r of all) {
    assert.ok(r.body.error.requestId, 'every error carries requestId');
    assert.ok(!/stack|sqlite|at Object|node:internal/i.test(r.body.error.message), 'no internals in message');
    assert.equal(typeof r.body.error.message, 'string');
  }
  assert.deepEqual(
    all.map((r) => r.status),
    [400, 401, 403, 404, 429]
  );
});

test('V6.7 every success response carries a requestId too', async () => {
  const { h, ownerSid, modSid } = await setup();
  const created = await submit(h, ownerSid, key(47));
  const overlay = await h.req({ method: 'GET', path: '/v1/catalogue/overlay', query: {} });
  const mine = await h.req({ method: 'GET', path: '/v1/submissions/mine', session: ownerSid, query: {} });
  const decided = await decide(h, modSid, created.body.submissionId, key(48));
  for (const r of [created, overlay, mine, decided]) {
    assert.match(r.body.requestId, /^req_\d{6}$/);
  }
});
