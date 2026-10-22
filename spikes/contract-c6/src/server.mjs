// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: the contract server.
//
// A minimal, disposable, IN-PROCESS simulator of the Stage 6 `/v1` contract
// (API-CONTRACTS.md, DATA-MODEL.md §2–§6) against an isolated local SQLite
// database. Synthetic identities, fake sessions, fake clock, zero network,
// zero npm dependencies. This is NOT the production server: no HTTP transport,
// no real auth provider, no Supabase/Postgres engine. HTTP/CSRF/CORS/token
// behavior was covered by the C2 spike (S1–S19); this layer verifies the
// business-logic contract above it.
//
// THREAT-MODEL rows exercised here (all [L] venue): T5, T6, T7, T8, T10, T11,
// T12, T13, T14 (static portion), T16, T17, T18 (local chain), T22.

import { createHash } from 'node:crypto';
import { resolveSession, requireCapability } from './auth.mjs';
import { validateEnvelope, validatePayload, validateReason, UUID_RE } from './validate.mjs';

const PENDING_STATUSES = ['submitted', 'in_review', 'changes_requested'];
const DECIDABLE_STATUSES = PENDING_STATUSES;
const TERMINAL_DECIDED = ['published', 'approved', 'rejected', 'withdrawn'];
const SESSION_TTL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAILY_SUBMISSIONS = 5;
const MAX_PENDING = 10;
const PAGE_LIMIT = 20;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Hash-chained audit (DATA-MODEL.md §6): append-only, tamper-evident.
// ---------------------------------------------------------------------------
function appendAudit(db, now, actorId, action, subject, payload) {
  const last = db
    .prepare('SELECT seq, this_hash FROM audit_events ORDER BY seq DESC LIMIT 1')
    .get();
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.this_hash ?? 'GENESIS';
  const payloadHash = sha256(canonical(payload ?? null));
  const thisHash = sha256(
    `${seq}|${now}|${actorId}|${action}|${subject}|${payloadHash}|${prevHash}`
  );
  db.prepare(
    'INSERT INTO audit_events (seq, ts, actor_id, action, subject, payload_hash, prev_hash, this_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(seq, now, actorId, action, subject, payloadHash, prevHash, thisHash);
  return seq;
}

export function verifyChain(db) {
  const rows = db
    .prepare(
      'SELECT seq, ts, actor_id, action, subject, payload_hash, prev_hash, this_hash FROM audit_events ORDER BY seq ASC'
    )
    .all();
  let prev = 'GENESIS';
  for (const r of rows) {
    const recomputed = sha256(
      `${r.seq}|${r.ts}|${r.actor_id}|${r.action}|${r.subject}|${r.payload_hash}|${prev}`
    );
    if (r.prev_hash !== prev || r.this_hash !== recomputed) {
      return { ok: false, atSeq: r.seq };
    }
    prev = r.this_hash;
  }
  return { ok: true, count: rows.length };
}

// ---------------------------------------------------------------------------
// Per-route request-body allowlist (API-CONTRACTS.md §1: unknown request
// fields are rejected by the server, never stripped with effect).
// ---------------------------------------------------------------------------
function allowedKeysFor(method, path) {
  if (method !== 'POST') return null;
  if (path === '/v1/session') return ['schemaVersion', 'credential'];
  if (path === '/v1/submissions') return ['schemaVersion', 'payload', 'idempotencyKey'];
  if (/^\/v1\/submissions\/[^/]+\/revisions$/.test(path))
    return ['schemaVersion', 'payload', 'idempotencyKey'];
  if (/^\/v1\/submissions\/[^/]+\/withdraw$/.test(path))
    return ['schemaVersion', 'reason', 'idempotencyKey'];
  if (/\/decisions$/.test(path))
    return ['schemaVersion', 'decision', 'expectedRevision', 'reason', 'idempotencyKey'];
  if (/\/roles$/.test(path)) return ['schemaVersion', 'action', 'role'];
  if (/\/suspend$/.test(path)) return ['schemaVersion', 'suspended'];
  if (/\/quarantine$/.test(path)) return ['schemaVersion', 'reason', 'idempotencyKey'];
  return null;
}

function cmpIds(cursorId, rowId) {
  const norm = (v) => (/^\d+$/.test(String(v)) ? Number(v) : String(v));
  const a = norm(cursorId);
  const b = norm(rowId);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
export function createServer({ db, now }) {
  let requestCounter = 0;
  let sessionCounter = 0;
  let faultAt = null; // one-shot fault injection point inside the approval tx

  const state = {
    injectFault(step) {
      faultAt = step;
    },
    faultPending() {
      return faultAt;
    },
  };

  function nextRequestId() {
    requestCounter += 1;
    return `req_${String(requestCounter).padStart(6, '0')}`;
  }

  function fault(step) {
    if (faultAt === step) {
      faultAt = null;
      throw new Error(`injected fault at ${step}`);
    }
  }

  const res = (status, body) => ({ status, body });
  function err(status, code, message, details) {
    return res(
      status,
      details === undefined ? { error: { code, message } } : { error: { code, message, details } }
    );
  }

  const auditNow = (actor, action, subject, payload) =>
    appendAudit(db, now(), actor, action, subject, payload);

  // -- idempotency ----------------------------------------------------------
  function checkIdempotency(principalId, key, method, path, body) {
    const requestHash = sha256(`${method}|${path}|${canonical(body)}`);
    const expiryCutoff = now() - DAY_MS;
    db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(expiryCutoff);
    const row = db
      .prepare(
        'SELECT request_hash, status_code, response_json FROM idempotency WHERE principal_id = ? AND key = ?'
      )
      .get(principalId, key);
    if (!row) return { requestHash };
    if (row.request_hash !== requestHash) {
      throw new HttpError(
        422,
        'idempotency_mismatch',
        'Idempotency key reused with a different request body'
      );
    }
    return { replay: { status: row.status_code, body: JSON.parse(row.response_json) } };
  }

  function storeIdempotency(principalId, key, method, path, body, status, responseBody) {
    if (key === undefined || principalId === null) return;
    db.prepare(
      'INSERT INTO idempotency (principal_id, key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      principalId,
      key,
      sha256(`${method}|${path}|${canonical(body)}`),
      status,
      JSON.stringify(responseBody),
      now()
    );
  }

  // -- paging (deterministic (created_at, id) ordering, cursor pagination) --
  function paginate(rows, cursor, limitRaw) {
    let limit = Number(limitRaw ?? PAGE_LIMIT);
    if (!Number.isInteger(limit) || limit < 1) limit = PAGE_LIMIT;
    if (limit > PAGE_LIMIT) limit = PAGE_LIMIT;
    const sorted = [...rows].sort(
      (a, b) => a.created_at - b.created_at || cmpIds(a.id ?? a.seq, b.id ?? b.seq)
    );
    let filtered = sorted;
    if (cursor) {
      const sep = cursor.lastIndexOf(':');
      const cAt = Number(cursor.slice(0, sep));
      const cId = cursor.slice(sep + 1);
      filtered = sorted.filter(
        (r) =>
          cAt < r.created_at ||
          (cAt === r.created_at && cmpIds(cId, r.id ?? r.seq) < 0)
      );
    }
    const items = filtered.slice(0, limit);
    const last = items.at(-1);
    const nextCursor =
      filtered.length > items.length && last ? `${last.created_at}:${last.id ?? last.seq}` : null;
    return { items, nextCursor };
  }

  // -- approval decision transaction (DATA-MODEL.md §4 canonical order) -----
  function runDecision(actor, subId, body) {
    const { decision, expectedRevision, reason } = body;
    const ts = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      // 1. authorize (middleware: role + non-suspension) + actor≠author
      const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(subId);
      if (!sub) throw new HttpError(404, 'not_found', 'No such submission');
      if (sub.principal_id === actor.id)
        throw new HttpError(403, 'forbidden', 'Actor cannot decide on own submission (actor≠author)');

      // 2. lock + compare status + expectedRevision
      if (TERMINAL_DECIDED.includes(sub.status) || !DECIDABLE_STATUSES.includes(sub.status)) {
        throw new HttpError(409, 'conflict', 'Submission not decidable', {
          currentStatus: sub.status,
          currentRevision: sub.revision,
        });
      }
      if (expectedRevision !== sub.revision) {
        throw new HttpError(409, 'conflict', 'Stale expectedRevision', {
          currentStatus: sub.status,
          currentRevision: sub.revision,
        });
      }

      // 3. re-validate stored payload schema, evidence URLs, license intent
      const payload = JSON.parse(sub.payload_json);
      const payloadErrors = validatePayload(payload);
      if (payloadErrors.length > 0)
        throw new HttpError(
          400,
          'validation_failed',
          'Stored payload failed revalidation',
          payloadErrors
        );

      let newStatus;
      let publishedRevisionId = null;
      let entityUuid = null;

      if (decision === 'approve') {
        fault('before_publish_row');
        // 4. published_revisions + published_entities upsert
        entityUuid = payload.target.catalogueUuid ?? `ent_${subId}`;
        const existing = db.prepare('SELECT uuid FROM published_entities WHERE uuid = ?').get(entityUuid);
        db.prepare(
          'INSERT INTO published_revisions (entity_uuid, submission_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(entityUuid, sub.id, sub.revision, sub.payload_json, ts);
        publishedRevisionId = db.prepare('SELECT MAX(id) AS id FROM published_revisions').get().id;
        if (existing) {
          db.prepare('UPDATE published_entities SET current_revision_id = ?, updated_at = ? WHERE uuid = ?').run(
            publishedRevisionId,
            ts,
            entityUuid
          );
        } else {
          db.prepare(
            'INSERT INTO published_entities (uuid, kind, current_revision_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(entityUuid, payload.target.kind, publishedRevisionId, 'published', ts, ts);
        }
        // 6a. change-feed entry
        db.prepare(
          'INSERT INTO change_feed (kind, entity_uuid, revision_ref, provenance, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run('published', entityUuid, publishedRevisionId, `submission:${sub.id}#${sub.revision}`, ts);
        fault('after_publish_row'); // T17 rollback point
        newStatus = 'published';
      } else if (decision === 'reject') {
        newStatus = 'rejected';
      } else {
        newStatus = 'changes_requested'; // request_changes (validated by caller)
      }

      // 5. advance status + review event
      db.prepare('UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, ts, sub.id);
      db.prepare(
        'INSERT INTO review_events (submission_id, revision, decision, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sub.id, sub.revision, decision, actor.id, reason ?? null, ts);

      // 6b. hash-chained audit append
      auditNow(actor.id, `decision.${decision}`, `submission:${sub.id}`, {
        revision: sub.revision,
        reason: reason ?? null,
      });

      // 7. commit
      db.exec('COMMIT');
      return res(201, {
        submissionId: sub.id,
        decision,
        status: newStatus,
        revision: sub.revision,
        ...(publishedRevisionId ? { publishedRevisionId, entityUuid } : {}),
      });
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* no open tx */
      }
      if (e instanceof HttpError) return err(e.status, e.code, e.message, e.details);
      return err(500, 'internal', 'Internal error — partial failure rolled back server-side');
    }
  }

  // -- quotas ---------------------------------------------------------------
  function checkSubmissionQuotas(principalId) {
    const day = Math.floor(now() / DAY_MS);
    const counter = db
      .prepare('SELECT submissions_count FROM quota_counters WHERE principal_id = ? AND day = ?')
      .get(principalId, String(day));
    if ((counter?.submissions_count ?? 0) >= MAX_DAILY_SUBMISSIONS) {
      return err(429, 'rate_limited', 'Daily submission quota exhausted', { retryAfter: 3600 });
    }
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS c FROM submissions WHERE principal_id = ? AND status IN ('submitted','in_review','changes_requested')"
      )
      .get(principalId);
    if (pending.c >= MAX_PENDING) {
      return err(429, 'rate_limited', 'Pending submission quota exhausted', { retryAfter: 3600 });
    }
    return null;
  }

  function bumpSubmissionQuota(principalId) {
    const day = Math.floor(now() / DAY_MS);
    db.prepare(
      'INSERT INTO quota_counters (principal_id, day, submissions_count) VALUES (?, ?, 1) ON CONFLICT(principal_id, day) DO UPDATE SET submissions_count = submissions_count + 1'
    ).run(principalId, String(day));
  }

  function killSwitchOn() {
    return db.prepare("SELECT value FROM config WHERE key = 'kill_switch'").get()?.value === 'on';
  }

  // -- route table ----------------------------------------------------------
  // [method, pathRegex, auth|null, capability|null, isWrite]
  const ROUTES = [
    ['POST', /^\/v1\/session$/, null, null, true],
    ['DELETE', /^\/v1\/session$/, null, null, true], // idempotent no-op when already revoked
    ['GET', /^\/v1\/me\/capabilities$/, 'session', null, false],
    ['POST', /^\/v1\/submissions$/, 'session', 'submit', true],
    ['GET', /^\/v1\/submissions\/mine$/, 'session', 'submit', false],
    ['GET', /^\/v1\/submissions\/([A-Za-z0-9_-]+)$/, 'session', 'submit', false],
    ['POST', /^\/v1\/submissions\/([A-Za-z0-9_-]+)\/revisions$/, 'session', 'submit', true],
    ['POST', /^\/v1\/submissions\/([A-Za-z0-9_-]+)\/withdraw$/, 'session', 'submit', true],
    ['GET', /^\/v1\/catalogue\/overlay$/, null, null, false],
    ['GET', /^\/v1\/catalogue\/changes$/, null, null, false],
    ['GET', /^\/v1\/admin\/queue$/, 'session', 'queue.read', false],
    ['GET', /^\/v1\/admin\/submissions\/([A-Za-z0-9_-]+)$/, 'session', 'queue.read', false],
    ['POST', /^\/v1\/admin\/submissions\/([A-Za-z0-9_-]+)\/decisions$/, 'session', 'decide', true],
    ['GET', /^\/v1\/admin\/audit$/, 'session', 'audit.read', false],
    ['POST', /^\/v1\/admin\/principals\/([A-Za-z0-9_-]+)\/roles$/, 'session', 'roles.manage', true],
    ['POST', /^\/v1\/admin\/principals\/([A-Za-z0-9_-]+)\/suspend$/, 'session', 'roles.manage', true],
    ['POST', /^\/v1\/admin\/entities\/([A-Za-z0-9_-]+)\/quarantine$/, 'session', 'quarantine', true],
  ];

  const listRoutes = () => ROUTES.map(([m, re]) => `${m} ${re.source}`);

  function handle(req) {
    const requestId = nextRequestId();
    const result = route(req);
    if (result.body.error) {
      return { status: result.status, body: { error: { ...result.body.error, requestId } } };
    }
    return { status: result.status, body: { requestId, ...result.body } };
  }

  function route(req) {
    const { method, path, query = {}, body = {}, session } = req ?? {};
    const matched = ROUTES.find(([m, re]) => m === method && re.test(path ?? ''));
    if (!matched) return err(404, 'not_found', 'Unknown endpoint');
    const [, pathRe, auth, capability, isWrite] = matched;
    const m = pathRe.exec(path);

    // --- authentication / authorization (default-deny) ---
    let actor = null;
    if (auth === 'session') {
      const resolved = resolveSession(db, session, now());
      const gate = capability ? requireCapability(resolved, capability) : resolved;
      if (gate.error) return err(gate.error.status, gate.error.code, gate.error.message);
      actor = gate.principal;
    }

    // --- envelope + body allowlist for every POST ---
    if (method === 'POST') {
      const envErrors = validateEnvelope(body);
      if (envErrors.length > 0)
        return err(400, 'validation_failed', 'Request envelope validation failed', envErrors);
      const allowed = allowedKeysFor(method, path);
      if (allowed) {
        const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
        if (unknown.length > 0)
          return err(400, 'validation_failed', 'Unknown request field rejected', [
            `${unknown.join(', ')}: unknown field rejected (allowlist)`,
          ]);
      }
    }

    // --- global intake kill switch (writes only; reads continue) ---
    if (isWrite && path !== '/v1/session' && killSwitchOn()) {
      return err(503, 'service_unavailable', 'Intake disabled by kill switch', { retryAfter: 60 });
    }

    // --- idempotency: replay / mismatch / store-on-success (central) ---
    const key = method === 'POST' ? body.idempotencyKey : undefined;
    let idem = null;
    if (key !== undefined && path !== '/v1/session') {
      if (!UUID_RE.test(key))
        return err(400, 'validation_failed', 'idempotencyKey: must be a UUID');
      try {
        idem = checkIdempotency(actor.id, key, method, path, body);
      } catch (e) {
        // T12: key reuse with a different body is a 422 contract response,
        // never an unhandled server error.
        if (e instanceof HttpError) return err(e.status, e.code, e.message, e.details);
        throw e;
      }
      if (idem.replay) return res(idem.replay.status, idem.replay.body);
    }

    const result = dispatch();

    if (key !== undefined && path !== '/v1/session' && result.status >= 200 && result.status < 300) {
      storeIdempotency(actor.id, key, method, path, body, result.status, result.body);
    }
    return result;

    // -------------------------------------------------------------------------
    function dispatch() {
      // ============ POST /v1/session (fake Google credential) ===============
      if (path === '/v1/session' && method === 'POST') {
        const credential = body.credential;
        if (typeof credential !== 'string' || !credential.startsWith('synthetic:'))
          return err(400, 'validation_failed', 'credential: expected synthetic:<principalId>');
        const principalId = credential.slice('synthetic:'.length);
        const principal = db
          .prepare('SELECT id, display_name, roles, suspended FROM principals WHERE id = ?')
          .get(principalId);
        if (!principal) return err(401, 'unauthenticated', 'Credential verification failed');
        if (principal.suspended === 1) return err(403, 'forbidden', 'Principal is suspended');
        sessionCounter += 1;
        const sid = `sess_${String(sessionCounter).padStart(6, '0')}`;
        db.prepare('INSERT INTO sessions (sid, principal_id, expires_at) VALUES (?, ?, ?)').run(
          sid,
          principalId,
          now() + SESSION_TTL_MS
        );
        auditNow(principalId, 'session.created', `session:${sid}`, null);
        return res(201, {
          sid,
          principalId,
          displayName: principal.display_name,
          roles: JSON.parse(principal.roles),
        });
      }

      // ============ DELETE /v1/session (literal contract idempotency) ========
      if (path === '/v1/session' && method === 'DELETE') {
        if (typeof session === 'string') db.prepare('DELETE FROM sessions WHERE sid = ?').run(session);
        return res(200, { revoked: true });
      }

      // ============ GET /v1/me/capabilities ================
      if (path === '/v1/me/capabilities') {
        return res(200, {
          principalId: actor.id,
          capabilities: [...actor.capabilities].sort(),
          note: 'UI convenience only — never an authorization source',
        });
      }

      // ============ POST /v1/submissions ====================
      if (path === '/v1/submissions' && method === 'POST') {
        const quota = checkSubmissionQuotas(actor.id);
        if (quota) return quota;
        const errors = validatePayload(body.payload);
        if (errors.length > 0)
          return err(400, 'validation_failed', 'Submission payload validation failed', errors);
        const count = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
        const id = `sub_${String(count + 1).padStart(6, '0')}`;
        const ts = now();
        db.prepare(
          'INSERT INTO submissions (id, principal_id, status, revision, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, actor.id, 'submitted', 1, JSON.stringify(body.payload), ts, ts);
        db.prepare(
          'INSERT INTO revisions (submission_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)'
        ).run(id, 1, JSON.stringify(body.payload), ts);
        bumpSubmissionQuota(actor.id);
        auditNow(actor.id, 'submission.created', `submission:${id}`, { revision: 1 });
        return res(201, { submissionId: id, status: 'submitted', revision: 1 });
      }

      // ============ GET /v1/submissions/mine =================
      if (path === '/v1/submissions/mine') {
        const rows = db.prepare('SELECT * FROM submissions WHERE principal_id = ?').all(actor.id);
        const { items, nextCursor } = paginate(
          rows.map((r) => ({
            id: r.id,
            status: r.status,
            revision: r.revision,
            created_at: r.created_at,
          })),
          query.cursor,
          query.limit
        );
        return res(200, { items, nextCursor });
      }

      // ============ GET /v1/submissions/{id} (existence-hidden) ==============
      if (path.startsWith('/v1/submissions/') && method === 'GET') {
        const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(m[1]);
        if (!sub) return err(404, 'not_found', 'No such submission');
        const isOwner = sub.principal_id === actor.id;
        const isModerator = actor.capabilities.has('queue.read');
        if (!isOwner && !isModerator)
          return err(404, 'not_found', 'No such submission'); // existence-hidden
        return res(200, {
          id: sub.id,
          owner: sub.principal_id,
          status: sub.status,
          revision: sub.revision,
          payload: JSON.parse(sub.payload_json),
          createdAt: sub.created_at,
        });
      }

      // ============ POST /v1/submissions/{id}/revisions =======================
      if (path.endsWith('/revisions') && method === 'POST') {
        const id = m[1];
        const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
        if (!sub || sub.principal_id !== actor.id)
          return err(404, 'not_found', 'No such submission'); // existence-hidden for non-owners
        if (!['draft', 'changes_requested', 'returned'].includes(sub.status))
          return err(409, 'conflict', 'Revisions only in draft/changes_requested/returned', {
            currentStatus: sub.status,
            currentRevision: sub.revision,
          });
        const errors = validatePayload(body.payload);
        if (errors.length > 0)
          return err(400, 'validation_failed', 'Revision payload validation failed', errors);
        const ts = now();
        const newRevision = sub.revision + 1;
        db.prepare(
          'INSERT INTO revisions (submission_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)'
        ).run(id, newRevision, JSON.stringify(body.payload), ts);
        db.prepare(
          'UPDATE submissions SET revision = ?, status = ?, payload_json = ?, updated_at = ? WHERE id = ?'
        ).run(newRevision, 'in_review', JSON.stringify(body.payload), ts, id);
        auditNow(actor.id, 'revision.created', `submission:${id}`, { revision: newRevision });
        return res(201, { submissionId: id, revision: newRevision, status: 'in_review' });
      }

      // ============ POST /v1/submissions/{id}/withdraw ========================
      if (path.endsWith('/withdraw') && method === 'POST') {
        const id = m[1];
        const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
        if (!sub || sub.principal_id !== actor.id)
          return err(404, 'not_found', 'No such submission');
        if (!['submitted', 'in_review'].includes(sub.status))
          return err(409, 'conflict', 'Withdrawal only pre-approval', {
            currentStatus: sub.status,
            currentRevision: sub.revision,
          });
        const reasonErrors = validateReason(body.reason);
        if (reasonErrors.length > 0)
          return err(400, 'validation_failed', 'reason validation failed', reasonErrors);
        const ts = now();
        db.prepare('UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?').run(
          'withdrawn',
          ts,
          id
        );
        auditNow(actor.id, 'submission.withdrawn', `submission:${id}`, { reason: body.reason ?? null });
        return res(200, { submissionId: id, status: 'withdrawn' });
      }

      // ============ public reads ============================================
      if (path === '/v1/catalogue/overlay') {
        const entities = db
          .prepare(
            "SELECT rowid AS id, * FROM published_entities WHERE status = 'published' ORDER BY created_at, rowid"
          )
          .all();
        const { items, nextCursor } = paginate(entities, query.cursor, query.limit);
        return res(200, {
          items: items.map((e) => {
            const rev = db
              .prepare('SELECT payload_json FROM published_revisions WHERE id = ?')
              .get(e.current_revision_id);
            const payload = JSON.parse(rev.payload_json);
            const title = payload.fields?.find((f) => f.field === 'title')?.newValue ?? e.uuid;
            return {
              kind: e.kind,
              uuid: e.uuid,
              title,
              provenance: `revision:${e.current_revision_id}`,
              revision: e.current_revision_id,
            };
          }),
          nextCursor,
        });
      }

      if (path === '/v1/catalogue/changes') {
        const rows = db.prepare('SELECT * FROM change_feed ORDER BY created_at, id').all();
        const { items, nextCursor } = paginate(rows, query.cursor, query.limit);
        return res(200, {
          items: items.map((c) => ({
            kind: c.kind,
            entityUuid: c.entity_uuid,
            revision: c.revision_ref,
            provenance: c.provenance,
          })),
          nextCursor,
        });
      }

      // ============ admin queue / detail =====================================
      if (path === '/v1/admin/queue') {
        const statuses = query.status ? [query.status] : PENDING_STATUSES;
        const placeholders = statuses.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT * FROM submissions WHERE status IN (${placeholders})`)
          .all(...statuses);
        const { items, nextCursor } = paginate(rows, query.cursor, query.limit);
        return res(200, {
          items: items.map((s) => {
            const payload = JSON.parse(s.payload_json);
            return {
              id: s.id,
              owner: s.principal_id,
              status: s.status,
              revision: s.revision,
              evidenceCount: (payload.fields ?? []).reduce((n, f) => n + (f.evidence?.length ?? 0), 0),
              createdAt: s.created_at,
            };
          }),
          nextCursor,
        });
      }

      if (path.startsWith('/v1/admin/submissions/') && method === 'GET') {
        const id = m[1];
        const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
        if (!sub) return err(404, 'not_found', 'No such submission');
        const revisions = db
          .prepare('SELECT revision, payload_json, created_at FROM revisions WHERE submission_id = ? ORDER BY revision')
          .all(id);
        const events = db
          .prepare('SELECT revision, decision, actor_id, reason, created_at FROM review_events WHERE submission_id = ? ORDER BY id')
          .all(id);
        return res(200, {
          id: sub.id,
          owner: sub.principal_id,
          status: sub.status,
          revision: sub.revision,
          revisions: revisions.map((r) => ({
            revision: r.revision,
            payload: JSON.parse(r.payload_json),
            createdAt: r.created_at,
          })),
          reviewEvents: events,
        });
      }

      // ============ decisions ===============================================
      if (path.endsWith('/decisions') && method === 'POST') {
        if (body.idempotencyKey === undefined)
          return err(400, 'validation_failed', 'idempotencyKey: required for decisions');
        if (!['approve', 'reject', 'request_changes'].includes(body.decision))
          return err(400, 'validation_failed', 'decision: must be approve | reject | request_changes');
        if (!Number.isInteger(body.expectedRevision))
          return err(400, 'validation_failed', 'expectedRevision: required integer');
        const reasonErrors = validateReason(body.reason);
        if (reasonErrors.length > 0)
          return err(400, 'validation_failed', 'reason validation failed', reasonErrors);
        return runDecision(actor, m[1], body);
      }

      // ============ audit export (append-only view) =========================
      if (path === '/v1/admin/audit') {
        const rows = db
          .prepare('SELECT seq, ts, actor_id, action, subject, prev_hash, this_hash FROM audit_events ORDER BY seq')
          .all();
        const { items, nextCursor } = paginate(
          rows.map((r) => ({ ...r, created_at: r.ts })),
          query.cursor,
          query.limit
        );
        return res(200, {
          items: items.map((r) => ({
            seq: r.seq,
            ts: r.ts,
            actor: r.actor_id,
            action: r.action,
            subject: r.subject,
            prevHash: r.prev_hash,
            thisHash: r.this_hash,
          })),
          nextCursor,
          chainHead: rows.at(-1)?.this_hash ?? null,
        });
      }

      // ============ roles (no self-grant) ====================================
      if (path.endsWith('/roles') && method === 'POST') {
        const targetId = m[1];
        if (targetId === actor.id)
          return err(403, 'forbidden', 'Self role modification is forbidden (no self-grant)');
        if (!['grant', 'revoke'].includes(body.action))
          return err(400, 'validation_failed', 'action: must be grant | revoke');
        if (!['moderator', 'admin'].includes(body.role))
          return err(400, 'validation_failed', 'role: must be moderator | admin');
        const target = db.prepare('SELECT * FROM principals WHERE id = ?').get(targetId);
        if (!target) return err(404, 'not_found', 'No such principal');
        let roles = JSON.parse(target.roles);
        if (body.action === 'grant' && !roles.includes(body.role)) roles.push(body.role);
        if (body.action === 'revoke') roles = roles.filter((r) => r !== body.role);
        db.prepare('UPDATE principals SET roles = ? WHERE id = ?').run(JSON.stringify(roles), targetId);
        auditNow(actor.id, `role.${body.action}`, `principal:${targetId}`, { role: body.role, roles });
        return res(200, { principalId: targetId, roles });
      }

      // ============ suspend ==================================================
      if (path.endsWith('/suspend') && method === 'POST') {
        const targetId = m[1];
        if (targetId === actor.id)
          return err(403, 'forbidden', 'Self suspension is forbidden (spike interpretation of T22)');
        if (typeof body.suspended !== 'boolean')
          return err(400, 'validation_failed', 'suspended: required boolean');
        const target = db.prepare('SELECT * FROM principals WHERE id = ?').get(targetId);
        if (!target) return err(404, 'not_found', 'No such principal');
        db.prepare('UPDATE principals SET suspended = ? WHERE id = ?').run(body.suspended ? 1 : 0, targetId);
        auditNow(
          actor.id,
          body.suspended ? 'principal.suspended' : 'principal.unsuspended',
          `principal:${targetId}`,
          null
        );
        return res(200, { principalId: targetId, suspended: body.suspended });
      }

      // ============ quarantine (admin) =======================================
      if (path.endsWith('/quarantine') && method === 'POST') {
        if (body.idempotencyKey === undefined)
          return err(400, 'validation_failed', 'idempotencyKey: required for quarantine');
        if (body.reason === undefined || validateReason(body.reason).length > 0)
          return err(400, 'validation_failed', 'reason: required', ['reason: required']);
        const uuid = m[1];
        const entity = db.prepare('SELECT * FROM published_entities WHERE uuid = ?').get(uuid);
        if (!entity) return err(404, 'not_found', 'No such entity');
        if (entity.status === 'quarantined')
          return err(409, 'conflict', 'Entity already quarantined', { currentStatus: entity.status });
        const ts = now();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE published_entities SET status = ?, updated_at = ? WHERE uuid = ?').run(
            'quarantined',
            ts,
            uuid
          );
          db.prepare(
            'INSERT INTO change_feed (kind, entity_uuid, revision_ref, provenance, created_at) VALUES (?, ?, ?, ?, ?)'
          ).run('quarantined', uuid, entity.current_revision_id, `admin:${actor.id}`, ts);
          auditNow(actor.id, 'entity.quarantined', `entity:${uuid}`, { reason: body.reason });
          db.exec('COMMIT');
          return res(200, { entityUuid: uuid, status: 'quarantined' });
        } catch (e) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* no open tx */
          }
          if (e instanceof HttpError) return err(e.status, e.code, e.message, e.details);
          return err(500, 'internal', 'Internal error — partial failure rolled back server-side');
        }
      }

      return err(404, 'not_found', 'Unknown endpoint');
    }
  }

  return { handle, listRoutes, state, db };
}
