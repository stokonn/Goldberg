/**
 * Goldberg 0.11 Stage 6 — C2 spike: fake Supabase stub (PostgREST/GoTrue/JWKS
 * SHAPES ONLY — not a Supabase emulator). Local, synthetic, no real data.
 *
 * Binds 127.0.0.1 only. Serves:
 *   GET    /auth/v1/.well-known/jwks.json     synthetic JWKS (rotatable)
 *   GET    /rest/v1/principals                ?id=eq.X | ?subject=eq.X
 *   GET    /rest/v1/sessions                  ?id=eq.X
 *   POST   /rest/v1/sessions
 *   DELETE /rest/v1/sessions?id=eq.X
 *   GET    /rest/v1/principal_capabilities    ?principal_id=eq.X
 *   GET/POST /rest/v1/decisions
 *   GET    /__kill                            kill-switch flag
 *   POST   /__control                         fault/state injection (test only)
 *   GET    /__state                           state dump (evidence)
 *
 * Failure modes apply to /rest/v1/*: ok | latency | blackhole | five_xx | quota.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = process.env.FIXTURES_DIR ?? join(HERE, "..", "fixtures", "generated");
const PORT = Number(process.env.STUB_PORT ?? 8788);
const HOST = "127.0.0.1";

const manifest = JSON.parse(readFileSync(join(FIX_DIR, "manifest.json"), "utf8"));
const jwks1 = JSON.parse(readFileSync(join(FIX_DIR, "jwks-1.json"), "utf8"));
const jwks2 = JSON.parse(readFileSync(join(FIX_DIR, "jwks-2.json"), "utf8"));

function seed() {
  return {
    principals: manifest.principals.map((p) => ({ ...p })),
    grants: manifest.grants.map((g) => ({ ...g })),
    sessions: [],
    decisions: [],
  };
}

let state = seed();
let jwksMaxAge = 300; // seconds; rotation test lowers this
let activeJwks = jwks1;
let mode = "ok"; // ok | latency | blackhole | five_xx | quota
let latencyMs = 0;
let killed = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function filter(rows, query) {
  // PostgREST-ish: ?col=eq.value
  // NOTE: iterate query.entries() — Object.entries(urlSearchParams) returns []
  // because URLSearchParams stores entries in internal slots (bug found by the
  // first full matrix run: filters were silently no-ops).
  let out = rows;
  for (const [k, v] of query.entries()) {
    if (typeof v === "string" && v.startsWith("eq.")) {
      const want = v.slice(3);
      out = out.filter((r) => String(r[k]) === want);
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  // Control endpoints are never fault-injected.
  if (path === "/__control" && req.method === "POST") {
    const cmd = JSON.parse(await readBody(req));
    // reset must NOT early-return: sibling params in the same command
    // (e.g. {reset:true, jwks_max_age:1}) have to apply too.
    if (cmd.reset) {
      state = seed();
      mode = "ok";
      latencyMs = 0;
      killed = false;
      jwksMaxAge = 300;
      activeJwks = jwks1;
    }
    if (cmd.mode !== undefined) mode = cmd.mode;
    if (cmd.latency_ms !== undefined) latencyMs = cmd.latency_ms;
    if (cmd.kill !== undefined) killed = !!cmd.kill;
    if (cmd.jwks_max_age !== undefined) jwksMaxAge = cmd.jwks_max_age;
    if (cmd.rotate_to === 2) activeJwks = jwks2;
    if (cmd.rotate_to === 1) activeJwks = jwks1;
    if (cmd.revoke_grants) state.grants = state.grants.filter((g) => g.principal_id !== cmd.revoke_grants);
    if (cmd.restore_grants) {
      for (const g of manifest.grants) {
        if (g.principal_id === cmd.restore_grants && !state.grants.some((x) => x.principal_id === g.principal_id && x.capability === g.capability)) {
          state.grants.push({ ...g });
        }
      }
    }
    if (cmd.suspend) {
      const p = state.principals.find((x) => x.id === cmd.suspend);
      if (p) p.state = "suspended";
    }
    if (cmd.activate) {
      const p = state.principals.find((x) => x.id === cmd.activate);
      if (p) p.state = "active";
    }
    if (cmd.expire_session) {
      const s = state.sessions.find((x) => x.id === cmd.expire_session);
      if (s) s.expires_at = Math.floor(Date.now() / 1000) - 120;
    }
    return send(res, 200, { ok: true, reset: !!cmd.reset });
  }
  if (path === "/__kill") return send(res, 200, { killed });
  if (path === "/__state") return send(res, 200, state);

  if (path === "/auth/v1/.well-known/jwks.json") {
    return send(res, 200, activeJwks, { "Cache-Control": `public, max-age=${jwksMaxAge}` });
  }

  if (path.startsWith("/rest/v1/")) {
    // Fault injection for the data plane only.
    if (mode === "blackhole") return; // never respond (worker fetch times out)
    if (mode === "latency" && latencyMs > 0) await sleep(latencyMs);
    if (mode === "five_xx") return send(res, 500, { message: "stub internal error" });
    if (mode === "quota") return send(res, 429, { message: "stub quota exhausted" });

    const table = path.slice("/rest/v1/".length);
    if (table === "principals" && req.method === "GET") {
      return send(res, 200, filter(state.principals, url.searchParams));
    }
    if (table === "sessions") {
      if (req.method === "GET") return send(res, 200, filter(state.sessions, url.searchParams));
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const row = { id: randomUUID(), ...body };
        state.sessions.push(row);
        return send(res, 201, row);
      }
      if (req.method === "DELETE") {
        const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
        const s = state.sessions.find((x) => x.id === id);
        if (s) s.revoked = true;
        return send(res, 204, undefined);
      }
    }
    if (table === "principal_capabilities" && req.method === "GET") {
      const rows = filter(state.grants, url.searchParams).map((g) => ({ capability: g.capability }));
      return send(res, 200, rows);
    }
    if (table === "decisions") {
      if (req.method === "GET") return send(res, 200, state.decisions);
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const row = { id: randomUUID(), ...body };
        state.decisions.push(row);
        return send(res, 201, row);
      }
    }
    return send(res, 404, { message: "unknown table" });
  }

  return send(res, 404, { message: "unknown route" });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`stub listening on http://${HOST}:${PORT}\n`);
});
