// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: V9 multi-process
// concurrent-decision race (THREAT-MODEL row T10: two moderators approve
// simultaneously from separate processes → exactly one decision commits,
// the loser gets 409, never double-approve / last-write-wins).
//
// Method: a scratch file-backed SQLite database (WAL + busy_timeout), two
// independent Node processes barrier-synced on a sentinel file, each running
// the full approval transaction under BEGIN IMMEDIATE. The invariant asserted
// is the OUTCOME (exactly one 201 + one 409, single publication, coherent
// audit); wall-clock interleaving order between processes is not asserted —
// the database lock serializes writers, which is precisely the guarantee
// under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDb, seedPrincipal } from '../src/db.mjs';
import { createServer, verifyChain } from '../src/server.mjs';
import { validPayload, key } from './helpers.mjs';

const T0 = 1_760_000_000_000;
const SCRATCH = fileURLToPath(new URL('../.scratch/', import.meta.url));
const CHILD = fileURLToPath(new URL('../tools/decide-child.mjs', import.meta.url));
const TRIALS = 10;

// Spawn helper: resolves `ready` when the child prints READY, `exited` with
// its exit code; stdout/stderr accumulate in `state`.
function launchChild(args) {
  const child = spawn(process.execPath, [CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '' };
  const ready = new Promise((resolveReady) => {
    child.stdout.on('data', (d) => {
      state.out += d.toString();
      if (state.out.includes('READY')) resolveReady(true);
    });
  });
  child.stderr.on('data', (d) => {
    state.err += d.toString();
  });
  const exited = new Promise((resolveExit) => {
    child.on('close', (code) => resolveExit(code));
  });
  return { child, ready, exited, state };
}

function cleanup(files) {
  for (const f of files) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
}

test('V9 multi-process concurrent approve race: exactly one commits (T10)', { timeout: 60_000 }, async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const outcomes = [];

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const dbPath = join(SCRATCH, `race-${trial}.db`);
    const barrierPath = join(SCRATCH, `go-${trial}`);
    cleanup([dbPath, `${dbPath}-wal`, `${dbPath}-shm`, barrierPath]);

    const db = openDb(dbPath);
    seedPrincipal(db, 'p_contrib_r', 'Synthetic Racer', []);
    seedPrincipal(db, 'p_mod_a', 'Synthetic Mod A', ['moderator']);
    seedPrincipal(db, 'p_mod_b', 'Synthetic Mod B', ['moderator']);
    const server = createServer({ db, now: () => T0 });
    const signIn = (pid) => {
      const r = server.handle({
        method: 'POST',
        path: '/v1/session',
        body: { schemaVersion: 1, credential: `synthetic:${pid}` },
      });
      assert.equal(r.status, 201);
      return r.body.sid;
    };
    const sidA = signIn('p_mod_a');
    const sidB = signIn('p_mod_b');
    const created = server.handle({
      method: 'POST',
      path: '/v1/submissions',
      session: (() => {
        const r = server.handle({
          method: 'POST',
          path: '/v1/session',
          body: { schemaVersion: 1, credential: 'synthetic:p_contrib_r' },
        });
        return r.body.sid;
      })(),
      body: { schemaVersion: 1, payload: validPayload() },
    });
    assert.equal(created.status, 201);
    const subId = created.body.submissionId;

    const a = launchChild([dbPath, sidA, subId, barrierPath, key(200 + trial * 2)]);
    const b = launchChild([dbPath, sidB, subId, barrierPath, key(201 + trial * 2)]);
    await Promise.all([a.ready, b.ready]);
    writeFileSync(barrierPath, 'go');
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    assert.equal(codeA, 0, `child A exit 0 (stderr: ${a.state.err})`);
    assert.equal(codeB, 0, `child B exit 0 (stderr: ${b.state.err})`);

    const lineA = a.state.out.trim().split('\n').at(-1);
    const lineB = b.state.out.trim().split('\n').at(-1);
    const resA = JSON.parse(lineA);
    const resB = JSON.parse(lineB);
    outcomes.push([resA.status, resB.status]);

    // exactly one commits; the loser sees 409 conflict — never 500, never both
    assert.deepEqual(
      [resA.status, resB.status].sort(),
      [201, 409],
      `trial ${trial}: expected one 201 and one 409, got ${lineA} / ${lineB}`
    );

    // single publication, single review event, coherent audit
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM published_revisions').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM published_entities').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM review_events').get().c, 1);
    assert.equal(db.prepare('SELECT status FROM submissions WHERE id = ?').get(subId).status, 'published');
    const approvals = db
      .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE action = 'decision.approve'")
      .get().c;
    assert.equal(approvals, 1, 'exactly one approval audit row');
    assert.equal(verifyChain(db).ok, true, 'audit chain coherent after race');

    db.close();
    cleanup([dbPath, `${dbPath}-wal`, `${dbPath}-shm`, barrierPath]);
  }

  assert.equal(outcomes.length, TRIALS);
  process.stdout.write(`V9 race outcomes across ${TRIALS} trials: ${JSON.stringify(outcomes)}\n`);
});

test('V9 scratch dir is disposable and contains no committed data', () => {
  // .scratch must be gitignored (README + .gitignore) — presence check only
  const gitignore = readFileSync(fileURLToPath(new URL('../.gitignore', import.meta.url)), 'utf-8');
  assert.match(gitignore, /\.scratch\//);
  assert.match(gitignore, /node_modules\//);
});
