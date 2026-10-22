// V7 — Evidence-URL guard (THREAT-MODEL row T14, static portion only:
// no DNS resolution / redirect following is performed — see results/SUMMARY.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidenceUrl } from '../src/ssrf.mjs';
import { harness, seedStandardPrincipals, validPayload } from './helpers.mjs';

test('V7.1 cloud metadata and loopback targets refused', () => {
  for (const url of [
    'https://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254/',
    'https://127.0.0.1/admin',
    'https://localhost/admin',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
  ]) {
    assert.equal(checkEvidenceUrl(url).ok, false, `must refuse ${url}`);
  }
});

test('V7.2 private and special-use ranges refused', () => {
  for (const url of [
    'https://10.0.0.5/internal',
    'https://192.168.1.1/router',
    'https://172.16.0.1/',
    'https://172.31.255.255/',
    'https://100.64.0.1/',
    'https://198.18.0.1/',
    'https://224.0.0.1/multicast',
    'https://255.255.255.255/',
    'https://0.0.0.0/',
    'https://192.0.2.1/', // TEST-NET-1
    'https://[fd00::1]/',
    'https://[fe80::1]/',
  ]) {
    assert.equal(checkEvidenceUrl(url).ok, false, `must refuse ${url}`);
  }
});

test('V7.3 dangerous schemes refused', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'file:///etc/passwd',
    'ftp://public.example.org/x',
    'http://public.example.org/insecure',
  ]) {
    assert.equal(checkEvidenceUrl(url).ok, false, `must refuse ${url}`);
  }
});

test('V7.4 public https URLs accepted (no network fetch is ever performed)', () => {
  for (const url of [
    'https://public.example.org/a-page',
    'https://en.wikipedia.org/wiki/Fixture',
    'https://8.8.8.8/looks-like-an-ip-but-public',
  ]) {
    assert.equal(checkEvidenceUrl(url).ok, true, `must accept ${url}`);
  }
});

test('V7.5 credentials, odd ports, .local/.internal suffixes refused', () => {
  for (const url of [
    'https://user:pass@public.example.org/',
    'https://public.example.org:8443/x',
    'https://host.local/x',
    'https://service.internal/x',
    'https://name.localhost/x',
    'not a url at all',
  ]) {
    assert.equal(checkEvidenceUrl(url).ok, false, `must refuse ${url}`);
  }
});

test('V7.6 invalid/non-canonical IPv4 literals refused; shorthand resolves before range check', () => {
  // 5-octet numeric host: not a valid IPv4 → refused (fail closed)
  assert.equal(checkEvidenceUrl('https://1.2.3.4.5/').ok, false);
  // out-of-range octets fail URL parsing outright → refused
  assert.equal(checkEvidenceUrl('https://999.999.999.999/').ok, false);
  // FINDING (documented): WHATWG URL parsing resolves IPv4 shorthand BEFORE
  // the guard sees it — "1.2.3" becomes "1.2.0.3" (public) and is range-checked
  // as a normal literal; shorthand that resolves to a private range IS refused:
  assert.equal(checkEvidenceUrl('https://1.2.3/').ok, true); // → 1.2.0.3, public
  assert.equal(checkEvidenceUrl('https://127.1/').ok, false); // → 127.0.0.1, loopback
  assert.equal(checkEvidenceUrl('https://10.1/').ok, false); // → 10.0.0.1, private
});

test('V7.7 contract enforcement: bad evidence URL inside a payload → 400, not persisted', () => {
  const h = harness();
  seedStandardPrincipals(h.db);
  const sid = h.signIn('p_contrib_a');
  const payload = validPayload();
  payload.fields[0].evidence = [
    { type: 'source_url', value: 'https://169.254.169.254/steal', license: 'CC0-1.0' },
  ];
  const r = h.req({
    method: 'POST',
    path: '/v1/submissions',
    session: sid,
    body: { schemaVersion: 1, payload },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.details.join(' '), /non-public range/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c, 0);
});

test('V7.8 reference-type evidence values are plain text (no URL semantics)', () => {
  assert.equal(checkEvidenceUrl('https://ok.example.org/').ok, true);
  // a non-URL string is simply not a URL — only source_url entries are checked
  assert.equal(checkEvidenceUrl('ISBN-like reference text').ok, false);
});
