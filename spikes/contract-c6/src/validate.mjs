// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: submission payload
// validation per DATA-MODEL.md §2 and API-CONTRACTS.md §1/§4.
//
// Allowlist-only: unknown top-level fields are REJECTED (400), never stripped
// with effect. Bounded: ≤16 KiB body, ≤20 fields, ≤10 evidence URLs, each URL
// ≤2 KiB. No arbitrary HTML (plain text, control chars rejected), no uploads.
// There is no field for personal practice data — unknown fields cannot persist.

import { checkEvidenceUrl } from './ssrf.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELDS = 20;
const MAX_EVIDENCE_URLS = 10;
const MAX_URL_BYTES = 2 * 1024;
const MAX_DEPTH = 8;
const MAX_TEXT = 2000;
const MAX_NOTE = 500;
const MAX_REASON = 500;

// Top-level allowlist for a submission revision payload (DATA-MODEL.md §2).
const PAYLOAD_KEYS = new Set([
  'schemaVersion',
  'target',
  'changeKind',
  'fields',
  'intendedLicense',
  'contributorNote',
]);

const TARGET_KEYS = new Set(['kind', 'catalogueUuid', 'externalIdentity']);
const FIELD_KEYS = new Set(['field', 'newValue', 'evidence']);
const EVIDENCE_KEYS = new Set(['type', 'value', 'license']);

const KINDS = new Set(['work', 'arrangement', 'artist', 'album', 'recording']);
const CHANGE_KINDS = new Set(['new_metadata', 'correction']);
// Spike-local allowlist; the production allowlist is fixed from the D5e
// licensing decisions at implementation time (documented in results/SUMMARY.md).
const LICENSES = new Set(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0']);
const EVIDENCE_TYPES = new Set(['source_url', 'reference']);

const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const UUID_RE = UUID;

function depthOf(value, d = 0) {
  if (d > MAX_DEPTH) return d;
  if (Array.isArray(value)) {
    let max = d;
    for (const v of value) max = Math.max(max, depthOf(v, d + 1));
    return max;
  }
  if (value && typeof value === 'object') {
    let max = d;
    for (const v of Object.values(value)) max = Math.max(max, depthOf(v, d + 1));
    return max;
  }
  return d;
}

// Plain-text rule: no HTML angle brackets, no control characters (newline/tab ok).
function plainText(v, max, path, errors) {
  if (typeof v !== 'string') {
    errors.push(`${path}: must be a string`);
    return;
  }
  if (v.length > max) errors.push(`${path}: exceeds ${max} characters`);
  if (v.includes('<') || v.includes('>'))
    errors.push(`${path}: HTML markup not allowed (plain text only)`);
  if (CONTROL_CHARS.test(v)) errors.push(`${path}: control characters not allowed`);
}

// Common envelope rules for every request body (API-CONTRACTS.md §1).
export function validateEnvelope(body) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return ['body: must be a JSON object'];
  }
  if (!Number.isInteger(body.schemaVersion)) {
    errors.push('schemaVersion: required integer (currently 1)');
  } else if (body.schemaVersion !== 1) {
    errors.push('schemaVersion: unsupported version');
  }
  if (depthOf(body) > MAX_DEPTH) errors.push('body: nesting too deep');
  if (JSON.stringify(body).length > MAX_BODY_BYTES)
    errors.push(`body: exceeds ${MAX_BODY_BYTES} bytes`);
  return errors;
}

