/**
 * Goldberg 0.11 Stage 6 — C2 spike executor.
 *
 * One-command, fully local execution of the C2-SPIKE-PLAN.md matrix:
 * CPU-metric validity probe → S1–S19 security scenarios → P1–P7 performance
 * scenarios → evidence under results/. Loopback only (127.0.0.1). Synthetic
 * identities only. Never deploys anything.
 *
 * Usage: node tools/execute.mjs   (from spikes/bff-c2/)
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKER, STUB, ALLOWED_ORIGIN, sessionSecret,
  req, control, stubState, signIn, mintSupabaseToken, mintSidToken,
  mintAlgNoneToken, mintConfusedToken, percentiles, median,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RAW = join(ROOT, "results", "raw");
mkdirSync(RAW, { recursive: true });

const RUN_ID = new Date().toISOString();
const LOGS = []; // captured wrangler dev output (stdout+stderr lines)
const CORPUS = []; // responses collected for the S19 secret-scan

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function version(pkg) {
  try {
    return JSON.parse(readFileSync(join(ROOT, "node_modules", pkg, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

/* ---------------- process management ---------------- */

let stubProc = null;
let wranglerProc = null;
let wranglerPort = 8787;

function startStub() {
  return new Promise((resolve, reject) => {
    stubProc = spawn("node", ["stub/server.mjs"], { cwd: ROOT, env: { ...process.env } });
    stubProc.stdout.on("data", (d) => LOGS.push(`[stub] ${d}`.trim()));
    stubProc.stderr.on("data", (d) => LOGS.push(`[stub:err] ${d}`.trim()));
    stubProc.on("error", reject);
    const t = setInterval(async () => {
      const r = await req(STUB, "/__kill").catch(() => null);
      if (r && r.status === 200) {
        clearInterval(t);
        resolve();
      }
    }, 200);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error("stub did not become ready"));
    }, 15000);
  });
}

async function startWrangler(port) {
  const proc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"],
    { cwd: ROOT, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } },
  );
  proc.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => LOGS.push(l)));
  proc.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => LOGS.push(`[err] ${l}`)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return proc;
    } catch {
      /* not ready */
    }
  }
  proc.kill("SIGTERM");
  throw new Error(`wrangler dev on port ${port} did not become ready`);
}

function stopProc(p) {
  return new Promise((resolve) => {
    if (!p || p.exitCode !== null) return resolve();
    p.once("exit", resolve);
    p.kill("SIGTERM");
    setTimeout(() => p.kill("SIGKILL"), 5000);
  });
}

/* ---------------- helpers ---------------- */

const results = { scenarios: [], perf: {}, cpuProbe: {}, validity: {}, logScan: {}, memory: {} };

