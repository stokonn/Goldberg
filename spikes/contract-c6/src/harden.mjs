// Goldberg 0.11 Stage 6 — C6-PG CONCURRENCY HARDENING (EXPERIMENTAL).
//
// ⚠ EXPERIMENTAL MITIGATION SPIKE — NOT PRODUCTION CODE, NEVER MERGED. This
// module exists only on the isolated spike branch and exists solely to compare
// two candidate mitigations for findings F1/F3/F4 (see results/SUMMARY-PG.md):
//
//   F1 (READ COMMITTED): the faithful decision transaction (src/server.mjs
//   runDecision) re-reads nothing after its plain SELECT, so two concurrent
//      moderators can BOTH commit (double-approve), or the loser fails with an
//   unhandled 23505 → HTTP 500 instead of the contract's 409.
//   F3: a concurrent duplicate idempotency INSERT raises 23505 → HTTP 500
//   instead of serving the stored replay.
//   F4: the in-transaction "read last audit seq" append races (23505 on the
//   audit_events seq PK).
//
// Two strategies are implemented over the SAME decision step sequence
// (mirroring src/server.mjs runDecision steps 1–7 exactly):
//
//   'for-update'    — BEGIN; `SELECT … FOR UPDATE` on the submission row
//                     (READ COMMITTED re-evaluates after the lock wait, so the
//                     loser observes `published` → 409); audit appends are
//                     serialized by a single-row `audit_head` table lock.
//   'serializable'  — `BEGIN ISOLATION LEVEL SERIALIZABLE`; the faithful
//                     statement sequence (no row locks); audit appends keep
//                     the faithful read-last-seq pattern; SQLSTATE 40001
//                     (serialization_failure) / 40P01 (deadlock_detected) /
//                     23505 are handled EXPLICITLY: bounded retry, and after
//                     exhaustion the conflict maps to a 409 conflict envelope
//                     (never an unhandled 500).
//
// The strategy also decides the idempotency store hardening (F3): a 23505 on
// the idempotency INSERT serves the CONCURRENTLY STORED replay (or a 422
// idempotency_mismatch for a different body) — shared by both strategies.
//
// Scope: this hardened server implements ONLY the decision endpoint
// (POST /v1/admin/submissions/:id/decisions) with its auth gate, envelope +
// allowlist validation, kill switch, idempotency layer and decision
// transaction. All other endpoints, quotas and the submission-creation paths
// remain the faithful server's responsibility (covered by v1–v9 against
// src/server.mjs, which is deliberately UNTOUCHED so the original failing
// evidence stays reproducible).
//
// Isolation: PostgreSQL-only (the `FOR UPDATE` syntax is the SQLite-venue
// no-go; the SQLite regression venue keeps running the faithful server).

import { createHash } from 'node:crypto';
import { resolveSession, requireCapability } from './auth.mjs';
import { validateEnvelope, validatePayload, validateReason, UUID_RE } from './validate.mjs';

const DECIDABLE_STATUSES = ['submitted', 'in_review', 'changes_requested'];
const TERMINAL_DECIDED = ['published', 'approved', 'rejected', 'withdrawn'];
const DAY_MS = 24 * 60 * 60 * 1000;

export const STRATEGIES = ['for-update', 'serializable'];

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Raised ONLY inside the serializable strategy's audit append: a 23505 on the
// audit seq PK there is a serialization-adjacent conflict (retry), not a
// contract-level decision conflict (409).
class RetryableConflict extends Error {}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

function isUniqueViolation(e) {
  return e && (e.code === '23505' || /UNIQUE constraint failed/.test(String(e.message ?? '')));
}

// -- F4 support: single-row audit head used as an append mutex ----------------
// Idempotent: safe to call on every hardened schema (per-trial or per-test).
export async function ensureHardenedDdl(db) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS audit_head (id INTEGER PRIMARY KEY, last_seq BIGINT NOT NULL)'
  );
  await db.run('INSERT INTO audit_head (id, last_seq) VALUES (1, 0) ON CONFLICT (id) DO NOTHING');
}

