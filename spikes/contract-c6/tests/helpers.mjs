// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: deterministic test
// harness helpers. Fake clock, synthetic principals, contract-path sign-in.

import { openDb, seedPrincipal } from '../src/db.mjs';
import { createServer } from '../src/server.mjs';

// Fixed epoch so runs are reproducible (no wall-clock dependence in tests).
export const T0 = 1_760_000_000_000;

export function harness({ start = T0 } = {}) {
  const db = openDb(':memory:');
  let t = start;
  const server = createServer({ db, now: () => t });
  const advance = (ms) => {
    t += ms;
  };
  const req = (r) => server.handle(r);
  const signIn = (principalId) => {
    const r = server.handle({
      method: 'POST',
      path: '/v1/session',
      body: { schemaVersion: 1, credential: `synthetic:${principalId}` },
    });
    if (r.status !== 201) throw new Error(`sign-in failed for ${principalId}: ${JSON.stringify(r.body)}`);
    return r.body.sid;
  };
  return { db, server, req, advance, signIn, now: () => t };
}

// Obviously fictional principals used across the suites.
export function seedStandardPrincipals(db) {
  seedPrincipal(db, 'p_contrib_a', 'Synthetic Alice', []);
  seedPrincipal(db, 'p_contrib_b', 'Synthetic Bob', []);
  seedPrincipal(db, 'p_mod_1', 'Synthetic Morgan (moderator)', ['moderator']);
  seedPrincipal(db, 'p_mod_2', 'Synthetic Casey (moderator)', ['moderator']);
  seedPrincipal(db, 'p_admin_1', 'Synthetic Admin', ['admin']);
}

// Deterministic UUIDs (v4-shaped) for fixtures.
export function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

let payloadCounter = 100;
// A minimal valid submission payload (DATA-MODEL.md §2 shape).
export function validPayload(overrides = {}) {
  payloadCounter += 1;
  return {
    schemaVersion: 1,
    target: { kind: 'work', externalIdentity: `synthetic-work-${payloadCounter}` },
    changeKind: 'new_metadata',
    fields: [
      {
        field: 'title',
        newValue: `Synthetic Work ${payloadCounter}`,
        evidence: [
          {
            type: 'source_url',
            value: 'https://public.example.org/synthetic-source',
            license: 'CC0-1.0',
          },
        ],
      },
    ],
    intendedLicense: 'CC0-1.0',
    ...overrides,
  };
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function key(n) {
  return `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
}