function scenario(id, title, threat, { executed = true, pass, details, evidence = {} }) {
  results.scenarios.push({ id, title, threat, executed, pass: executed ? (pass ? "PASS" : "FAIL") : "NOT EXECUTED", details, evidence });
  const mark = !executed ? "SKIP" : pass ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${id} ${title}${details ? ` — ${details}` : ""}`);
}

async function pool(n, concurrency, fn) {
  const out = new Array(n);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, n) }, async () => {
    while (next < n) {
      const i = next++;
      out[i] = await fn(i);
    }
  });
  await Promise.all(workers);
  return out;
}

function statsOf(samples) {
  const cpu = samples.map((s) => s.cpuMs).filter((x) => typeof x === "number");
  const wall = samples.map((s) => s.wallMs);
  return { cpu: percentiles(cpu), wall: percentiles(wall), statuses: samples.reduce((m, s) => ((m[s.status] = (m[s.status] ?? 0) + 1), m), {}) };
}

/* ---------------- kernel CPU accounting (trustworthy primary metric) ----------------
 * Local workerd exposes NO per-request CPU metric (see runCpuProbe findings):
 *  - `wrangler dev --log-format json` does not exist in wrangler 4.151.3;
 *  - the local observability span store records duration_ms (wall) only;
 *  - in-worker performance.now() is quantized to 1 ms AND includes awaited I/O.
 * The only genuinely trustworthy CPU measure available locally is therefore
 * OS-level accounting of the workerd process (utime+stime from /proc/<pid>/stat,
 * 10 ms tick granularity). Awaited network/sleep time is NOT counted by the
 * kernel, so this measures true CPU. Batch sizes are chosen so total CPU is
 * hundreds of ticks, keeping quantization error < ~2%.
 */

function workerdPid(port) {
  try {
    return execSync(
      `ss -tlnp | grep 127.0.0.1:${port} | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -1`,
    ).toString().trim();
  } catch {
    return null;
  }
}

function cpuTicks(pid) {
  const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
  return Number(f[13]) + Number(f[14]); // utime + stime, clock ticks (USER_HZ=100)
}

async function kernelBatch(port, n, concurrency, fn) {
  const pid = workerdPid(port);
  if (!pid) throw new Error(`no workerd pid on port ${port}`);
  const t0 = cpuTicks(pid);
  const w0 = performance.now();
  await pool(n, concurrency, fn);
  const t1 = cpuTicks(pid);
  const w1 = performance.now();
  const cpuTicksTotal = t1 - t0;
  return {
    pid, requests: n, concurrency,
    wallMs: +(w1 - w0).toFixed(1),
    cpuTicks: cpuTicksTotal,
    cpuPerRequestMs: +(((cpuTicksTotal * 10) / n).toFixed(3)),
    tickQuantizationErrorPct: +((10 / Math.max(cpuTicksTotal, 1)) * 100).toFixed(2),
  };
}

async function idleBaseline(port, ms = 4000) {
  const pid = workerdPid(port);
  const t0 = cpuTicks(pid);
  const w0 = performance.now();
  await sleep(ms);
  const dticks = cpuTicks(pid) - t0;
  const dwall = performance.now() - w0;
  return { pid, windowMs: +dwall.toFixed(0), ticks: dticks, ticksPerMs: dticks / dwall };
}

/* ---------------- boot ---------------- */

async function main() {
  console.log("== C2 spike execution ==", RUN_ID);
  console.log("node", process.version, "wrangler", version("wrangler"), "workerd", version("workerd"));

  // Fresh fixtures every run (private keys are regenerated, never reused).
  await new Promise((resolve, reject) => {
    const p = spawn("node", ["tools/gen-fixtures.mjs"], { cwd: ROOT, stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("fixtures failed"))));
  });

  await startStub();
  console.log("stub ready");
  wranglerProc = await startWrangler(wranglerPort);
  console.log("wrangler dev ready on", wranglerPort);

  let runError = null;
  try {
    await runCpuProbe();
    await runValidity();
    await runScenarios();
    await runPerf();
    await runLogScan();
  } catch (e) {
    runError = e; // preserve partial evidence before rethrowing
  } finally {
    await stopProc(wranglerProc);
    await stopProc(stubProc);
  }

  const summary = {
    runId: RUN_ID,
    commit: gitCommit(),
    versions: { node: process.version, wrangler: version("wrangler"), workerd: version("workerd"), typescript: version("typescript") },
    ...(runError ? { executionError: String(runError) } : {}),
    ...results,
  };
  writeFileSync(join(RAW, "run.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(ROOT, "results", "summary-data.json"), JSON.stringify(summary, null, 2));

  const counts = results.scenarios.reduce((m, s) => ((m[s.pass] = (m[s.pass] ?? 0) + 1), m), {});
  console.log("\n== done ==", JSON.stringify(counts));
  console.log("results/summary-data.json + results/raw/run.json written");
  if (runError) throw runError;
}

/* ---------------- CPU measurement probe (critical, plan §7) ---------------- */

async function runCpuProbe() {
  console.log("-- CPU metric investigation (plan §7) --");
  await req(WORKER, "/health");
  await sleep(800);

  // (a) wrangler dev JSON request logs with cpuTime?
  const cpuLogLines = LOGS.filter((l) => /cpu[_ ]?time|cpuTime/i.test(l)).slice(0, 5);

  // (b) local observability span store: does it carry CPU per invocation?
  let spanProbe = { attempted: true, hasCpuAttribute: false, sample: null };
  try {
    const res = await fetch("http://127.0.0.1:9229/json"); // inspector reachable?
    const inspectorReachable = res.ok;
    const q = await fetch(`http://127.0.0.1:${wranglerPort}/cdn-cgi/local/explorer/api/local/observability/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT name, duration_ms, outcome, attributes FROM spans WHERE parent_id IS NULL ORDER BY start_ms DESC LIMIT 3" }),
    });
    const data = await q.json();
    const rows = data?.result?.rows ?? [];
    spanProbe = {
      inspectorReachable,
      queried: q.ok,
      rows,
      hasCpuAttribute: rows.some((r) => /cpu/i.test(String(r[4] ?? ""))),
      finding: "local span store exposes duration_ms (wall) only — no CPU accounting",
    };
  } catch (e) {
    spanProbe = { error: String(e) };
  }

  // (c) in-worker performance.now() resolution + semantics probe
  const healths = [];
  for (let i = 0; i < 20; i++) healths.push(await req(WORKER, "/health"));
  const quantized = healths.every((h) => Number.isInteger(h.cpuMs));
  const { execSync } = await import("node:child_process");
  const cpu20 = healths.map((h) => h.cpuMs);
  const inWorkerClock = {
    samples: cpu20,
    allIntegerMs: quantized,
    resolution: quantized ? "1 ms (integer) — too coarse for 3 ms-class targets" : "sub-ms",
  };

  // (d) kernel accounting availability
  const pid = workerdPid(wranglerPort);
  const idle = await idleBaseline(wranglerPort, 3000);
  results.cpuProbe = {
    wranglerJsonLogCpuAccounting: cpuLogLines.length > 0,
    wranglerCpuLogSamples: cpuLogLines.map((l) => l.slice(0, 300)),
    spanStoreProbe: spanProbe,
    inWorkerClock,
    kernelAccounting: {
      workerdPid: pid,
      idleBaseline: idle,
      finding: "OS utime+stime of the workerd process; awaited I/O not counted ⇒ true CPU; 10 ms tick granularity",
    },
    adoptedStrategy:
      "PRIMARY: kernel /proc accounting (trustworthy aggregate CPU per invocation). " +
      "SECONDARY: in-worker handler clock (includes awaited I/O; production excludes I/O ⇒ conservative per-invocation UPPER BOUND; 1 ms resolution). " +
      "CROSS-CHECK: CDP V8 profiler via workerd inspector (frames-on-stack; also an upper bound).",
  };
  console.log("  wrangler cpu logs:", cpuLogLines.length, "| span cpu attr:", spanProbe.hasCpuAttribute, "| clock quantized:", quantized, "| workerd pid:", pid, "| idle ticks/3s:", idle.ticks);
}

