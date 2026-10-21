/**
 * Goldberg 0.11 Stage 6 — C2 spike BFF worker.
 *
 * ⚠ SYNTHETIC TEST HARNESS — LOCAL EXECUTION ONLY, NEVER DEPLOYED.
 * Implements the BFF request pipeline specified in
 * docs/planning/goldberg-0.11/stage-6/AUTH.md §2–3, §5–6 exactly as the
 * spike plan (C2-SPIKE-PLAN.md §4) requires:
 *
 *   1. session cookie parse → 2. server-tracked session validation →
 *   3. CSRF + origin verification (state-changing) →
 *   4. cryptographic JWT verification (HS256 BFF session token per request;
 *      RS256 Supabase-issued access token at the /v1/session handover,
 *      verified against the stub JWKS with kid selection + algorithm
 *      allowlist) → 5. JWKS cache/rotation handling →
 *   6. simulated Supabase session/principal/capability lookup →
 *   7. server-side default-deny authorization → 8. security headers.
 *
 * The Supabase Auth contract (AUTH.md) is preserved: this Worker only
 * CONSUMES Supabase-issued credentials at the session handover; it does not
 * implement, imitate or replace Google authentication.
 *
 * Instrumentation note: every response carries `x-spike-cpu-ms`, the
 * worker-side `performance.now()` delta for the request (runtime CPU clock,
 * NOT Date.now wall time). This header exists ONLY in the spike build to
 * make per-invocation CPU measurable; it would not exist in production and
 * leaks nothing privileged (synthetic timing only). The spike runner
 * validates (P4) that this clock excludes injected network latency before
 * any CPU conclusion is drawn from it.
 */

export interface Env {
  STUB_URL: string;
  ISSUER: string;
  AUDIENCE: string;
  ALLOWED_ORIGINS: string;
  SESSION_SECRET: string;
  SESSION_TTL_S: string;
  STUB_TIMEOUT_MS: string;
  KILL_CACHE_MS: string;
}

