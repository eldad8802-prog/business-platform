/**
 * Who may run the intake sweep — QStash signatures (official SDK Receiver) and the CRON_SECRET
 * backstop. No database. Run: npx tsx lib/intake/sweep-auth.test.ts
 *
 * Tokens are minted exactly as Upstash mints them: an HS256 JWT signed with the signing key, claims
 * iss "Upstash", sub = destination URL, exp / nbf / iat, jti, body = base64url(sha256(raw body)).
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { authorizeSweep, SWEEP_URL } from "./sweep-auth";

const CURRENT = "sig_current_0123456789abcdefghijklmnopqrstuvwxyz";
const NEXT = "sig_next_0123456789abcdefghijklmnopqrstuvwxyzABCD";
const OTHER = "sig_attacker_0123456789abcdefghijklmnopqrstuvwxy";
const CRON = "c".repeat(48);
const ENV = { QSTASH_CURRENT_SIGNING_KEY: CURRENT, QSTASH_NEXT_SIGNING_KEY: NEXT, CRON_SECRET: CRON };
const BODY = "";

const bodyHash = (b: string) => createHash("sha256").update(b, "utf8").digest("base64url");
async function sign(key: string, o: { url?: string; body?: string; exp?: number; nbf?: number; iss?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ body: bodyHash(o.body ?? BODY) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(o.iss ?? "Upstash")
    .setSubject(o.url ?? SWEEP_URL)
    .setIssuedAt(now)
    .setNotBefore(o.nbf ?? now)
    .setExpirationTime(o.exp ?? now + 300)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(key));
}

let n = 0;
async function t(name: string, fn: () => Promise<void>) {
  await fn();
  n++;
  console.log(`  ok ${name}`);
}
const auth = (signature: string | null, opts: { body?: string; authorization?: string | null; env?: Record<string, string | undefined> } = {}) =>
  authorizeSweep({ signature, body: opts.body ?? BODY, authorization: opts.authorization ?? null }, opts.env ?? ENV);

async function main() {
  await t("a valid QStash request signed with the CURRENT key → accepted (via qstash)", async () => {
    assert.deepEqual(await auth(await sign(CURRENT)), { ok: true, via: "qstash" });
  });
  await t("a valid QStash request signed with the NEXT key (rotation) → accepted", async () => {
    assert.deepEqual(await auth(await sign(NEXT)), { ok: true, via: "qstash" });
  });
  await t("a signature made with any other key → 401", async () => {
    assert.deepEqual(await auth(await sign(OTHER)), { ok: false, status: 401, error: "invalid_signature" });
  });
  await t("a malformed signature → 401", async () => {
    assert.deepEqual(await auth("not.a.jwt"), { ok: false, status: 401, error: "invalid_signature" });
  });
  await t("a body that differs from the signed one → 401", async () => {
    assert.equal((await auth(await sign(CURRENT, { body: "" }), { body: "{\"x\":1}" })).ok, false);
    assert.equal((await auth(await sign(CURRENT, { body: "{\"a\":1}" }), { body: "{\"a\":2}" })).ok, false);
  });
  await t("the same body that was signed (non-empty) → accepted", async () => {
    assert.equal((await auth(await sign(CURRENT, { body: "{\"a\":1}" }), { body: "{\"a\":1}" })).ok, true);
  });
  await t("signed for another destination URL → 401", async () => {
    for (const url of ["https://promaxgroup.co.il/api/payments/settlement-recovery", "https://evil.example/api/intake/sweep",
      "https://promaxgroup.co.il/api/intake/sweep/", "http://promaxgroup.co.il/api/intake/sweep"]) {
      assert.equal((await auth(await sign(CURRENT, { url }))).ok, false, url);
    }
  });
  await t("an expired signature (beyond the 5 s tolerance) → 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await auth(await sign(CURRENT, { exp: now - 60, nbf: now - 120 }))).ok, false);
  });
  await t("a signature not valid yet (nbf in the future) → 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await auth(await sign(CURRENT, { nbf: now + 120, exp: now + 600 }))).ok, false);
  });
  await t("a token whose issuer is not Upstash → 401", async () => {
    assert.equal((await auth(await sign(CURRENT, { iss: "Someone" }))).ok, false);
  });
  await t("NO fallback: an invalid signature + a valid CRON bearer → still 401", async () => {
    assert.deepEqual(await auth(await sign(OTHER), { authorization: `Bearer ${CRON}` }), { ok: false, status: 401, error: "invalid_signature" });
  });
  await t("signing keys not configured (either one missing) → 503, never accepted", async () => {
    const sig = await sign(CURRENT);
    assert.deepEqual(await auth(sig, { env: { ...ENV, QSTASH_NEXT_SIGNING_KEY: undefined } }), { ok: false, status: 503, error: "qstash_not_configured" });
    assert.deepEqual(await auth(sig, { env: { ...ENV, QSTASH_CURRENT_SIGNING_KEY: "" } }), { ok: false, status: 503, error: "qstash_not_configured" });
  });
  await t("QSTASH_DEV in the environment does not switch to development keys", async () => {
    process.env.QSTASH_DEV = "true";
    try {
      assert.equal((await auth(await sign(CURRENT))).ok, true, "own keys still used");
      assert.equal((await auth(await sign(OTHER))).ok, false, "a foreign key still refused");
    } finally {
      delete process.env.QSTASH_DEV;
    }
  });
  await t("no signature: the CRON_SECRET backstop works as before", async () => {
    assert.deepEqual(await auth(null, { authorization: `Bearer ${CRON}` }), { ok: true, via: "cron" });
    assert.deepEqual(await auth(null, { authorization: "Bearer wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong" }), { ok: false, status: 401, error: "unauthorized" });
    assert.deepEqual(await auth(null), { ok: false, status: 401, error: "unauthorized" });
    assert.deepEqual(await auth(null, { authorization: `Bearer ${CRON}`, env: { ...ENV, CRON_SECRET: undefined } }), { ok: false, status: 503, error: "sweep_not_configured" });
  });
  await t("an empty signature header is treated as absent (bearer rules apply)", async () => {
    assert.deepEqual(await auth("   ", { authorization: `Bearer ${CRON}` }), { ok: true, via: "cron" });
  });
  console.log(`\nALL SWEEP AUTH TESTS PASSED — ${n} checks`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