async function runValidity() {
  console.log("-- CPU validity check (kernel metric, plan §7) --");
  await control({ reset: true, latency_ms: 0, mode: "ok" });
  const s = await signIn("spike-admin-1");
  const queue = () => req(WORKER, "/v1/admin/queue", { cookie: s.cookie });
  await pool(30, 1, queue); // warm-up, discarded
  const grabStats = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await queue());
    return out;
  };
  // Kernel CPU at 0 ms injected latency (sequential; idle baseline ~0 ticks)
  const kb0 = await kernelBatch(wranglerPort, 100, 1, queue);
  const l0 = await grabStats(40);
  // Kernel CPU at 100 ms injected stub latency (sleep must NOT add CPU)
  await control({ mode: "latency", latency_ms: 100 });
  const kb100 = await kernelBatch(wranglerPort, 40, 1, queue);
  const l100 = await grabStats(20);
  await control({ mode: "ok", latency_ms: 0 });
  const c0 = median(l0.map((x) => x.cpuMs));
  const c100 = median(l100.map((x) => x.cpuMs));
  const w0 = median(l0.map((x) => x.wallMs));
  const w100 = median(l100.map((x) => x.wallMs));
  const kernelFlat = Math.abs(kb100.cpuPerRequestMs - kb0.cpuPerRequestMs) <= Math.max(0.5, kb0.cpuPerRequestMs * 0.15);
  const handlerTracksLatency = c100 > c0 * 5;
  results.validity = {
    kernelCpuPerRequestAt0ms: kb0.cpuPerRequestMs,
    kernelCpuPerRequestAt100ms: kb100.cpuPerRequestMs,
    kernelBatches: { at0ms: kb0, at100ms: kb100 },
    kernelMetricFlatUnderLatency: kernelFlat,
    handlerClockMedianAt0ms: c0,
    handlerClockMedianAt100ms: c100,
    handlerClockTracksLatency: handlerTracksLatency,
    wallMedianAt0ms: w0,
    wallMedianAt100ms: w100,
    verdict:
      kernelFlat && handlerTracksLatency
        ? "KERNEL accounting VALID as primary CPU metric (excludes injected latency); in-worker clock confirmed to include awaited I/O -> upper bound only"
        : kernelFlat
          ? "KERNEL metric flat; in-worker clock behavior unexpected - investigate before using"
          : "INCONCLUSIVE - kernel CPU moved with injected latency; do NOT trust CPU results",
  };
  console.log(
    "  kernel cpu/req @0/@100ms:", kb0.cpuPerRequestMs, kb100.cpuPerRequestMs,
    "| handler clock:", c0, c100, "|", results.validity.verdict.slice(0, 64),
  );
}

/* ---------------- security scenarios S1–S19 ---------------- */

