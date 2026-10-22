// Goldberg 0.11 Stage 6 — C6 contract-behavior spike: evidence-URL guard
// (THREAT-MODEL row T14, [L] portion). Allowlist scheme/host, no private
// ranges, no credentials, fixed port — never a general proxy.
//
// SCOPE LIMIT (recorded in results/SUMMARY.md): this is the static portion of
// T14 only. DNS resolution, redirect-chain re-validation and rebinding require
// real network behavior and are NOT verified here (they belong to an [L]
// implementation-time network harness or the [I] venue).

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function ipv4Octets(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return 'invalid';
  return octets;
}

function isBlockedIpv4(octets) {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local
  // v4-mapped forms: WHATWG URL canonicalizes ::ffff:127.0.0.1 to
  // ::ffff:7f00:1 (hex groups) — handle dotted-quad AND hex-group forms.
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (v4mapped) {
    const octets = ipv4Octets(v4mapped[1]);
    return Array.isArray(octets) ? isBlockedIpv4(octets) : true;
  }
  const v4mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    return isBlockedIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  return false;
}

export function checkEvidenceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme must be https' };
  if (url.username || url.password)
    return { ok: false, reason: 'credentials in URL are not allowed' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'port must be 443' };

  const host = url.hostname.toLowerCase();
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost'))
    return { ok: false, reason: 'hostname in a non-public suffix' };
  if (BLOCKED_HOSTNAMES.has(host)) return { ok: false, reason: 'hostname is not public' };
  if (host.startsWith('[') || host.includes(':')) {
    if (isBlockedIpv6(host)) return { ok: false, reason: 'IP literal in a non-public range' };
    return { ok: true };
  }
  const octets = ipv4Octets(host);
  if (octets === 'invalid') return { ok: false, reason: 'not a valid IP literal' };
  if (Array.isArray(octets)) {
    if (isBlockedIpv4(octets)) return { ok: false, reason: 'IP literal in a non-public range' };
    return { ok: true };
  }
  // numeric hosts that are NOT a valid 4-octet dotted quad (e.g. "1.2.3.4.5")
  // are invalid — refuse (fail closed). Note: WHATWG URL parsing resolves the
  // shorthand "1.2.3" to "1.2.0.3" before we see it, so it is range-checked
  // as a normal IPv4 literal above.
  if (/^\d+(\.\d+)+$/.test(host)) return { ok: false, reason: 'not a valid IP literal' };
  return { ok: true };
}
