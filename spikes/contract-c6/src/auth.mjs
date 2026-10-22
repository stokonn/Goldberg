// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: fake authentication.
//
// Synthetic session tokens only — NO Google OAuth, NO JWT/JWKS, NO real
// credentials. Token cryptography (signature forging, alg confusion, JWKS
// rotation) was already verified in the C2 spike (S1–S19, 19/19 PASS) and is
// deliberately NOT re-tested here. This layer reproduces only what the
// contract-behavior tests need: unauthenticated/expired/revoked sessions and
// LIVE server-side principal state, so that role revocation and suspension
// take effect at the very next request without waiting for token expiry
// (THREAT-MODEL rows T5 and T22).
//
// Sessions map: sid -> { principalId, expiresAt }. Lookup on every request is
// a direct read of the principals table (live roles, live suspension flag).

export const CAPABILITIES_BY_ROLE = {
  moderator: ['submit', 'queue.read', 'decide'],
  admin: ['submit', 'queue.read', 'decide', 'quarantine', 'audit.read', 'roles.manage'],
};

const BASE_CAPABILITIES = ['submit'];

export async function resolveSession(db, token, now) {
  if (typeof token !== 'string' || token.length === 0) {
    return { error: { status: 401, code: 'unauthenticated', message: 'Missing session' } };
  }
  const row = await db.get('SELECT principal_id, expires_at FROM sessions WHERE sid = ?', [token]);
  if (!row) {
    return { error: { status: 401, code: 'unauthenticated', message: 'Invalid session' } };
  }
  if (row.expires_at <= now) {
    await db.run('DELETE FROM sessions WHERE sid = ?', [token]);
    return { error: { status: 401, code: 'unauthenticated', message: 'Expired session' } };
  }
  const principal = await db.get(
    'SELECT id, display_name, roles, suspended FROM principals WHERE id = ?',
    [row.principal_id]
  );
  if (!principal) {
    // Orphaned session: fail closed.
    return { error: { status: 401, code: 'unauthenticated', message: 'Invalid session' } };
  }
  if (principal.suspended === 1) {
    return {
      error: { status: 403, code: 'forbidden', message: 'Principal is suspended' },
    };
  }
  let roles = [];
  try {
    roles = JSON.parse(principal.roles);
  } catch {
    roles = [];
  }
  const capabilities = new Set(BASE_CAPABILITIES);
  for (const role of roles) {
    for (const cap of CAPABILITIES_BY_ROLE[role] ?? []) capabilities.add(cap);
  }
  return {
    principal: {
      id: principal.id,
      displayName: principal.display_name,
      roles,
      capabilities,
    },
  };
}

export function requireCapability(resolved, capability) {
  if (resolved.error) return resolved;
  if (!resolved.principal.capabilities.has(capability)) {
    return {
      error: { status: 403, code: 'forbidden', message: 'Capability not granted (default-deny)' },
    };
  }
  return resolved;
}
