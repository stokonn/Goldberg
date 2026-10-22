// V1 — Submission payload validation (API-CONTRACTS.md §1/§4,
// DATA-MODEL.md §2; THREAT-MODEL rows T6 mass-assignment, T13 malicious input).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, seedStandardPrincipals, validPayload, key } from './helpers.mjs';

function setup() {
  const h = harness();
  seedStandardPrincipals(h.db);
  const sid = h.signIn('p_contrib_a');
  return { h, sid };
}

const submit = (h, sid, payload, extra = {}) =>
  h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 1, payload, ...extra },
  });

test('V1.1 valid submission accepted → 201, revision 1, status submitted', () => {
  const { h, sid } = setup();
  const r = submit(h, sid, validPayload());
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'submitted');
  assert.equal(r.body.revision, 1);
  assert.match(r.body.requestId, /^req_/);
  const row = h.db.prepare('SELECT * FROM submissions').get();
  assert.equal(row.status, 'submitted');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM revisions').get().c, 1);
});

test('V1.2 unknown top-level payload field → 400, nothing persisted', () => {
  const { h, sid } = setup();
  const payload = validPayload({ smuggledField: 'should not persist' });
  const r = submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'validation_failed');
  assert.match(r.body.error.details.join(' '), /unknown field rejected/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.3 mass-assignment: author/status/approval/roles in payload → 400, state unchanged', () => {
  const { h, sid } = setup();
  const payload = validPayload();
  payload.author = 'p_admin_1';
  payload.status = 'approved';
  payload.approval = true;
  payload.roles = ['admin'];
  const r = submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.4 envelope: missing/unsupported schemaVersion → 400', () => {
  const { h, sid } = setup();
  const missing = h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { payload: validPayload() },
  });
  assert.equal(missing.status, 400);
  const wrong = h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 2, payload: validPayload() },
  });
  assert.equal(wrong.status, 400);
});

test('V1.5 unknown request field at the envelope level → 400 (never stripped)', () => {
  const { h, sid } = setup();
  const r = h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 1, payload: validPayload(), evil: true },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.details.join(' '), /evil/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.6 oversized body (>16 KiB) → 400, nothing persisted', () => {
  const { h, sid } = setup();
  const payload = validPayload({ contributorNote: 'x'.repeat(20 * 1024) });
  const r = submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.7 field/evidence caps: >20 fields → 400; >10 evidence URLs → 400', () => {
  const { h, sid } = setup();
  const manyFields = validPayload();
  manyFields.fields = Array.from({ length: 21 }, (_, i) => ({
    field: `field_${i}`,
    newValue: 'v',
  }));
  assert.equal(submit(h, sid, manyFields).status, 400);

  const manyEvidence = validPayload();
  manyEvidence.fields = Array.from({ length: 11 }, (_, i) => ({
    field: `f${i}`,
    newValue: 'v',
    evidence: [{ type: 'source_url', value: 'https://public.example.org/x', license: 'CC0-1.0' }],
  }));
  assert.equal(submit(h, sid, manyEvidence).status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.8 deeply nested JSON → 400', () => {
  const { h, sid } = setup();
  const payload = validPayload();
  let deep = { leaf: true };
  for (let i = 0; i < 12; i += 1) deep = { nest: deep };
  payload.contributorNote = undefined;
  payload.fields.push({ field: 'note', newValue: 'v', extra: deep });
  const r = submit(h, sid, payload);
  assert.equal(r.status, 400);
});

test('V1.9 HTML/script markup and control characters in text → 400, nothing persisted', () => {
  const { h, sid } = setup();
  const scripty = validPayload();
  scripty.fields[0].newValue = '<script>alert(1)</script>';
  assert.equal(submit(h, sid, scripty).status, 400);

  const brackets = validPayload();
  brackets.fields[0].newValue = 'a < b > c';
  assert.equal(submit(h, sid, brackets).status, 400);

  const ctrl = validPayload();
  ctrl.fields[0].newValue = 'bad\u0000value';
  assert.equal(submit(h, sid, ctrl).status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.10 non-https / non-allowlisted evidence URL schemes → 400', () => {
  const { h, sid } = setup();
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'http://public.example.org/x']) {
    const p = validPayload();
    p.fields[0].evidence = [{ type: 'source_url', value, license: 'CC0-1.0' }];
    const r = submit(h, sid, p);
    assert.equal(r.status, 400, `expected 400 for ${value}`);
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.11 bad changeKind / correction without catalogueUuid → 400', () => {
  const { h, sid } = setup();
  const badKind = validPayload({ changeKind: 'overwrite_everything' });
  assert.equal(submit(h, sid, badKind).status, 400);
  const correction = validPayload({ changeKind: 'correction' });
  correction.target = { kind: 'work' }; // no catalogueUuid
  assert.equal(submit(h, sid, correction).status, 400);
});

test('V1.12 non-allowlisted intendedLicense → 400', () => {
  const { h, sid } = setup();
  const r = submit(h, sid, validPayload({ intendedLicense: 'All-Rights-Reserved-Made-Up' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error.details.join(' '), /intendedLicense/);
});

test('V1.13 malformed idempotencyKey (not a UUID) → 400', () => {
  const { h, sid } = setup();
  const r = submit(h, sid, validPayload(), { idempotencyKey: 'not-a-uuid' });
  assert.equal(r.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V1.14 personal-practice-data style keys cannot persist (no escape hatch)', () => {
  const { h, sid } = setup();
  const payload = validPayload({ notes: 'journal content', sessions: [1, 2] });
  const r = submit(h, sid, payload);
  assert.equal(r.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
  // and the stored shape of a valid submission contains no such keys
  submit(h, sid, validPayload());
  const row = h.db.prepare('SELECT payload_json FROM submissions').get();
  assert.ok(!row.payload_json.includes('journal'));
  assert.ok(!row.payload_json.includes('"notes"'));
});

test('V1.15 personal-data isolation regression: valid request body keys are exactly the allowlist', () => {
  const { h, sid } = setup();
  const r = submit(h, sid, validPayload());
  assert.equal(r.status, 201);
  const stored = JSON.parse(h.db.prepare('SELECT payload_json FROM submissions').get().payload_json);
  assert.deepEqual(
    Object.keys(stored).sort(),
    ['changeKind', 'fields', 'intendedLicense', 'schemaVersion', 'target'].sort()
  );
});

test('V1.16 quota-aware boundaries are distinct from validation errors', () => {
  const { h, sid } = setup();
  for (let i = 0; i < 5; i += 1) assert.equal(submit(h, sid, validPayload()).status, 201);
  const sixth = submit(h, sid, validPayload());
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error.code, 'rate_limited');
});