// -- F3 hardening: idempotency store that survives concurrent duplicates -------
// Never opens or commits its own transaction: runs on the ambient (auto)commit
// or inside a caller-managed transaction. On 23505 (concurrent same-key
// insert) it re-reads the winning row and returns its stored replay for the
// same request hash; a different body maps to the faithful 422 contract error.
export async function hardenedStoreIdempotency(
  db,
  { principalId, key, method, path, body, status, response, ts }
) {
  const requestHash = sha256(`${method}|${path}|${canonical(body)}`);
  try {
    await db.run(
      'INSERT INTO idempotency (principal_id, key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [principalId, key, requestHash, status, JSON.stringify(response), ts]
    );
    return { stored: true };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const row = await db.get(
        'SELECT request_hash, status_code, response_json FROM idempotency WHERE principal_id = ? AND key = ?',
        [principalId, key]
      );
      if (row && row.request_hash === requestHash) {
        return {
          replay: { status: row.status_code, body: JSON.parse(row.response_json) },
        };
      }
      throw new HttpError(
        422,
        'idempotency_mismatch',
        'Idempotency key reused with a different request body'
      );
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The experimental hardened server factory.
// ---------------------------------------------------------------------------
export function createHardenedServer({ db, now, strategy, maxAttempts = 4 }) {
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`createHardenedServer: strategy must be one of ${STRATEGIES.join(' | ')}`);
  }
  let requestCounter = 0;
  let faultAt = null;

  // Telemetry used as the comparison evidence between the two strategies.
  const stats = {
    strategy,
    attempts: 0,
    retries: { serialization: 0, deadlock: 0, uniqueViolation: 0, auditConflict: 0 },
    mappedTo409: 0,
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

  // -- audit append (strategy-branched) --------------------------------------
  async function appendAuditLocked(actorId, action, subject, payload) {
    // for-update strategy: the single-row head lock serializes appenders, so
    // reading the last audit row afterwards is race-free under READ COMMITTED
    // (each waiter observes the previous committer's row).
    const head = await db.get('SELECT last_seq FROM audit_head WHERE id = 1 FOR UPDATE');
    if (!head) {
      throw new Error('audit_head row missing — call ensureHardenedDl(db) before hardening');
    }
    const last = await db.get('SELECT seq, this_hash FROM audit_events ORDER BY seq DESC LIMIT 1');
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.this_hash ?? 'GENESIS';
    const payloadHash = sha256(canonical(payload ?? null));
    const thisHash = sha256(
      `${seq}|${now()}|${actorId}|${action}|${subject}|${payloadHash}|${prevHash}`
    );
    await db.run(
      'INSERT INTO audit_events (seq, ts, actor_id, action, subject, payload_hash, prev_hash, this_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [seq, now(), actorId, action, subject, payloadHash, prevHash, thisHash]
    );
    await db.run('UPDATE audit_head SET last_seq = ? WHERE id = 1', [seq]);
    return seq;
  }

  async function appendAuditSerializable(actorId, action, subject, payload) {
    // Faithful read-last-seq pattern (exactly src/server.mjs appendAudit),
    // with the 23505 collision promoted to a retryable conflict instead of an
    // unhandled 500 (F4 SQLSTATE handling under SERIALIZABLE).
    try {
      const last = await db.get(
        'SELECT seq, this_hash FROM audit_events ORDER BY seq DESC LIMIT 1'
      );
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.this_hash ?? 'GENESIS';
      const payloadHash = sha256(canonical(payload ?? null));
      const thisHash = sha256(
        `${seq}|${now()}|${actorId}|${action}|${subject}|${payloadHash}|${prevHash}`
      );
      await db.run(
        'INSERT INTO audit_events (seq, ts, actor_id, action, subject, payload_hash, prev_hash, this_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [seq, now(), actorId, action, subject, payloadHash, prevHash, thisHash]
      );
      return seq;
    } catch (e) {
      if (isUniqueViolation(e)) throw new RetryableConflict('audit seq collision (23505)');
      throw e;
    }
  }

  const appendAudit = (actorId, action, subject, payload) =>
    strategy === 'for-update'
      ? appendAuditLocked(actorId, action, subject, payload)
      : appendAuditSerializable(actorId, action, subject, payload);

  // -- one attempt of the decision transaction (mirrors runDecision 1–7) ----
  async function decisionSteps(actor, subId, body) {
    const { decision, expectedRevision, reason } = body;
    const ts = now();

    // 1. authorize (role + non-suspension done by the gate) + actor≠author,
    //    with the strategy-specific read of the submission row.
    const sub =
      strategy === 'for-update'
        ? await db.get('SELECT * FROM submissions WHERE id = ? FOR UPDATE', [subId])
        : await db.get('SELECT * FROM submissions WHERE id = ?', [subId]);
    if (!sub) throw new HttpError(404, 'not_found', 'No such submission');
    if (sub.principal_id === actor.id) {
      throw new HttpError(403, 'forbidden', 'Actor cannot decide on own submission (actor≠author)');
    }

    // 2. status guard + expectedRevision compare (the T10 guard)
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

    // 3. re-validate stored payload + evidence + license intent
    const payload = JSON.parse(sub.payload_json);
    const payloadErrors = validatePayload(payload);
    if (payloadErrors.length > 0) {
      throw new HttpError(400, 'validation_failed', 'Stored payload failed revalidation', payloadErrors);
    }

    let newStatus;
    let publishedRevisionId = null;
    let entityUuid = null;

    if (decision === 'approve') {
      fault('before_publish_row');
      entityUuid = payload.target.catalogueUuid ?? `ent_${subId}`;
      const existing = await db.get('SELECT uuid FROM published_entities WHERE uuid = ?', [entityUuid]);
      await db.run(
        'INSERT INTO published_revisions (entity_uuid, submission_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
        [entityUuid, sub.id, sub.revision, sub.payload_json, ts]
      );
      publishedRevisionId = (await db.get('SELECT MAX(id) AS id FROM published_revisions')).id;
      if (existing) {
        await db.run(
          'UPDATE published_entities SET current_revision_id = ?, updated_at = ? WHERE uuid = ?',
          [publishedRevisionId, ts, entityUuid]
        );
      } else {
        await db.run(
          'INSERT INTO published_entities (uuid, kind, current_revision_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [entityUuid, payload.target.kind, publishedRevisionId, 'published', ts, ts]
        );
      }
      await db.run(
        'INSERT INTO change_feed (kind, entity_uuid, revision_ref, provenance, created_at) VALUES (?, ?, ?, ?, ?)',
        ['published', entityUuid, publishedRevisionId, `submission:${sub.id}#${sub.revision}`, ts]
      );
      fault('after_publish_row'); // T17 rollback point
      newStatus = 'published';
    } else if (decision === 'reject') {
      newStatus = 'rejected';
    } else {
      newStatus = 'changes_requested';
    }

    // 5. advance status + review event
    await db.run('UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?', [newStatus, ts, sub.id]);
    await db.run(
      'INSERT INTO review_events (submission_id, revision, decision, actor_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [sub.id, sub.revision, decision, actor.id, reason ?? null, ts]
    );

    // 6. hash-chained audit append (strategy-branched — F4)
    await appendAudit(actor.id, `decision.${decision}`, `submission:${sub.id}`, {
      revision: sub.revision,
      reason: reason ?? null,
    });

    // 7. commit
    await db.exec('COMMIT');
    return res(201, {
      submissionId: sub.id,
      decision,
      status: newStatus,
      revision: sub.revision,
      ...(publishedRevisionId ? { publishedRevisionId, entityUuid } : {}),
    });
  }

  // -- decision transaction driver with explicit SQLSTATE handling -----------
  async function runDecision(actor, subId, body) {
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      stats.attempts += 1;
      try {
        if (strategy === 'serializable') await db.exec('BEGIN ISOLATION LEVEL SERIALIZABLE');
        else await db.exec('BEGIN');
        return await decisionSteps(actor, subId, body);
      } catch (e) {
        try {
          await db.exec('ROLLBACK');
        } catch {
          /* no open tx */
        }
        if (e instanceof HttpError) return err(e.status, e.code, e.message, e.details);
        if (e instanceof RetryableConflict) {
          stats.retries.auditConflict += 1;
          lastErr = e;
          continue;
        }
        if (e && e.code === '40001') {
          stats.retries.serialization += 1;
          lastErr = e;
          continue;
        }
        if (e && e.code === '40P01') {
          stats.retries.deadlock += 1;
          lastErr = e;
          continue;
        }
        if (isUniqueViolation(e)) {
          // A same-entity/revision PK collision inside the decision tx (the
          // ISO-1 double-publish path): retry once; the retry observes the
          // winner's `published` status and answers the contract 409.
          stats.retries.uniqueViolation += 1;
          lastErr = e;
          continue;
        }
        // Injected faults and anything unexpected stay faithful: 500 + full
        // rollback (atomicity preserved).
        return err(500, 'internal', 'Internal error — partial failure rolled back server-side');
      }
    }
    // Bounded retry exhausted — the contract answer is a 409 conflict, NEVER
    // an unhandled SQLSTATE 500.
    stats.mappedTo409 += 1;
    return err(409, 'conflict', 'Concurrency conflict after bounded retry', {
      attempts: maxAttempts,
      sqlstate: lastErr && lastErr.code ? lastErr.code : null,
    });
  }

  // -- faithful idempotency check (mirrors src/server.mjs) --------------------
  async function checkIdempotency(principalId, key, method, path, body) {
    const requestHash = sha256(`${method}|${path}|${canonical(body)}`);
    const expiryCutoff = now() - DAY_MS;
    await db.run('DELETE FROM idempotency WHERE created_at < ?', [expiryCutoff]);
    const row = await db.get(
      'SELECT request_hash, status_code, response_json FROM idempotency WHERE principal_id = ? AND key = ?',
      [principalId, key]
    );
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

  const DECISION_PATH = /^\/v1\/admin\/submissions\/([A-Za-z0-9_-]+)\/decisions$/;

  // -- route: decision endpoint only (documented scope) ----------------------
  async function route(req) {
    const { method, path, body = {}, session } = req ?? {};
    const m = DECISION_PATH.test(path ?? '') ? DECISION_PATH.exec(path) : null;
    if (method !== 'POST' || !m) {
      // Hardened-server scope note: only the decision endpoint is hardened.
      return err(404, 'not_found', 'Unknown endpoint');
    }

    // envelope + body allowlist (faithful)
    const envErrors = validateEnvelope(body);
    if (envErrors.length > 0) {
      return err(400, 'validation_failed', 'Request envelope validation failed', envErrors);
    }
    const allowed = ['schemaVersion', 'decision', 'expectedRevision', 'reason', 'idempotencyKey'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      return err(400, 'validation_failed', 'Unknown request field rejected', [
        `${unknown.join(', ')}: unknown field rejected (allowlist)`,
      ]);
    }

    // global intake kill switch (writes only) — faithful
    const ks = await db.get('SELECT value FROM config WHERE key = ?', ['kill_switch']);
    if (ks && ks.value === 'on') {
      return err(503, 'service_unavailable', 'Intake disabled by kill switch', { retryAfter: 60 });
    }

    // authentication + capability gate (default-deny, faithful)
    const resolved = await resolveSession(db, session, now());
    const gate = requireCapability(resolved, 'decide');
    if (gate.error) return err(gate.error.status, gate.error.code, gate.error.message);
    const actor = gate.principal;

    // idempotency: replay / mismatch (faithful), store hardened (F3)
    const key = body.idempotencyKey;
    let idem = null;
    if (key !== undefined) {
      if (!UUID_RE.test(key)) {
        return err(400, 'validation_failed', 'idempotencyKey: must be a UUID');
      }
      try {
        idem = await checkIdempotency(actor.id, key, method, path, body);
      } catch (e) {
        if (e instanceof HttpError) return err(e.status, e.code, e.message, e.details);
        throw e;
      }
      if (idem.replay) return res(idem.replay.status, idem.replay.body);
    }

    // dispatch validations (faithful)
    if (key === undefined) {
      return err(400, 'validation_failed', 'idempotencyKey: required for decisions');
    }
    if (!['approve', 'reject', 'request_changes'].includes(body.decision)) {
      return err(400, 'validation_failed', 'decision: must be approve | reject | request_changes');
    }
    if (!Number.isInteger(body.expectedRevision)) {
      return err(400, 'validation_failed', 'expectedRevision: required integer');
    }
    const reasonErrors = validateReason(body.reason);
    if (reasonErrors.length > 0) {
      return err(400, 'validation_failed', 'reason validation failed', reasonErrors);
    }

    const result = await runDecision(actor, m[1], body);

    // store-on-success with the F3 hardened store: if a concurrent duplicate
    // won the insert, its stored replay is served instead of a 23505 → 500.
    if (result.status >= 200 && result.status < 300) {
      const store = await hardenedStoreIdempotency(db, {
        principalId: actor.id,
        key,
        method,
        path,
        body,
        status: result.status,
        response: result.body,
        ts: now(),
      });
      if (store.replay) return res(store.replay.status, store.replay.body);
    }
    return result;
  }

  return {
    strategy,
    stats,
    async handle(req) {
      const requestId = nextRequestId();
      const result = await route(req);
      if (result.body.error) {
        return { status: result.status, body: { error: { ...result.body.error, requestId } } };
      }
      return { status: result.status, body: { requestId, ...result.body } };
    },
    injectFault(step) {
      faultAt = step;
    },
    faultPending() {
      return faultAt;
    },
  };
}