interface JwkKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface Jwks {
  keys: JwkKey[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Simulated backend (stub PostgREST) failure — maps to503 (never a crash). */
class BackendError extends Error {
  constructor(
    public kind: "timeout" | "unavailable" | "quota",
  ) {
    super(`backend_${kind}`);
  }
}

/* ---------------- JWKS cache (per isolate) ---------------- */

interface JwksCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  maxAgeMs: number;
  inflight: Promise<void> | null;
}

const jwksCache: JwksCache = {
  keys: new Map(),
  fetchedAt: 0,
  maxAgeMs: 0,
  inflight: null,
};

function stubTimeout(env: Env): number {
  const n = Number(env.STUB_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

async function stubFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  // Realistic PostgREST-style auth header; the value is synthetic and holds
  // no privilege whatsoever (the stub authorizes nothing by it).
  if (!headers.has("apikey")) headers.set("apikey", "spike-synthetic-anon-key");
  return await fetch(env.STUB_URL + path, {
    ...init,
    headers,
    signal: AbortSignal.timeout(stubTimeout(env)),
  });
}

async function refreshJwks(env: Env): Promise<void> {
  if (jwksCache.inflight) {
    await jwksCache.inflight;
    return;
  }
  const run = (async () => {
    let res: Response;
    try {
      res = await stubFetch(env, "/auth/v1/.well-known/jwks.json");
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw new BackendError("timeout");
      throw new BackendError("unavailable");
    }
    if (res.status === 429) throw new BackendError("quota");
    if (!res.ok) throw new BackendError("unavailable");
    const jwks = (await res.json()) as Jwks;
    const maxAgeHeader = res.headers.get("Cache-Control") ?? "";
    const m = /max-age=(\d+)/i.exec(maxAgeHeader);
    const maxAgeMs = m ? Number(m[1]) * 1000 : 300_000;
    const keys = new Map<string, CryptoKey>();
    for (const jwk of jwks.keys) {
      if (jwk.kty !== "RSA" || jwk.use !== "sig" || jwk.alg !== "RS256" || !jwk.kid || !jwk.n || !jwk.e) {
        continue; // ignore anything that is not an RS256 signature key
      }
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    }
    jwksCache.keys = keys;
    jwksCache.maxAgeMs = maxAgeMs;
    jwksCache.fetchedAt = Date.now();
  })().finally(() => {
    jwksCache.inflight = null;
  });
  jwksCache.inflight = run;
  await run;
}

/**
 * AUTH.md §2: key material cached per provider Cache-Control bound; unknown
 * kid with an exhausted cache FAILS CLOSED (one bounded re-fetch attempt for
 * rotation, then deny — never a fall-through to unsigned trust).
 */
async function getKeyForKid(env: Env, kid: string): Promise<CryptoKey> {
  const cacheFresh = Date.now() - jwksCache.fetchedAt < jwksCache.maxAgeMs;
  if (!cacheFresh) await refreshJwks(env);
  const hit = jwksCache.keys.get(kid);
  if (hit) return hit;
  if (cacheFresh) {
    // Cache was fresh but kid unknown → single bounded re-fetch (rotation),
    // then deny if still unknown.
    await refreshJwks(env);
    const again = jwksCache.keys.get(kid);
    if (again) return again;
  }
  throw new HttpError(401, "unauthenticated", "unknown signing key");
}

/* ---------------- JWT verification ---------------- */

interface Claims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
  sid?: unknown;
}

async function verifySupabaseAccessToken(env: Env, token: string): Promise<Claims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "unauthenticated", "malformed token");
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
  } catch {
    throw new HttpError(401, "unauthenticated", "malformed token header");
  }
  // Algorithm allowlist (AUTH.md §2.1): reject `none` and confusion outright.
  if (header.alg !== "RS256") throw new HttpError(401, "unauthenticated", "algorithm not allowed");
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new HttpError(401, "unauthenticated", "kid required");
  }
  const key = await getKeyForKid(env, header.kid);
  const data = enc.encode(parts[0] + "." + parts[1]);
  let sig: Uint8Array;
  try {
    sig = b64urlDecode(parts[2]);
  } catch {
    throw new HttpError(401, "unauthenticated", "malformed signature");
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data as BufferSource);
  if (!ok) throw new HttpError(401, "unauthenticated", "invalid signature");
  let claims: Claims;
  try {
    claims = JSON.parse(dec.decode(b64urlDecode(parts[1])));
  } catch {
    throw new HttpError(401, "unauthenticated", "malformed claims");
  }
  if (claims.iss !== env.ISSUER) throw new HttpError(401, "unauthenticated", "invalid issuer");
  if (claims.aud !== env.AUDIENCE) throw new HttpError(401, "unauthenticated", "invalid audience");
  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // AUTH.md §2.4: bounded clock skew ≤60s
  if (typeof claims.exp !== "number" || now > claims.exp + skew) {
    throw new HttpError(401, "unauthenticated", "token expired");
  }
  if (typeof claims.iat !== "number" || claims.iat > now + skew) {
    throw new HttpError(401, "unauthenticated", "token not yet valid");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new HttpError(401, "unauthenticated", "subject required");
  }
  return claims;
}

/* --- BFF session token (HS256, server-minted; revocable via session row) --- */

let sessionKeyPromise: Promise<CryptoKey> | null = null;

