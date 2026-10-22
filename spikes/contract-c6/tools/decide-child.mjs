// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: race-test child process.
// Opens the shared trial database (SQLite scratch file or pinned PostgreSQL
// connection), waits for the barrier file, then attempts one moderation
// decision. Prints READY before waiting and a JSON result line after. Local
// only; no network beyond the loopback verification instance; no external
// processes besides this script.
//
// C6-PG PORT (2026-10-22): argv now carries the engine as the first argument.
//   sqlite:   <engine=sqlite> <dbPath> <sid> <subId> <barrier> <key>
//   postgres: <engine=postgres> <url> <schema> <sid> <subId> <barrier> <key>
// Each PG child opens its OWN connection (true concurrency, like a pool).

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [engine, dbArg, maybeSchema, sid, subId, barrierPath, keyArg] = process.argv.slice(2);

if (!engine || !dbArg || !sid || !subId || !barrierPath || !keyArg) {
  console.log(JSON.stringify({ error: 'usage: decide-child <engine> <db|url> [<schema>] <sid> <subId> <barrier> <key>' }));
  process.exit(2);
}
const schema = engine === 'postgres' ? maybeSchema : undefined;

const { createServer } = await import('../src/server.mjs');
let db;
if (engine === 'postgres') {
  const { openPgDb } = await import('../src/db-pg.mjs');
  db = await openPgDb({ url: dbArg, schema, ddl: false });
} else {
  const { openDb } = await import('../src/db.mjs');
  db = openDb(dbArg, { schema: false });
}

const T0 = 1_760_000_000_000; // must match the parent harness clock
const server = createServer({ db, now: () => T0 });

console.log('READY');
const deadline = Date.now() + 5000;
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
console.log(JSON.stringify({ status: r.status, body: r.body }));
await db.close();
process.exit(0);
