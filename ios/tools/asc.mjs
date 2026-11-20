// Tiny App Store Connect API client using the "Mac upload admin" key (never prints the key).
// Usage: node ios/tools/asc.mjs GET /v1/apps/6837140618
//        node ios/tools/asc.mjs PATCH /v1/... '{"data":...}'
import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const KEY_ID = "TARJN3PY7P", ISSUER = "6f9cb725-b033-41c7-a751-23be24ca3368";
const key = createPrivateKey(readFileSync(`${homedir()}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`));
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
export function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" }), body = b64({ iss: ISSUER, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" });
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}
export async function asc(method, path, body) {
  const url = path.startsWith("http") ? path : `https://api.appstoreconnect.apple.com${path}`;
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) { const e = new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(json.errors || json).slice(0, 1500)}`); e.status = r.status; e.json = json; throw e; }
  return json;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [m, p, b] = process.argv.slice(2);
  asc(m, p, b).then(j => console.log(JSON.stringify(j, null, 1))).catch(e => { console.error(e.message); process.exit(1); });
}