function sessionKey(env: Env): Promise<CryptoKey> {
  if (!sessionKeyPromise) {
    sessionKeyPromise = crypto.subtle.importKey(
      "raw",
      enc.encode(env.SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return sessionKeyPromise;
}

function b64urlJson(o: unknown): string {
  return b64urlEncode(enc.encode(JSON.stringify(o)));
}

async function mintSessionToken(env: Env, sid: string, sub: string): Promise<string> {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const ttl = Number(env.SESSION_TTL_S) || 900;
  const claims = b64urlJson({ sid, sub, exp: Math.floor(Date.now() / 1000) + ttl });
  const key = await sessionKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(header + "." + claims) as BufferSource);
  return header + "." + claims + "." + b64urlEncode(new Uint8Array(sig));
}

async function verifySessionToken(env: Env, token: string): Promise<{ sid: string; sub: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "unauthenticated", "malformed session token");
  let header: { alg?: unknown };
  let claims: Claims;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
    claims = JSON.parse(dec.decode(b64urlDecode(parts[1])));
  } catch {
    throw new HttpError(401, "unauthenticated", "malformed session token");
  }
  if (header.alg !== "HS256") throw new HttpError(401, "unauthenticated", "algorithm not allowed");
  const key = await sessionKey(env);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(parts[2]) as BufferSource,
    enc.encode(parts[0] + "." + parts[1]) as BufferSource,
  );
  if (!ok) throw new HttpError(401, "unauthenticated", "invalid session signature");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now > claims.exp + 60) {
    throw new HttpError(401, "unauthenticated", "session token expired");
  }
  if (typeof claims.sid !== "string" || typeof claims.sub !== "string") {
    throw new HttpError(401, "unauthenticated", "session token claims incomplete");
  }
  return { sid: claims.sid, sub: claims.sub };
}

/* ---------------- cookies / CSRF / origin ---------------- */

function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function requireOriginAndCsrf(env: Env, request: Request): void {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin");
  if (!origin || !allowed.includes(origin)) {
    throw new HttpError(403, "forbidden", "origin not allowed");
  }
  const cookieCsrf = getCookie(request, "csrf");
  const headerCsrf = request.headers.get("x-csrf-token");
  if (!cookieCsrf || !headerCsrf || !timingSafeEqual(cookieCsrf, headerCsrf)) {
    throw new HttpError(403, "forbidden", "csrf token mismatch");
  }
}

/* ---------------- kill switch (write path only,5s cache) ---------------- */

let killCache: { killed: boolean; at: number } = { killed: false, at: 0 };

async function enforceKillSwitch(env: Env): Promise<void> {
  const ttl = Number(env.KILL_CACHE_MS) || 5000;
  if (Date.now() - killCache.at > ttl) {
    let killed = false;
    try {
      const res = await stubFetch(env, "/__kill");
      if (res.ok) killed = ((await res.json()) as { killed?: boolean }).killed === true;
    } catch {
      // Kill-switch lookup failure fails CLOSED for writes (intake off).
      killed = true;
    }
    killCache = { killed, at: Date.now() };
  }
  if (killCache.killed) {
    throw new HttpError(503, "service_unavailable", "intake disabled by kill switch");
  }
}

/* ---------------- stub (simulated Supabase) data access ---------------- */

async function stubGet(env: Env, path: string): Promise<unknown[]> {
  let res: Response;
  try {
    res = await stubFetch(env, path);
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new BackendError("timeout");
    throw new BackendError("unavailable");
  }
  if (res.status === 429) throw new BackendError("quota");
  if (res.status >= 500) throw new BackendError("unavailable");
  if (!res.ok) throw new HttpError(500, "internal", "backend responded unexpectedly");
  return (await res.json()) as unknown[];
}

async function stubPost(env: Env, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await stubFetch(env, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") throw new BackendError("timeout");
    throw new BackendError("unavailable");
  }
  if (res.status === 429) throw new BackendError("quota");
  if (res.status >= 500) throw new BackendError("unavailable");
  if (!res.ok) throw new HttpError(500, "internal", "backend responded unexpectedly");
  return await res.json();
}

interface Principal {
  id: string;
  subject: string;
  state: string;
}

interface SessionRow {
  id: string;
  principal_id: string;
  expires_at: number;
  revoked: boolean;
}

/**
 * AUTH.md §3: authenticate (token valid) → load session (not revoked, not
 * expired) → load principal (not suspended/deleted) → capability check.
 * Any step failing ⇒ deny.
 * `phases` (spike instrumentation) records rough per-stage CPU deltas.
 */