async function runScenarios() {
  console.log("-- S1–S19 --");
  const state = () => stubState();
  const capture = (label, r) => CORPUS.push({ label, status: r.status, headers: r.headers, text: (r.text ?? "").slice(0, 2000), setCookie: r.setCookie });

  // S1 valid administrator session
  {
    await control({ reset: true });
    const s = await signIn("spike-admin-1");
    const q = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie });
    capture("S1-queue", q);
    const before = (await state()).decisions.length;
    const d = await req(WORKER, "/v1/admin/decisions", {
      method: "POST", cookie: s.cookie,
      headers: { Origin: ALLOWED_ORIGIN, "x-csrf-token": s.csrf },
      body: { schemaVersion: 1, submissionId: "sub-0001", decision: "approve" },
    });
    capture("S1-decide", d);
    const after = (await state()).decisions.length;
    scenario("S1", "Valid administrator session", "(baseline)", {
      pass: q.status === 200 && d.status === 201 && after === before + 1,
      details: `queue=${q.status} decide=${d.status} decisions ${before}→${after}`,
      evidence: { cpuMs: q.cpuMs, wallMs: q.wallMs, csp: q.headers["content-security-policy"] !== undefined },
    });
  }

  // S2 non-administrator → default-deny
  {
    const s = await signIn("spike-user-1");
    const before = (await state()).decisions.length;
    const d = await req(WORKER, "/v1/admin/decisions", {
      method: "POST", cookie: s.cookie,
      headers: { Origin: ALLOWED_ORIGIN, "x-csrf-token": s.csrf },
      body: { schemaVersion: 1, submissionId: "sub-0002", decision: "approve" },
    });
    capture("S2", d);
    const after = (await state()).decisions.length;
    scenario("S2", "Authenticated non-administrator hits admin endpoint", "T5-adjacent", {
      pass: d.status === 403 && d.body?.error?.code === "forbidden" && after === before,
      details: `status=${d.status} code=${d.body?.error?.code} state unchanged=${after === before}`,
    });
  }

  // S3 missing credentials
  {
    const none = await req(WORKER, "/v1/admin/queue");
    const garbage = await req(WORKER, "/v1/admin/queue", { cookie: "sid=garbage" });
    capture("S3", none);
    scenario("S3", "Missing/malformed credentials", "T1", {
      pass: none.status === 401 && garbage.status === 401,
      details: `no-cookie=${none.status} malformed-cookie=${garbage.status}`,
    });
  }

  // S4 expired session (a: JWT exp; b: session row expiry)
  {
    const expired = mintSidToken({ sid: "s-exp", expOffset: -600 });
    const a = await req(WORKER, "/v1/admin/queue", { cookie: `sid=${expired}` });
    capture("S4a", a);
    const s = await signIn("spike-admin-1");
    const st = await state();
    const row = [...st.sessions].reverse().find((x) => x.principal_id === "p-admin");
    await control({ expire_session: row.id });
    const b = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie });
    capture("S4b", b);
    scenario("S4", "Expired session token and expired session row", "T1", {
      pass: a.status === 401 && b.status === 401,
      details: `expired-JWT=${a.status} expired-row=${b.status}`,
    });
  }

  // S5 invalid signature
  {
    const forged = mintSupabaseToken({ keyFile: "private-2.pem", kid: "spike-jwk-1" });
    const r1 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: forged } });
    capture("S5-signin", r1);
    const wrongSid = mintSidToken({ sid: "s-x", secret: "not-the-session-secret" });
    const r2 = await req(WORKER, "/v1/admin/queue", { cookie: `sid=${wrongSid}` });
    capture("S5-cookie", r2);
    scenario("S5", "Invalid token signature (wrong key / wrong cookie secret)", "T2", {
      pass: r1.status === 401 && r2.status === 401,
      details: `handover=${r1.status} session-cookie=${r2.status}`,
    });
  }

  // S6 wrong issuer / audience
  {
    const wIss = mintSupabaseToken({ sub: "spike-admin-1", iss: "https://evil.example/auth/v1" });
    const r1 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: wIss } });
    const wAud = mintSupabaseToken({ sub: "spike-admin-1", aud: "someone-elses-client" });
    const r2 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: wAud } });
    capture("S6", r1);
    scenario("S6", "Wrong issuer / wrong audience", "T4", {
      pass: r1.status === 401 && r2.status === 401,
      details: `iss=${r1.status} aud=${r2.status}`,
    });
  }

  // S7 unknown kid
  {
    const tok = mintSupabaseToken({ keyFile: "private-unknown.pem", kid: "spike-jwk-unknown" });
    const r = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: tok } });
    capture("S7", r);
    scenario("S7", "Unknown signing key (kid)", "T2", {
      pass: r.status === 401,
      details: `status=${r.status} (fail-closed after bounded re-fetch)`,
    });
  }

  // S8 JWKS rotation + cache expiry
  {
    await control({ reset: true, jwks_max_age: 1 });
    // The worker honors the LAST Cache-Control it saw; force one bounded
    // re-fetch (unknown-kid path) so the cache adopts the new 1 s window.
    await req(WORKER, "/v1/session", {
      method: "POST", headers: { Origin: ALLOWED_ORIGIN },
      body: { access_token: mintSupabaseToken({ keyFile: "private-unknown.pem", kid: "spike-jwk-unknown" }) },
    });
    const t1 = mintSupabaseToken({ sub: "spike-admin-1" }); // kid-1 token
    const a1 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: t1 } });
    await control({ rotate_to: 2 });
    const a2 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: t1 } }); // within window → cached key ok
    await sleep(1600); // exceed max-age=1s cache bound
    const a3 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: t1 } }); // old key gone → deny
    const t2 = mintSupabaseToken({ sub: "spike-admin-1", keyFile: "private-2.pem", kid: "spike-jwk-2" });
    const a4 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: t2 } }); // new key accepted
    await control({ jwks_max_age: 300, rotate_to: 1 });
    capture("S8", a3);
    scenario("S8", "JWKS rotation and cache-window expiry", "T2", {
      pass: a1.status === 200 && a2.status === 200 && a3.status === 401 && a4.status === 200,
      details: `initial=${a1.status} cached-within-window=${a2.status} old-key-after-window=${a3.status} new-key=${a4.status}`,
    });
  }

  // S9 unsupported algorithms
  {
    const none = mintAlgNoneToken();
    const r1 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: none } });
    const confused = mintConfusedToken();
    const r2 = await req(WORKER, "/v1/session", { method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: confused } });
    capture("S9", r1);
    scenario("S9", "alg=none and algorithm-confusion attempts", "T2", {
      pass: r1.status === 401 && r2.status === 401,
      details: `alg-none=${r1.status} confusion=${r2.status}`,
    });
  }

  // S10 revoked administrator role — immediate, no token-expiry wait
  {
    const s = await signIn("spike-admin-1");
    const before = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie });
    await control({ revoke_grants: "p-admin" });
    const after = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie }); // same, still-cryptographically-valid session
    capture("S10", after);
    const sidCookie = s.cookie.split(";")[0].slice(4);
    const claims = JSON.parse(Buffer.from(sidCookie.split(".")[1], "base64url").toString());
    const tokenStillValid = claims.exp > Math.floor(Date.now() / 1000);
    await control({ restore_grants: "p-admin" });
    scenario("S10", "Revoked administrator role effective at next request", "T5", {
      pass: before.status === 200 && after.status === 403 && tokenStillValid,
      details: `before=${before.status} after=${after.status} JWT still valid=${tokenStillValid} (revocation did not wait for expiry)`,
    });
  }

  // S11 suspended account
  {
    const s1 = await signIn("spike-sus-1");
    const s = await signIn("spike-user-1");
    const before = await req(WORKER, "/v1/me/capabilities", { cookie: s.cookie });
    await control({ suspend: "p-user" });
    const after = await req(WORKER, "/v1/me/capabilities", { cookie: s.cookie });
    capture("S11", after);
    await control({ activate: "p-user" });
    scenario("S11", "Suspended account (at handover and mid-session)", "T5", {
      pass: s1.status === 403 && before.status === 200 && after.status === 403,
      details: `handover=${s1.status} active=${before.status} mid-session-suspend=${after.status}`,
    });
  }

  // S12 CSRF
  {
    const s = await signIn("spike-admin-1");
    const before = (await state()).decisions.length;
    const missing = await req(WORKER, "/v1/admin/decisions", {
      method: "POST", cookie: s.cookie, headers: { Origin: ALLOWED_ORIGIN },
      body: { schemaVersion: 1, submissionId: "sub-1", decision: "approve" },
    });
    const mismatch = await req(WORKER, "/v1/admin/decisions", {
      method: "POST", cookie: `${s.cookie.split("; csrf=")[0]}; csrf=deadbeef`,
      headers: { Origin: ALLOWED_ORIGIN, "x-csrf-token": "cafebabe" },
      body: { schemaVersion: 1, submissionId: "sub-1", decision: "approve" },
    });
    capture("S12", missing);
    const after = (await state()).decisions.length;
    scenario("S12", "Invalid/missing CSRF token", "T15", {
      pass: missing.status === 403 && mismatch.status === 403 && after === before,
      details: `missing=${missing.status} mismatch=${mismatch.status} state unchanged=${after === before}`,
    });
  }

  // S13 cross-origin / CORS
  {
    const s = await signIn("spike-admin-1");
    const evil = await req(WORKER, "/v1/admin/decisions", {
      method: "POST", cookie: s.cookie, headers: { Origin: "https://evil.example", "x-csrf-token": s.csrf },
      body: { schemaVersion: 1, submissionId: "sub-2", decision: "approve" },
    });
    const preflight = await req(WORKER, "/v1/admin/decisions", {
      method: "OPTIONS", cookie: s.cookie,
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    capture("S13", evil);
    const acaoEcho = [evil, preflight].some((r) => "access-control-allow-origin" in r.headers);
    scenario("S13", "Cross-origin request rejected; foreign CORS refused", "T15", {
      pass: evil.status === 403 && !acaoEcho,
      details: `evil-origin=${evil.status} preflight=${preflight.status} ACAO echoed=${acaoEcho}`,
    });
  }

  // S14 backend timeout (blackhole)
  // NOTE: sign in FIRST — the handover itself needs the backend.
  {
    const s = await signIn("spike-admin-1");
    await control({ mode: "blackhole" });
    const r = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie });
    capture("S14", r);
    const staticUp = await req(WORKER, "/");
    await control({ mode: "ok" });
    scenario("S14", "Simulated backend timeout (blackhole) → truthful503", "T20", {
      pass: r.status === 503 && r.body?.error?.code === "service_unavailable" && staticUp.status === 200,
      details: `api=${r.status} (${r.body?.error?.code}) static-route=${staticUp.status} wall=${r.wallMs.toFixed(0)}ms`,
    });
  }

  // S15 backend unavailability (5xx burst)
  {
    const s = await signIn("spike-admin-1");
    await control({ mode: "five_xx" });
    const r = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie });
    capture("S15", r);
    const staticUp = await req(WORKER, "/");
    await control({ mode: "ok" });
    const leak = /stack|at Object|workerd::|internal error detail/i.test(r.text);
    scenario("S15", "Simulated backend unavailability (5xx burst)", "T20", {
      pass: r.status === 503 && staticUp.status === 200 && !leak,
      details: `api=${r.status} static=${staticUp.status} internals leaked=${leak}`,
    });
  }

  // S16 quota exhaustion + kill switch
  {
    const s = await signIn("spike-admin-1");
    await control({ mode: "quota" });
    const r = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie });
    capture("S16-quota", r);
    await control({ mode: "ok", kill: true });
    // The worker caches the kill flag for KILL_CACHE_MS (5 s) — wait it out.
    await sleep(5600);
    const write = await req(WORKER, "/v1/admin/decisions", {
      method: "POST", cookie: s.cookie, headers: { Origin: ALLOWED_ORIGIN, "x-csrf-token": s.csrf },
      body: { schemaVersion: 1, submissionId: "sub-3", decision: "approve" },
    });
    const read = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie }); // reads unaffected by kill switch
    capture("S16-kill-write", write);
    await control({ kill: false });
    scenario("S16", "Simulated quota exhaustion + kill switch denies intake", "T20 (+T16 rehearsal)", {
      pass: r.status === 503 && write.status === 503 && read.status === 200,
      details: `quota=${r.status} kill-write=${write.status} read-while-killed=${read.status} (no escalation path exists in code)`,
    });
  }

  // S17 replayed/revoked session
  {
    const s = await signIn("spike-admin-1");
    const logout = await req(WORKER, "/v1/session", {
      method: "DELETE", cookie: s.cookie, headers: { Origin: ALLOWED_ORIGIN, "x-csrf-token": s.csrf },
    });
    const replay = await req(WORKER, "/v1/admin/queue", { cookie: s.cookie }); // same cookie replayed
    capture("S17", replay);
    const s2 = await signIn("spike-admin-1");
    const st = await state();
    const row = [...st.sessions].reverse().find((x) => x.principal_id === "p-admin" && !x.revoked);
    await control({ expire_session: row.id });
    const reuseRevoked = await req(WORKER, "/v1/admin/queue", { cookie: s2.cookie });
    scenario("S17", "Replay of logged-out and revoked sessions", "T3 (BFF layer) + AUTH.md §3", {
      pass: logout.status === 200 && replay.status === 401 && reuseRevoked.status === 401,
      details: `logout=${logout.status} cookie-replay=${replay.status} revoked-row-reuse=${reuseRevoked.status} (refresh-family rotation remains Supabase-managed, out of spike scope)`,
    });
  }

  // S18 logout then access
  {
    const s = await signIn("spike-admin-1");
    const ok = await req(WORKER, "/v1/me/capabilities", { cookie: s.cookie });
    await req(WORKER, "/v1/session", { method: "DELETE", cookie: s.cookie, headers: { Origin: ALLOWED_ORIGIN, "x-csrf-token": s.csrf } });
    const after = await req(WORKER, "/v1/me/capabilities", { cookie: s.cookie });
    capture("S18", after);
    scenario("S18", "Logout then subsequent access rejected", "AUTH.md §3", {
      pass: ok.status === 200 && after.status === 401,
      details: `before-logout=${ok.status} after-logout=${after.status}`,
    });
  }

  // S19 no privileged material in any response (corpus + logs scanned later)
  {
    const sidSample = (await signIn("spike-admin-1")).cookie.split(";")[0].slice(4);
    const scanTargets = CORPUS.map((c) => c.text).join("\n");
    const headerTargets = CORPUS.map((c) => Object.entries(c.headers).map(([k, v]) => `${k}:${v}`).join("\n")).join("\n");
    const needles = {
      privateKeyMaterial: /BEGIN [A-Z ]*PRIVATE KEY/,
      sessionSecret: sessionSecret(),
      serviceRole: /service_role/,
      supabaseTokenEcho: sidSample.split(".")[0], // our BFF session JWT must not appear in bodies
      stackTrace: /at Object\.|workerd::|Error: [^\n]*\n\s+at /,
    };
    const hits = {};
    for (const [k, n] of Object.entries(needles)) {
      const re = n instanceof RegExp ? n : new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      hits[k] = re.test(scanTargets) || re.test(headerTargets);
    }
    const cookieFlags = CORPUS.filter((c) => c.setCookie?.some((x) => x.startsWith("sid="))).every((c) =>
      c.setCookie.some((x) => /^sid=/.test(x) && /HttpOnly/.test(x) && /Secure/.test(x) && /SameSite=Strict/.test(x)),
    );
    const cspEverywhere = CORPUS.every((c) => c.headers["content-security-policy"] !== undefined);
    const clean = Object.values(hits).every((v) => v === false);
    scenario("S19", "No privileged secrets/tokens in responses; cookie flags + CSP", "D8b invariant", {
      pass: clean && cookieFlags && cspEverywhere,
      details: `corpus=${CORPUS.length} responses; secret-hits=${JSON.stringify(hits)}; sid-flags-ok=${cookieFlags}; CSP-on-all=${cspEverywhere}`,
      evidence: { hits, cookieFlags, cspEverywhere },
    });
    results.corpusSize = CORPUS.length;
    results.sidTokenSamplePrefix = sidSample.split(".")[0].slice(0, 20) + "…(synthetic)";
  }
}

