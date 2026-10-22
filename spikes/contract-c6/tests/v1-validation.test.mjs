// V1 — Submission payload validation (API-CONTRACTS.md §1/§4,
// DATA-MODEL.md §2; THREAT-MODEL rows T6 mass-assignment, T13 malicious input).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload, key } from './helpers.mjs';

async function setup() {
  const h = await harness();
  await seedStandardPrincipals(h.db);
  const sid = await h.signIn('p_contrib_a');
  return { h, sid };
}

const submit = async (h, sid, payload, extra = {}) =>
  await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 1, payload, ...extra },
  });

test('V1.1 valid submission accepted → 201, revision 1, status submitted', async () => {
  const { h, sid } = await setup();
  const r = await submit(h, sid, validPayload());
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'submitted');
  assert.equal(r.body.revision, 1);
  assert.match(r.body.requestId, /^req_/);
  const row = (await h.db.get('SELECT * FROM submissions', []));
  assert.equal(row.status, 'submitted');
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM revisions', [])).c, 1);
});

test('V1.2 unknown top-level payload field → 400, nothing persisted', async () => {
  const { h, sid } = await setup();
  const payload = validPayload({ smuggledField: 'should not persist' });
  const r = await submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'validation_failed');
  assert.match(r.body.error.details.join(' '), /unknown field rejected/);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.3 mass-assignment: author/status/approval/roles in payload → 400, state unchanged', async () => {
  const { h, sid } = await setup();
  const payload = validPayload();
  payload.author = 'p_admin_1';
  payload.status = 'approved';
  payload.approval = true;
  payload.roles = ['admin'];
  const r = await submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.4 envelope: missing/unsupported schemaVersion → 400', async () => {
  const { h, sid } = await setup();
  const missing = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { payload: validPayload() },
  });
  assert.equal(missing.status, 400);
  const wrong = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 2, payload: validPayload() },
  });
  assert.equal(wrong.status, 400);
});

test('V1.5 unknown request field at the envelope level → 400 (never stripped)', async () => {
  const { h, sid } = await setup();
  const r = await h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 1, payload: validPayload(), evil: true },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.details.join(' '), /evil/);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.6 oversized body (>16 KiB) → 400, nothing persisted', async () => {
  const { h, sid } = await setup();
  const payload = validPayload({ contributorNote: 'x'.repeat(20 * 1024) });
  const r = await submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.7 field/evidence caps: >20 fields → 400; >10 evidence URLs → 400', async () => {
  const { h, sid } = await setup();
  const manyFields = validPayload();
  manyFields.fields = Array.from({ length: 21 }, (_, i) => ({
    field: `field_${i}`,
    newValue: 'v',
  }));
  assert.equal((await submit(h, sid, manyFields)).status, 400);

  const manyEvidence = validPayload();
  manyEvidence.fields = Array.from({ length: 11 }, (_, i) => ({
    field: `f${i}`,
    newValue: 'v',
    evidence: [{ type: 'source_url', value: 'https://public.example.org/x', license: 'CC0-1.0' }],
  }));
  assert.equal((await submit(h, sid, manyEvidence)).status, 400);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.8 deeply nested JSON → 400', async () => {
  const { h, sid } = await setup();
  const payload = validPayload();
  let deep = { leaf: true };
  for (let i = 0; i < 12; i += 1) deep = { nest: deep };
  payload.contributorNote = undefined;
  payload.fields.push({ field: 'note', newValue: 'v', extra: deep });
  const r = await submit(h, sid, payload);
  assert.equal(r.status, 400);
});

test('V1.9 HTML/script markup and control characters in text → 400, nothing persisted', async () => {
  const { h, sid } = await setup();
  const scripty = validPayload();
  scripty.fields[0].newValue = '<script>alert(1)</script>';
  assert.equal((await submit(h, sid, scripty)).status, 400);

  const brackets = validPayload();
  brackets.fields[0].newValue = 'a < b > c';
  assert.equal((await submit(h, sid, brackets)).status, 400);

  const ctrl = validPayload();
  ctrl.fields[0].newValue = 'bad\u0000value';
  assert.equal((await submit(h, sid, ctrl)).status, 400);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.10 non-https / non-allowlisted evidence URL schemes → 400', async () => {
  const { h, sid } = await setup();
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'http://public.example.org/x']) {
    const p = validPayload();
    p.fields[0].evidence = [{ type: 'source_url', value, license: 'CC0-1.0' }];
    const r = await submit(h, sid, p);
    assert.equal(r.status, 400, `expected 400 for ${value}`);
  }
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.11 bad changeKind / correction without catalogueUuid → 400', async () => {
  const { h, sid } = await setup();
  const badKind = validPayload({ changeKind: 'overwrite_everything' });
  assert.equal((await submit(h, sid, badKind)).status, 400);
  const correction = validPayload({ changeKind: 'correction' });
  correction.target = { kind: 'work' }; // no catalogueUuid
  assert.equal((await submit(h, sid, correction)).status, 400);
});

test('V1.12 non-allowlisted intendedLicense → 400', async () => {
  const { h, sid } = await setup();
  const r = await submit(h, sid, validPayload({ intendedLicense: 'All-Rights-Reserved-Made-Up' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error.details.join(' '), /intendedLicense/);
});

test('V1.13 malformed idempotencyKey (not a UUID) → 400', async () => {
  const { h, sid } = await setup();
  const r = await submit(h, sid, validPayload(), { idempotencyKey: 'not-a-uuid' });
  assert.equal(r.status, 400);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
});

test('V1.14 personal-practice-data style keys cannot persist (no escape hatch)', async () => {
  const { h, sid } = await setup();
  const payload = validPayload({ notes: 'journal content', sessions: [1, 2] });
  const r = await submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal((await h.db.get('SELECT COUNT(*) AS c FROM submissions', [])).c, 0);
  // and the stored shape of a valid submission contains no such keys
  await submit(h, sid, validPayload());
  const row = (await h.db.get('SELECT payload_json FROM submissions', []));
  assert.ok(!row.payload_json.includes('journal'));
  assert.ok(!row.payload_json.includes('"notes"'));
});

test('V1.15 personal-data isolation regression: valid request body keys are exactly the allowlist', async () => {
  const { h, sid } = await setup();
  const r = await submit(h, sid, validPayload());
  assert.equal(r.status, 201);
  const stored = JSON.parse((await h.db.get('SELECT payload_json FROM submissions', [])).payload_json);
  assert.deepEqual(
    Object.keys(stored).sort(),
    ['changeKind', 'fields', 'intendedLicense', 'schemaVersion', 'target'].sort()
  );
});

test('V1.16 quota-aware boundaries are distinct from validation errors', async () => {
  const { h, sid } = await setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await submit(h, sid, validPayload())).status, 201);
  const sixth = await submit(h, sid, validPayload());
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error.code, 'rate_limited');
});
