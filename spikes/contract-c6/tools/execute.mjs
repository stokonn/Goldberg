// Goldberg 0.11 Stage 6 — C6 spike executor.
// One-command run: static isolation scan → full test suite (TAP) → results/.
// Zero npm dependencies. No network. Never deploys anything.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULTS = join(ROOT, 'results');
const RAW = join(RESULTS, 'raw');

// ---- 1. static isolation scan ----------------------------------------------
const FORBIDDEN = [
  [/node:http/, 'node:http'],
  [/node:net/, 'node:net'],
  [/node:dns/, 'node:dns'],
  [/node:tls/, 'node:tls'],
  [/node:child_process/, 'node:child_process'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/undici/, 'undici'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/wrangler/, 'wrangler'],
  [/npm install/, 'npm install'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.scratch' || name === 'results') continue;
      walk(p, out);
    } else if (/\.(mjs|json)$/.test(name) && name !== 'execute.mjs') {
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
  verdict: findings.length === 0 ? 'PASS (no network/dependency surface)' : 'FAIL',
};

// ---- 2. run the suite (TAP) -------------------------------------------------
const testFiles = readdirSync(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join('tests', f));
const started = new Date().toISOString();
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
  cwd: ROOT,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});
const tap = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const num = (label) => {
  const m = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(tap);
  return m ? Number(m[1]) : null;
};
const counts = {
  tests: num('tests'),
  pass: num('pass'),
  fail: num('fail'),
  cancelled: num('cancelled'),
  skipped: num('skipped'),
  exitCode: run.status,
};

// ---- 3. persist -------------------------------------------------------------
let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
} catch {
  /* not in a git worktree */
}
const summary = {
  spike: 'goldberg-0.11-stage-6-contract (C6 contract-behavior)',
  started,
  finished: new Date().toISOString(),
  branch: (() => {
    try {
      return execSync('git branch --show-current', { cwd: ROOT, encoding: 'utf-8' }).trim();
    } catch {
      return 'unknown';
    }
  })(),
  commit,
  node: process.version,
  staticScan: scan,
  counts,
  verdict: counts.fail === 0 && counts.exitCode === 0 && scan.verdict.startsWith('PASS')
    ? 'ALL TESTS PASS (local spike scope only — not production verification)'
    : 'FAIL',
  environmentWarnings: [
    'node:sqlite emits ExperimentalWarning on Node 22 (recorded honestly in TAP output)',
  ],
};
mkdirSync(RAW, { recursive: true });
writeFileSync(join(RAW, 'tap.txt'), tap);
writeFileSync(join(RESULTS, 'summary-data.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(RAW, 'run.json'), `${JSON.stringify(summary, null, 2)}\n`);

console.log(JSON.stringify(summary, null, 2));
process.exit(counts.fail === 0 && counts.exitCode === 0 ? 0 : 1);
