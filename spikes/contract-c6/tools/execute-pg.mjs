// Goldberg 0.11 Stage 6 — C6-PG spike executor.
// One-command run: static isolation scan → SQLite post-port regression run →
// full PostgreSQL venue run (v1–v10) → results/pg/ evidence.
// Requires a LOCAL loopback PostgreSQL (C6_PG_URL). No external network.
// Never deploys anything. Never touches Supabase.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULTS = join(ROOT, 'results');
const PGDIR = join(RESULTS, 'pg');
const RAW = join(PGDIR, 'raw');
const PG_URL = process.env.C6_PG_URL;

if (!PG_URL) {
  console.error('C6_PG_URL is required (loopback-only verification instance)');
  process.exit(2);
}

// ---- 1. environment probe (verified facts only) -----------------------------
async function probeEnvironment() {
  const client = new pg.Client({ connectionString: PG_URL, database: 'c6spike' });
  await client.connect();
  try {
    const v = await client.query('SELECT version() AS v');
    const iso = await client.query("SELECT current_setting('default_transaction_isolation') AS i");
    const addr = await client.query(
      "SELECT inet_server_addr()::text AS addr, inet_server_port() AS port"
    );
    return {
      postgresVersion: v.rows[0].v,
      defaultIsolation: iso.rows[0].i,
      serverAddress: addr.rows[0].addr,
      serverPort: Number(addr.rows[0].port),
    };
  } finally {
    await client.end();
  }
}

// ---- 2. static isolation scan ----------------------------------------------
const FORBIDDEN = [
  [/node:http/, 'node:http'],
  [/node:net/, 'node:net'],
  [/node:dns/, 'node:dns'],
  [/node:tls/, 'node:tls'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/undici/, 'undici'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/wrangler/, 'wrangler'],
  [/node:child_process/, 'node:child_process'],
  [/npm install/, 'npm install'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.scratch' || name === 'results') continue;
      walk(p, out);
    } else if (/\.(mjs|json)$/.test(name) && name !== 'execute.mjs' && name !== 'execute-pg.mjs') {
      out.push(p);
    }
  }
  return out;
}

const findings = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf-8');
  for (const [re, label] of FORBIDDEN) {
    // child_process is permitted ONLY in the race test + its child tool
    if (label === 'node:child_process' && /v9-race|decide-child/.test(file)) continue;
    if (re.test(text)) findings.push(`${file.replace(ROOT, '')}: ${label}`);
  }
}
const scan = {
  filesScanned: walk(ROOT).length,
  forbiddenFindings: findings,
  verdict:
    findings.length === 0
      ? 'PASS (no external-network surface; the only socket use is the pg driver → loopback verification instance)'
      : 'FAIL',
};

// ---- 3. run both venues -----------------------------------------------------
const testFiles = readdirSync(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join('tests', f))
  .sort();

function runVenue(engine) {
  const started = new Date().toISOString();
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, C6_ENGINE: engine, ...(engine === 'postgres' ? { C6_PG_URL: PG_URL } : {}) },
  });
  const tap = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const num = (label) => {
    const m = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(tap);
    return m ? Number(m[1]) : null;
  };
  return {
    started,
    finished: new Date().toISOString(),
    tap,
    counts: {
      tests: num('tests'),
      pass: num('pass'),
      fail: num('fail'),
      cancelled: num('cancelled'),
      skipped: num('skipped'),
      exitCode: run.status,
    },
  };
}

const environment = await probeEnvironment();
const sqliteRun = runVenue('sqlite'); // post-port regression venue
const pgRun = runVenue('postgres'); // the C6-PG verification venue

// ---- 4. persist -------------------------------------------------------------
let commit = 'unknown';
let branch = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
  branch = execSync('git branch --show-current', { cwd: ROOT, encoding: 'utf-8' }).trim();
} catch {
  /* not in a git worktree */
}

const summary = {
  spike: 'goldberg-0.11-stage-6-contract-pg (C6 contract behavior vs real PostgreSQL)',
  branch,
  commit,
  node: process.version,
  environment,
  staticScan: scan,
  venues: {
    sqlitePostPort: sqliteRun.counts,
    postgres: pgRun.counts,
  },
  verdict:
    sqliteRun.counts.fail === 0 &&
    sqliteRun.counts.exitCode === 0 &&
    pgRun.counts.fail === 0 &&
    pgRun.counts.exitCode === 0 &&
    scan.verdict.startsWith('PASS')
      ? 'ALL VENUES PASS (local spike scope only — not production verification, not a Supabase run)'
      : 'FAIL',
  environmentWarnings: [
    'node:sqlite emits ExperimentalWarning on Node 22 (recorded honestly in TAP output)',
    'PostgreSQL instance is a rootless podman container bound to 127.0.0.1 only, trust auth on loopback, synthetic data only',
  ],
};

mkdirSync(RAW, { recursive: true });
writeFileSync(join(RAW, 'tap-sqlite-postport.txt'), sqliteRun.tap);
writeFileSync(join(RAW, 'tap-postgres.txt'), pgRun.tap);
writeFileSync(join(PGDIR, 'summary-data.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(PGDIR, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

console.log(JSON.stringify(summary, null, 2));
process.exit(
  summary.verdict.startsWith('ALL') ? 0 : 1
);
