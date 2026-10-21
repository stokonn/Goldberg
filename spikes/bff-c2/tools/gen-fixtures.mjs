/**
 * C2 spike — synthetic fixture generation.
 * Generates RSA keypairs + JWKS + principal/grant manifest into
 * fixtures/generated/ (GITIGNORED — private keys are never committed).
 * Public JWKS copies are exported to fixtures/public/ (inert, committed).
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const GEN = join(ROOT, "fixtures", "generated");
const PUB = join(ROOT, "fixtures", "public");
mkdirSync(GEN, { recursive: true });
mkdirSync(PUB, { recursive: true });

function makeRsa(kid) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const jwksKey = { kty: "RSA", kid, use: "sig", alg: "RS256", n: jwk.n, e: jwk.e };
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }), jwksKey };
}

const k1 = makeRsa("spike-jwk-1");
const k2 = makeRsa("spike-jwk-2");
const ku = makeRsa("spike-jwk-unknown");

writeFileSync(join(GEN, "private-1.pem"), k1.privateKeyPem, { mode: 0o600 });
writeFileSync(join(GEN, "private-2.pem"), k2.privateKeyPem, { mode: 0o600 });
writeFileSync(join(GEN, "private-unknown.pem"), ku.privateKeyPem, { mode: 0o600 });

const jwks1 = { keys: [k1.jwksKey] };
const jwks2 = { keys: [k2.jwksKey] };
writeFileSync(join(GEN, "jwks-1.json"), JSON.stringify(jwks1, null, 2));
writeFileSync(join(GEN, "jwks-2.json"), JSON.stringify(jwks2, null, 2));
// Inert public material only — safe to commit.
copyFileSync(join(GEN, "jwks-1.json"), join(PUB, "jwks-1.json"));
copyFileSync(join(GEN, "jwks-2.json"), join(PUB, "jwks-2.json"));

// Synthetic principals and grants (obviously fictional identifiers).
const manifest = {
  principals: [
    { id: "p-admin", subject: "spike-admin-1", state: "active" },
    { id: "p-mod", subject: "spike-mod-1", state: "active" },
    { id: "p-user", subject: "spike-user-1", state: "active" },
    { id: "p-sus", subject: "spike-sus-1", state: "suspended" },
    { id: "p-rev", subject: "spike-rev-1", state: "active" },
  ],
  grants: [
    { principal_id: "p-admin", capability: "admin:queue_read" },
    { principal_id: "p-admin", capability: "admin:decide" },
    { principal_id: "p-admin", capability: "admin:roles" },
    { principal_id: "p-mod", capability: "admin:queue_read" },
    { principal_id: "p-user", capability: "submit" },
    // p-rev deliberately has NO grants (revoked-admin scenario S10).
  ],
};
writeFileSync(join(GEN, "manifest.json"), JSON.stringify(manifest, null, 2));

// Per-run synthetic session secret: written to .dev.vars (gitignored) so
// wrangler dev loads it as a SECRET (bindings table shows "(hidden)", never
// echoed into local logs) and to the gitignored fixtures dir for the runner.
import { randomBytes } from "node:crypto";
const sessionSecret = `spike2session-${randomBytes(24).toString("hex")}`;
writeFileSync(join(GEN, "session-secret.txt"), sessionSecret, { mode: 0o600 });
writeFileSync(join(ROOT, ".dev.vars"), `SESSION_SECRET="${sessionSecret}"\n`, { mode: 0o600 });

console.log("fixtures generated:", GEN);
console.log("public JWKS exported:", PUB);