async function authenticate(
  env: Env,
  request: Request,
  phases?: Record<string, number>,
): Promise<{ principal: Principal; capabilities: string[] }> {
  const t0 = performance.now();
  const cookie = getCookie(request, "sid");
  if (!cookie) throw new HttpError(401, "unauthenticated", "missing session");
  const t1 = performance.now();
  const { sid } = await verifySessionToken(env, cookie);
  const t2 = performance.now();
  const sessionRows = await stubGet(env, `/rest/v1/sessions?id=eq.${encodeURIComponent(sid)}`);
  const t3 = performance.now();
  const session = sessionRows[0] as SessionRow | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!session || session.revoked || session.expires_at <= now) {
    throw new HttpError(401, "unauthenticated", "session revoked or expired");
  }
  const principalRows = await stubGet(
    env,
    `/rest/v1/principals?id=eq.${encodeURIComponent(session.principal_id)}`,
  );
  const t4 = performance.now();
  const principal = principalRows[0] as Principal | undefined;
  if (!principal || principal.state === "deleted") {
    throw new HttpError(401, "unauthenticated", "principal not found");
  }
  if (principal.state !== "active") {
    throw new HttpError(403, "forbidden", "account suspended");
  }
  const grantRows = await stubGet(
    env,
    `/rest/v1/principal_capabilities?principal_id=eq.${encodeURIComponent(principal.id)}`,
  );
  const t5 = performance.now();
  if (phases) {
    phases["cookie"] = t1 - t0;
    phases["jwt-hs256"] = t2 - t1;
    phases["stub-session"] = t3 - t2;
    phases["stub-principal"] = t4 - t3;
    phases["stub-grants"] = t5 - t4;
  }
  const capabilities = grantRows.map((r) => (r as { capability: string }).capability);
  return { principal, capabilities };
}

/* ---------------- responses ---------------- */

function securityHeaders(): Headers {
  const h = new Headers();
  h.set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return h;
}

function json(status: number, body: unknown, opts?: { cookies?: string[]; store?: boolean }): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json");
  if (opts?.store === false) headers.set("Cache-Control", "no-store");
  for (const c of opts?.cookies ?? []) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, {
    error: { code, message, requestId: "attached-by-wrapper" },
  });
}

const STATIC_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Goldberg C2 spike — static admin stub</title></head>" +
  "<body><h1>static asset stub</h1><p>Synthetic spike asset. Never deployed.</p></body></html>\n";

/* ---------------- router ---------------- */

