// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: race-test child process.
// Opens the shared scratch file database, waits for the barrier file, then
// attempts one moderation decision. Prints READY before waiting and a JSON
// result line after. Local loopback-free; no network; no external processes
// besides this script.

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../src/db.mjs';
import { createServer } from '../src/server.mjs';

const [dbPath, sid, subId, barrierPath, idempotencyKey] = process.argv.slice(2);

if (!dbPath || !sid || !subId || !barrierPath || !idempotencyKey) {
  console.log(JSON.stringify({ error: 'usage: decide-child <db> <sid> <subId> <barrier> <key>' }));
  process.exit(2);
}

const T0 = 1_760_000_000_000; // must match the parent harness clock
const db = openDb(dbPath, { schema: false });
const server = createServer({ db, now: () => T0 });

console.log('READY');
const deadline = Date.now() + 5000;
while (!existsSync(barrierPath)) {
  if (Date.now() > deadline) {
    console.log(JSON.stringify({ error: 'barrier-timeout' }));
    process.exit(2);
  }
  await sleep(2);
}

const r = server.handle({
  method: 'POST',
  path: `/v1/admin/submissions/${subId}/decisions`,
  session: sid,
  body: {
    schemaVersion: 1,
    decision: 'approve',
    expectedRevision: 1,
    idempotencyKey,
  },
});
console.log(
  JSON.stringify({
    status: r.status,
    code: r.body.error?.code ?? null,
    decidedStatus: r.body.status ?? null,
  })
);
process.exit(0);
