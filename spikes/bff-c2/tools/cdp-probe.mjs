/**
 * C2 spike — CPU measurement probe: CDP V8 profiler cross-check against the
 * in-worker clock. Part of the plan §7 "investigate workerd profiling
 * alternatives" requirement. Local only.
 *
 * Usage: node tools/cdp-probe.mjs [requestCount]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const N = Number(process.argv[2] ?? 200);

// (mintSidToken removed — the probe gets a real session cookie via sign-in)

async function main() {
  // Sign in to get a real session row id for a valid cookie.
  const { mintSupabaseToken } = await import("./lib.mjs");
  const sig = mintSupabaseToken({ sub: "spike-admin-1" });
  const res = await fetch("http://127.0.0.1:8787/v1/session", {
    method: "POST",
    headers: { Origin: "https://admin.stub.local", "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: sig }),
  });
  if (!res.ok) throw new Error(`signin failed: ${res.status} ${await res.text()}`);
  const sidCookie = res.headers.getSetCookie().find((c) => c.startsWith("sid=")).split(";")[0];
  const sid = JSON.parse(Buffer.from(sidCookie.slice(4).split(".")[1], "base64url").toString()).sid;

  const list = await (await fetch("http://127.0.0.1:9229/json")).json();
  const wsUrl = list[0].webSocketDebuggerUrl;
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(wsUrl, { headers: { Origin: "http://127.0.0.1:9229" } });
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });

  let msgId = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const enable = await send("Profiler.enable");
  if (enable.error) { console.log("Profiler.enable UNSUPPORTED:", JSON.stringify(enable.error)); ws.close(); return; }
  await send("Profiler.setSamplingInterval", { interval: 100 }); // 100µs
  await send("Profiler.start");

  // Warm the path once, then measure N requests while profiling.
  await fetch("http://127.0.0.1:8787/v1/admin/queue", { headers: { Cookie: sidCookie } });
  const t0 = performance.now();
  let wallSum = 0;
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const r = await fetch("http://127.0.0.1:8787/v1/admin/queue", { headers: { Cookie: sidCookie } });
    await r.arrayBuffer();
    wallSum += performance.now() - s;
  }
  const wallTotal = performance.now() - t0;

  const stop = await send("Profiler.stop");
  const profile = stop.result?.profile;
  if (!profile) { console.log("Profiler.stop no profile:", JSON.stringify(stop).slice(0, 300)); ws.close(); return; }

  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  let idleUs = 0, jsUs = 0, programUs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0;
    const node = nodes.get(profile.samples[i]);
    const fn = node?.callFrame?.functionName ?? "";
    if (fn === "(idle)") idleUs += dt;
    else if (fn === "(program)") programUs += dt;
    else jsUs += dt;
  }
  const totalUs = idleUs + jsUs + programUs;
  console.log(JSON.stringify({
    requests: N,
    wallTotalMs: +wallTotal.toFixed(1),
    wallPerRequestMs: +(wallTotal / N).toFixed(3),
    profileWindowMs: +(totalUs / 1000).toFixed(1),
    jsCpuMs: +(jsUs / 1000).toFixed(1),
    programCpuMs: +(programUs / 1000).toFixed(1),
    idleMs: +(idleUs / 1000).toFixed(1),
    jsCpuPerRequestMs: +(jsUs / 1000 / N).toFixed(3),
    jsPlusProgramPerRequestMs: +((jsUs + programUs) / 1000 / N).toFixed(3),
    sampleCount: profile.samples.length,
    intervalUs: profile._samplingInterval ?? "n/a",
  }, null, 1));
  ws.close();
}

main().catch((e) => { console.error("CDP probe failed:", e.message); process.exit(1); });