/* ---------------- performance scenarios P1–P7 ---------------- */

async function runPerf() {
  console.log("-- P1–P7 --");
  const s = await signIn("spike-admin-1");
  const queue = (i) => req(WORKER, "/v1/admin/queue", { cookie: s.cookie });

  // P1 warm happy path: 3 runs × 1000 (50 warm-up discarded).
  // Runs are SEQUENTIAL so the per-invocation handler-clock distribution is a
  // clean upper bound (at conc>1 the local isolate's event-loop scheduling
  // delay also lands in the handler clock — not CPU, not production-like).
  // Kernel CPU is additionally measured at conc 1 and conc 8.
  {
    await pool(50, 1, queue); // warm-up, discarded
    const runs = [];
    const finalSamples = [];
    for (let r = 0; r < 3; r++) {
      const samples = await pool(1000, 1, queue);
      runs.push(statsOf(samples));
      finalSamples.push(...samples);
    }
    const pooled = statsOf(finalSamples);
    // Trustworthy aggregate CPU (kernel accounting):
    const kbSeq = await kernelBatch(wranglerPort, 1000, 1, queue);
    const kbConc8 = await kernelBatch(wranglerPort, 1000, 8, queue);
    results.perf.P1 = {
      scenario: "warm happy path (GET /v1/admin/queue)",
      runs, pooled,
      handlerClockNote: "handler clock at conc=1 = per-invocation UPPER BOUND (includes awaited stub I/O + 1 ms quantization; production CPU clock excludes I/O waits)",
      kernelCpuPerRequestSeqMs: kbSeq.cpuPerRequestMs,
      kernelCpuPerRequestConc8Ms: kbConc8.cpuPerRequestMs,
      kernelBatchSeq: kbSeq,
      kernelBatchConc8: kbConc8,
      targetCheck: {
        kernelAvgLteP50Target: kbSeq.cpuPerRequestMs <= 3,
        upperBoundMaxLte10msCeiling: pooled.cpu.max <= 10,
        upperBoundP99Lte8: pooled.cpu.p99 <= 8,
      },
    };
    console.log("  P1 kernel cpu/req seq/conc8:", kbSeq.cpuPerRequestMs, "/", kbConc8.cpuPerRequestMs, "ms | handler-clock p50/p95/p99/max:", pooled.cpu.p50?.toFixed(0), pooled.cpu.p95?.toFixed(0), pooled.cpu.p99?.toFixed(0), pooled.cpu.max?.toFixed(0));

    // CDP V8 profiler cross-check (secondary, frames-on-stack upper bound)
    results.perf.P1cdp = await new Promise((resolve) => {
      const chunks = [];
      const p = spawn("node", ["tools/cdp-probe.mjs", "200"], { cwd: ROOT });
      p.stdout.on("data", (d) => chunks.push(d));
      p.stderr.on("data", (d) => chunks.push(d));
      p.on("exit", (code) => {
        const text = chunks.join("");
        try {
          resolve({ ok: code === 0, ...JSON.parse(text.slice(text.indexOf("{"))) });
        } catch {
          resolve({ ok: false, raw: text.slice(0, 400) });
        }
      });
    });
    console.log("  P1 CDP cross-check jsCpu/req:", results.perf.P1cdp.jsCpuPerRequestMs ?? "n/a", "ms (upper bound)");
  }

  // P2 cold starts: 20 fresh workerd processes, first requests each (cold JWKS)
  {
    const cold = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const proc = await startWrangler(8890);
      const readyMs = performance.now() - t0;
      const coldPid = workerdPid(8890);
      const ticksBefore = coldPid ? cpuTicks(coldPid) : null;
      const sig = mintSupabaseToken({ sub: "spike-admin-1" });
      const signin = await req("http://127.0.0.1:8890", "/v1/session", {
        method: "POST", headers: { Origin: ALLOWED_ORIGIN }, body: { access_token: sig },
      });
      const cookie = signin.setCookie.find((c) => c.startsWith("sid="))?.split(";")[0];
      const q = await req("http://127.0.0.1:8890", "/v1/admin/queue", { cookie });
      const ticksAfter = coldPid ? cpuTicks(coldPid) : null;
      cold.push({
        readyMs, signinCpu: signin.cpuMs, signinWall: signin.wallMs,
        queueCpu: q.cpuMs, queueWall: q.wallMs, statuses: [signin.status, q.status],
        procTicks: ticksBefore !== null && ticksAfter !== null ? ticksAfter - ticksBefore : null,
        coldPidFound: !!coldPid,
      });
      await stopProc(proc);
    }
    results.perf.P2 = {
      scenario: "cold start ×20 fresh processes (cold JWKS + cold session key)",
      coldSigninHandlerClock: percentiles(cold.map((c) => c.signinCpu)),
      coldQueueHandlerClock: percentiles(cold.map((c) => c.queueCpu)),
      readyToServeMs: percentiles(cold.map((c) => c.readyMs)),
      processCpuTicksPerColdProcess: percentiles(cold.map((c) => c.procTicks ?? 0)),
      coldNote: "per-invocation kernel CPU is below the 10 ms tick resolution for single cold requests; per-process ticks include isolate init and are reported as totals; handler clock is the upper bound",
      allOk: cold.every((c) => c.statuses[0] === 200 && c.statuses[1] === 200),
      sample: cold.slice(0, 3),
    };
    console.log("  P2 cold ready p50 ms:", results.perf.P2.readyToServeMs.p50?.toFixed(0), "| proc ticks/cold-process p50:", results.perf.P2.processCpuTicksPerColdProcess.p50);
  }

  // P3 JWKS cold vs warm (cold from P2 above; warm signins here)
  {
    const warmSignins = [];
    for (let i = 0; i < 200; i++) {
      warmSignins.push(await req(WORKER, "/v1/session", {
        method: "POST", headers: { Origin: ALLOWED_ORIGIN },
        body: { access_token: mintSupabaseToken({ sub: "spike-admin-1" }) },
      }));
    }
    const warmCpu = percentiles(warmSignins.map((x) => x.cpuMs));
    const coldCpu = results.perf.P2.coldSigninHandlerClock;
    results.perf.P3 = {
      scenario: "JWKS cold vs warm (RS256 verify path at handover)",
      coldCpu, warmCpu,
      coldVsWarmMedianDeltaMs: +(coldCpu.p50 - warmCpu.p50).toFixed(3),
      note: "handler-clock values (upper bounds); cold includes JWKS fetch wait + first RSA key import; warm = cached CryptoKey + RS256 verify only",
    };
    console.log("  P3 jwks cold/warm handler-clock p50:", coldCpu.p50?.toFixed(0), "/", warmCpu.p50?.toFixed(0), "ms");
  }

  // P4 latency sweep (formal): kernel CPU must stay flat; the handler clock
  // is EXPECTED to track latency (documented contamination — that's exactly
  // why kernel accounting is the primary metric).
  {
    // Warm-up / GC-settling pass (P3 leaves RSA-verify garbage behind; an
    // immediate kernel batch would attribute GC to the lat=0 level).
    await control({ mode: "ok", latency_ms: 0 });
    await pool(30, 8, queue);
    await kernelBatch(wranglerPort, 100, 8, queue); // discarded
    const sweep = {};
    for (const lat of [0, 5, 25, 100]) {
      await control({ mode: lat > 0 ? "latency" : "ok", latency_ms: lat });
      await pool(20, 8, queue);
      const samples = await pool(100, 8, queue);
      const kb = await kernelBatch(wranglerPort, 100, 8, queue);
      sweep[lat] = { ...statsOf(samples), kernelCpuPerRequestMs: kb.cpuPerRequestMs, kernelBatch: kb };
    }
    await control({ mode: "ok", latency_ms: 0 });
    const k0 = sweep[0].kernelCpuPerRequestMs, k100 = sweep[100].kernelCpuPerRequestMs;
    const kernelFlat = Math.abs(k100 - k0) <= Math.max(0.5, k0 * 0.15);
    const h0 = sweep[0].cpu.p50, h100 = sweep[100].cpu.p50;
    results.perf.P4 = {
      scenario: "latency sweep 0/5/25/100 ms — CPU-independence validity check",
      sweep,
      kernelCpuFlatWithinTolerance: kernelFlat,
      handlerClockTracksLatency: h100 > h0 * 5,
      handlerClockNote: "handler clock tracks injected latency as previously shown → NOT a CPU metric; recorded for transparency",
      wallGrewMonotonically: sweep[0].wall.p50 < sweep[25].wall.p50 && sweep[25].wall.p50 < sweep[100].wall.p50,
    };
    console.log("  P4 kernel cpu/req @0/@100ms:", k0, k100, "flat:", kernelFlat, "| handler clock:", h0, h100);
  }

  // P5 error paths
  {
    const modes = { five_xx: 50, quota: 50, blackhole: 20 };
    const out = {};
    for (const [mode, n] of Object.entries(modes)) {
      await control({ mode });
      await pool(5, 5, queue);
      const samples = await pool(n, 8, queue);
      out[mode] = statsOf(samples);
    }
    await control({ mode: "ok" });
    // Kernel CPU on the fast error path (blackhole waits the full stub
    // timeout each — excluded from kernel batching for time; handler-clock
    // stats above still cover it)
    await control({ mode: "five_xx" });
    const kb5xx = await kernelBatch(wranglerPort, 100, 8, queue);
    await control({ mode: "ok" });
    results.perf.P5 = {
      scenario: "error paths (5xx / quota / blackhole)",
      out, kernelCpuPerRequest5xxMs: kb5xx.cpuPerRequestMs, kernelBatch5xx: kb5xx,
      note: "error paths short-circuit early; CPU expected ≤ happy path",
    };
    console.log("  P5 statuses:", JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.statuses]))), "| 5xx kernel cpu/req:", kb5xx.cpuPerRequestMs);
  }

  // P6 concurrency sweep — kernel CPU per concurrency level (trustworthy),
  // handler-clock stats recorded as scheduling-contaminated upper bounds.
  {
    const out = {};
    for (const conc of [1, 5, 20]) {
      await pool(20, conc, queue);
      const samples = await pool(500, conc, queue);
      const kb = await kernelBatch(wranglerPort, 500, conc, queue);
      out[conc] = { ...statsOf(samples), kernelCpuPerRequestMs: kb.cpuPerRequestMs, kernelBatch: kb };
    }
    results.perf.P6 = {
      scenario: "concurrency 1/5/20 (local workerd contention semantics)",
      out,
      note: "handler-clock percentiles inflate with concurrency (event-loop scheduling waits, not CPU); compare kernelCpuPerRequestMs across levels",
    };
    console.log("  P6 kernel cpu/req @1/5/20:", out[1].kernelCpuPerRequestMs, out[5].kernelCpuPerRequestMs, out[20].kernelCpuPerRequestMs, "ms");
  }

  // P7 stability / leak run (10k requests) + RSS
  {
    const rss = () => {
      try {
        return Number(execSync("ps -eo rss,comm | awk '/workerd/ {s+=$1} END {print s+0}'").toString().trim());
      } catch {
        return null;
      }
    };
    const rssBefore = rss();
    const n = 10000, conc = 10;
    const samples = new Array(n);
    let idx = 0;
    const errStart = Date.now();
    const kpid = workerdPid(wranglerPort);
    const kTicks0 = cpuTicks(kpid);
    await Promise.all(
      Array.from({ length: conc }, async () => {
        while (idx < n) {
          const i = idx++;
          samples[i] = await queue(i);
        }
      }),
    );
    const kTicks1 = cpuTicks(kpid);
    const idleAfter = await idleBaseline(wranglerPort, 3000);
    const rssAfter = rss();
    const first1k = samples.slice(0, 1000).filter((x) => typeof x.cpuMs === "number");
    const last1k = samples.slice(-1000).filter((x) => typeof x.cpuMs === "number");
    const errors = samples.filter((x) => x.status !== 200).length;
    results.perf.P7 = {
      scenario: "stability: 10000 sequential-page requests at concurrency 10",
      total: n, errors, wallTotalS: ((Date.now() - errStart) / 1000).toFixed(1),
      kernelCpuTicksTotal: kTicks1 - kTicks0,
      kernelCpuPerRequestMs: +(((kTicks1 - kTicks0) * 10) / n).toFixed(3),
      idleBaselineAfter: idleAfter,
      handlerClockFirst1k: percentiles(first1k.map((x) => x.cpuMs)),
      handlerClockLast1k: percentiles(last1k.map((x) => x.cpuMs)),
      driftPct: ((median(last1k.map((x) => x.cpuMs)) - median(first1k.map((x) => x.cpuMs))) / Math.max(median(first1k.map((x) => x.cpuMs)), 0.001)) * 100,
      rssKbBefore: rssBefore, rssKbAfter: rssAfter,
    };
    results.memory = { rssKbBefore: rssBefore, rssKbAfter: rssAfter, source: "sum of workerd process RSS (kB)" };
    console.log("  P7 errors:", errors, "| kernel cpu/req:", results.perf.P7.kernelCpuPerRequestMs, "ms | handler-clock drift%:", results.perf.P7.driftPct.toFixed(1), "| rss kB:", rssBefore, "→", rssAfter);
  }
}

