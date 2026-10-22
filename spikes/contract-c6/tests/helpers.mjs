// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: deterministic test
// harness helpers. Fake clock, synthetic principals, contract-path sign-in.
//
// C6-PG PORT (2026-10-22): the harness is engine-aware and async. The engine
// is selected per run via C6_ENGINE (`sqlite` default, `postgres`) so the SAME
// suites execute against both databases. The PostgreSQL venue requires
// C6_PG_URL (loopback-only verification instance) and uses a fresh per-trial
// schema for total row isolation between tests.

import { openDb, seedPrincipal } from '../src/db.mjs';
import { createServer } from '../src/server.mjs';

// Fixed epoch so runs are reproducible (no wall-clock dependence in tests).
export const T0 = 1_760_000_000_000;

export const ENGINE = process.env.C6_ENGINE === 'postgres' ? 'postgres' : 'sqlite';

// Per-run schema counter for the PG venue (fresh schema per harness() call).
// Schemas are process-unique: node --test runs test FILES in parallel child
// processes, each with its own counter — pid prefix prevents cross-file races.
let pgSchemaCounter = 0;
const PG_SCHEMA_PREFIX = `c6_h${process.pid}_`;

// PG handles must be closed or the runner's event loop never drains. Tests do
// not close handles individually; a global after() hook (per test-file
// process) closes everything the file opened.
import { after } from 'node:test';
const OPEN_HANDLES = [];
export function registerHandle(h) {
  OPEN_HANDLES.push(h);
  return h;
}
after(async () => {
  for (const h of OPEN_HANDLES) {
    try {
      await h.close();
    } catch {
      /* already closed */
    }
  }
});

export async function harness({ start = T0 } = {}) {
  let db;
  if (ENGINE === 'postgres') {
    const { openPgDb } = await import('../src/db-pg.mjs');
    pgSchemaCounter += 1;
    db = await openPgDb({ schema: `${PG_SCHEMA_PREFIX}${pgSchemaCounter}` });
  } else {
    db = openDb(':memory:');
  }
  OPEN_HANDLES.push(db);
  let t = start;
  const server = createServer({ db, now: () => t });
  const advance = (ms) => {
    t += ms;
  };
  const req = (r) => server.handle(r);
  const signIn = async (principalId) => {
    const r = await server.handle({
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
export async function seedStandardPrincipals(db) {
  await seedPrincipal(db, 'p_contrib_a', 'Synthetic Alice', []);
  await seedPrincipal(db, 'p_contrib_b', 'Synthetic Bob', []);
  await seedPrincipal(db, 'p_mod_1', 'Synthetic Morgan (moderator)', ['moderator']);
  await seedPrincipal(db, 'p_mod_2', 'Synthetic Casey (moderator)', ['moderator']);
  await seedPrincipal(db, 'p_admin_1', 'Synthetic Admin', ['admin']);
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