// Full submission payload validation. Returns array of error strings ([] = ok).
export function validatePayload(payload) {
  const errors = [];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['payload: must be an object'];
  }

  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.has(key))
      errors.push(`${key}: unknown field rejected (allowlist)`);
  }

  if (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion !== 1)
    errors.push('schemaVersion: required integer 1');

  if (depthOf(payload) > MAX_DEPTH) errors.push('payload: nesting too deep');
  if (JSON.stringify(payload).length > MAX_BODY_BYTES)
    errors.push(`payload: exceeds ${MAX_BODY_BYTES} bytes`);

  // target
  const t = payload.target;
  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    errors.push('target: required object');
  } else {
    for (const key of Object.keys(t)) {
      if (!TARGET_KEYS.has(key)) errors.push(`target.${key}: unknown field rejected`);
    }
    if (!KINDS.has(t.kind)) errors.push('target.kind: unsupported kind');
    if (t.catalogueUuid !== undefined && !UUID.test(t.catalogueUuid))
      errors.push('target.catalogueUuid: must be a UUID');
    if (t.externalIdentity !== undefined) plainText(t.externalIdentity, 200, 'target.externalIdentity', errors);
  }

  if (!CHANGE_KINDS.has(payload.changeKind))
    errors.push('changeKind: must be new_metadata | correction');
  if (payload.changeKind === 'correction' && !(t && UUID.test(t.catalogueUuid)))
    errors.push('target.catalogueUuid: required for correction');

  // fields
  if (!Array.isArray(payload.fields)) {
    errors.push('fields: required array');
  } else {
    if (payload.fields.length > MAX_FIELDS) errors.push(`fields: exceeds ${MAX_FIELDS} items`);
    let evidenceCount = 0;
    payload.fields.forEach((f, i) => {
      const p = `fields[${i}]`;
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      for (const key of Object.keys(f)) {
        if (!FIELD_KEYS.has(key)) errors.push(`${p}.${key}: unknown field rejected`);
      }
      if (typeof f.field !== 'string' || !FIELD_NAME.test(f.field))
        errors.push(`${p}.field: must match ^[a-z][a-z0-9_]{0,63}$`);
      plainText(f.newValue, MAX_TEXT, `${p}.newValue`, errors);
      if (f.evidence !== undefined) {
        if (!Array.isArray(f.evidence)) {
          errors.push(`${p}.evidence: must be an array`);
          return;
        }
        evidenceCount += f.evidence.length;
        f.evidence.forEach((e, j) => {
          const ep = `${p}.evidence[${j}]`;
          if (e === null || typeof e !== 'object' || Array.isArray(e)) {
            errors.push(`${ep}: must be an object`);
            return;
          }
          for (const key of Object.keys(e)) {
            if (!EVIDENCE_KEYS.has(key)) errors.push(`${ep}.${key}: unknown field rejected`);
          }
          if (!EVIDENCE_TYPES.has(e.type)) errors.push(`${ep}.type: unsupported`);
          if (e.license !== undefined && !LICENSES.has(e.license))
            errors.push(`${ep}.license: unsupported`);
          if (typeof e.value !== 'string') {
            errors.push(`${ep}.value: must be a string`);
            return;
          }
          if (e.type === 'source_url') {
            if (e.value.length > MAX_URL_BYTES) {
              errors.push(`${ep}.value: exceeds ${MAX_URL_BYTES} bytes`);
            } else {
              const check = checkEvidenceUrl(e.value);
              if (!check.ok) errors.push(`${ep}.value: ${check.reason}`);
            }
          } else {
            plainText(e.value, MAX_URL_BYTES, `${ep}.value`, errors);
          }
        });
      }
    });
    if (evidenceCount > MAX_EVIDENCE_URLS)
      errors.push(`fields[].evidence: exceeds ${MAX_EVIDENCE_URLS} URLs in total`);
  }

  if (!LICENSES.has(payload.intendedLicense))
    errors.push('intendedLicense: must be one of the allowlisted licenses');
  if (payload.contributorNote !== undefined)
    plainText(payload.contributorNote, MAX_NOTE, 'contributorNote', errors);

  return errors;
}

// Reason field on decisions/withdrawals.
export function validateReason(reason) {
  if (reason === undefined) return [];
  const errors = [];
  plainText(reason, MAX_REASON, 'reason', errors);
  return errors;
}