/* ---------------- S19 log scan (wrangler output) ---------------- */

function runLogScan() {
  const priv = readFileSync(join(ROOT, "fixtures", "generated", "private-1.pem"), "utf8");
  const privMarker = priv.split("\n")[1]?.slice(0, 40) ?? "";
  const all = LOGS.join("\n");
  results.logScan = {
    logLinesCaptured: LOGS.length,
    privateKeyMaterialInLogs: privMarker.length > 10 && all.includes(privMarker),
    sessionSecretInLogs: all.includes(sessionSecret()),
    devVarsSecretHiddenInLogs: LOGS.some((l) => l.includes('SESSION_SECRET ("(hidden)")')),
    wranglerCpuAccountingLines: LOGS.filter((l) => /cpu[_ ]?time|cpuTime/i.test(l)).length,
    cpuAccountingSamples: LOGS.filter((l) => /cpu[_ ]?time|cpuTime/i.test(l)).slice(0, 3).map((l) => l.slice(0, 300)),
    requestLogSamples: LOGS.filter((l) => l.startsWith("{")).slice(0, 3).map((l) => l.slice(0, 300)),
  };
  console.log("  log scan — private key in logs:", results.logScan.privateKeyMaterialInLogs, "| secret in logs:", results.logScan.sessionSecretInLogs, "| cpu accounting lines:", results.logScan.wranglerCpuAccountingLines);
}

main().catch((e) => {
  console.error("EXECUTION FAILED:", e);
  try { stubProc?.kill("SIGKILL"); } catch { /* ignore */ }
  try { wranglerProc?.kill("SIGKILL"); } catch { /* ignore */ }
  process.exit(1);
});