async function handle(request: Request, env: Env, phases: Record<string, number>): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // Static asset route (kept alive even when the backend is down — S15).
  if (method === "GET" && (path === "/" || path === "/index.html")) {
    const headers = securityHeaders();
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(STATIC_HTML, { status: 200, headers });
  }
  if (method === "GET" && path === "/health") {
    return json(200, { ok: true });
  }

  if (!path.startsWith("/v1/")) return errorResponse(404, "not_found", "unknown route");

  const stateChanging = method === "POST" || method === "DELETE" || method === "PATCH" || method === "PUT";

  // Sign-in handover: consumes a Supabase-issued access token (API-CONTRACTS
  // §3). The browser's Google flow itself remains managed Supabase Auth and
  // is out of spike scope.
  if (method === "POST" && path === "/v1/session") {
    let body: { access_token?: unknown };
    try {
      body = (await request.json()) as { access_token?: unknown };
    } catch {
      return errorResponse(400, "validation_failed", "malformed JSON body");
    }
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      return errorResponse(400, "validation_failed", "access_token required");
    }
    const claims = await verifySupabaseAccessToken(env, body.access_token);
    const subject = claims.sub as string;
    const principalRows = await stubGet(env, `/rest/v1/principals?subject=eq.${encodeURIComponent(subject)}`);
    const principal = principalRows[0] as Principal | undefined;
    if (!principal) throw new HttpError(403, "forbidden", "unknown principal");
    if (principal.state !== "active") throw new HttpError(403, "forbidden", "account suspended");
    const row = (await stubPost(env, "/rest/v1/sessions", {
      principal_id: principal.id,
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + (Number(env.SESSION_TTL_S) || 900),
      revoked: false,
    })) as { id: string };
    const sidToken = await mintSessionToken(env, row.id, subject);
    const grantRows = await stubGet(
      env,
      `/rest/v1/principal_capabilities?principal_id=eq.${encodeURIComponent(principal.id)}`,
    );
    const capabilities = grantRows.map((r) => (r as { capability: string }).capability);
    return json(
      200,
      { principalId: principal.id, capabilities },
      {
        store: false,
        cookies: [
          `sid=${sidToken}; HttpOnly; Secure; SameSite=Strict; Path=/`,
          `csrf=${b64urlEncode(enc.encode(crypto.randomUUID()))}; Secure; SameSite=Strict; Path=/`,
        ],
      },
    );
  }

  // Logout: CSRF+origin protected, idempotent, immediate server-side revoke.
  if (method === "DELETE" && path === "/v1/session") {
    requireOriginAndCsrf(env, request); // throws HttpError on failure
    const cookie = getCookie(request, "sid");
    if (cookie) {
      const { sid } = await verifySessionToken(env, cookie).catch(() => ({ sid: null }));
      if (sid) await stubFetch(env, `/rest/v1/sessions?id=eq.${encodeURIComponent(sid)}`, { method: "DELETE" });
    }
    return json(
      200,
      { ok: true },
      {
        store: false,
        cookies: [
          "sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
          "csrf=; Secure; SameSite=Strict; Path=/; Max-Age=0",
        ],
      },
    );
  }

  if (stateChanging) {
    requireOriginAndCsrf(env, request); // throws HttpError on failure
    await enforceKillSwitch(env);
  }

  // Authenticated routes.
  const { principal, capabilities } = await authenticate(env, request, phases);
  const has = (cap: string) => capabilities.includes(cap);

  if (method === "GET" && path === "/v1/me/capabilities") {
    return json(200, { principalId: principal.id, capabilities }, { store: false });
  }

  if (method === "GET" && path === "/v1/admin/queue") {
    if (!has("admin:queue_read")) throw new HttpError(403, "forbidden", "capability denied");
    const t0 = performance.now();
    const queue = await stubGet(env, "/rest/v1/decisions");
    phases["stub-queue"] = performance.now() - t0;
    return json(200, { queue }, { store: false });
  }

  if (method === "POST" && path === "/v1/admin/decisions") {
    if (!has("admin:decide")) throw new HttpError(403, "forbidden", "capability denied");
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, "validation_failed", "malformed JSON body");
    }
    // Allowlist validation (API-CONTRACTS §4/THREAT-MODEL T6/T13 rehearsal):
    const allowedKeys = new Set(["schemaVersion", "submissionId", "decision", "note"]);
    for (const k of Object.keys(body)) {
      if (!allowedKeys.has(k)) return errorResponse(400, "validation_failed", `unknown field: ${k}`);
    }
    if (body.schemaVersion !== 1 || typeof body.submissionId !== "string" || typeof body.decision !== "string") {
      return errorResponse(400, "validation_failed", "invalid decision payload");
    }
    const created = await stubPost(env, "/rest/v1/decisions", {
      submission_id: body.submissionId,
      decision: body.decision,
      actor_principal_id: principal.id,
    });
    return json(201, { decision: created }, { store: false });
  }

  return errorResponse(404, "not_found", "unknown route");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const t0 = performance.now(); // runtime CPU clock (not Date.now)
    const phases: Record<string, number> = {};
    let response: Response;
    try {
      response = await handle(request, env, phases);
    } catch (e) {
      if (e instanceof HttpError) {
        response = errorResponse(e.status, e.code, e.message);
      } else if (e instanceof BackendError) {
        // T20: truthful503, never fake success, never leak internals.
        response = errorResponse(503, "service_unavailable", `backend ${e.kind}`);
      } else {
        response = errorResponse(500, "internal", "unexpected error");
      }
    }
    const cpuMs = performance.now() - t0;
    const out = new Headers(response.headers);
    out.set("x-spike-cpu-ms", cpuMs.toFixed(3));
    if (Object.keys(phases).length > 0) {
      // Spike instrumentation (timings only — no privileged data).
      out.set(
        "x-spike-phases",
        Object.entries(phases)
          .map(([k, v]) => `${k}=${v.toFixed(2)}`)
          .join(","),
      );
    }
    out.set("x-spike-request-id", crypto.randomUUID());
    return new Response(response.body, { status: response.status, headers: out });
  },
};
