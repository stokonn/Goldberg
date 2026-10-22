// Goldberg 0.11 Stage 6 — C6-PG concurrency-hardening race child process.
// EXPERIMENTAL SPIKE TOOLING (never merged, local only).
//
// Same barrier pattern as tools/decide-child.mjs, but the request runs through
// the EXPERIMENTAL hardened decision server (src/harden.mjs) with an explicit
// strategy, so the repeated multi-process race can compare:
//   for-update   — SELECT … FOR UPDATE row lock + audit_head append mutex
//   serializable — BEGIN ISOLATION LEVEL SERIALIZABLE + SQLSTATE retry/mapping
//
// Usage (PostgreSQL venue only):
//   decide-hardened-child postgres <url> <schema> <sid> <subId> <barrier> <key> <strategy>
//
// Each child opens its OWN pg connection (true concurrency, like a pool).
// Prints READY, waits on the barrier file, then prints the JSON result line
// (status + body + strategy telemetry stats) and exits 0.

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [engine, url, schema, sid, subId, barrierPath, keyArg, strategy] = process.argv.slice(2);

if (engine !== 'postgres' || !url || !schema || !sid || !subId || !barrierPath || !keyArg || !strategy) {
  console.log(
    JSON.stringify({
      error:
        'usage: decide-hardened-child postgres <url> <schema> <sid> <subId> <barrier> <key> <strategy>',
    })
  );
  process.exit(2);
}

const { openPgDb } = await import('../src/db-pg.mjs');
const { createHardenedServer } = await import('../src/harden.mjs');

const db = await openPgDb({ url, schema, ddl: false });
const T0 = 1_760_000_000_000; // must match the parent harness clock
const server = createHardenedServer({ db, now: () => T0, strategy });

console.log('READY');
const deadline = Date.now() + 8000;
while (!existsSync(barrierPath)) {
  if (Date.now() > deadline) {
    console.log(JSON.stringify({ error: 'barrier timeout' }));
    await db.close();
    process.exit(3);
  }
  await sleep(2);
}

const r = await server.handle({
  method: 'POST',
  path: `/v1/admin/submissions/${subId}/decisions`,
  session: sid,
  body: {
    schemaVersion: 1,
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey: keyArg,
  },
});
console.log(JSON.stringify({ status: r.status, body: r.body, stats: server.stats }));
await db.close();
process.exit(0);
