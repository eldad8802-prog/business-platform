/**
 * Persistent login — the decision layer, exercised without a database.
 *
 * These tests exist because the interesting failures of a rotation scheme are
 * CLASSIFICATION failures, not plumbing ones: refusing when it should rotate is
 * an annoyance, but revoking when it should refuse is a denial-of-service
 * primitive handed to anyone who learned a selector. Every rule in §4.3 and §4.4
 * of the ratified design has a case here, including the two that were owner
 * corrections to an earlier, broken version of this design.
 *
 * Run: npx tsx lib/auth/refresh-session.test.ts
 */
import assert from "node:assert/strict";

import {
  ABSOLUTE_TTL_MS,
  GRACE_WINDOW_MS,
  IDLE_TTL_MS,
  buildRefreshCookieValue,
  cookieMaxAgeSeconds,
  decideRefresh,
  hashesEqual,
  mintSecret,
  newSessionWindow,
  parseRefreshCookie,
  sha256Hex,
  type SessionFacts,
} from "@/lib/auth/refresh-session";
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  readRefreshCookie,
  serializeRefreshCookie,
  verifyRefreshCsrf,
} from "@/lib/auth/refresh-cookie";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  [FAIL] ${name} — ${String((e as Error)?.message ?? e).slice(0, 240)}`);
  }
}

const NOW = new Date("2026-09-09T12:00:00.000Z");
const CURRENT = sha256Hex("current-secret");

function session(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    secretHash: CURRENT,
    tokenVersionAtIssue: 3,
    lastUsedAt: new Date(NOW.getTime() - 60_000),
    idleExpiresAt: new Date(NOW.getTime() + IDLE_TTL_MS),
    absoluteExpiresAt: new Date(NOW.getTime() + ABSOLUTE_TTL_MS),
    revokedAt: null,
    ...over,
  };
}

const base = {
  currentTokenVersion: 3,
  accountAcceptsUse: true,
  now: NOW,
};

// ── the happy path ──────────────────────────────────────────────────────────
test("the current secret rotates", () => {
  const d = decideRefresh({ ...base, session: session(), presentedSecretHash: CURRENT, rotated: null });
  assert.deepEqual(d, { kind: "rotate", reason: "current" });
});

// ── §4.3 — an unknown secret is a refusal and NEVER a revocation ────────────
test("an unknown secret REFUSES and does not revoke", () => {
  const d = decideRefresh({
    ...base,
    session: session(),
    presentedSecretHash: sha256Hex("never-issued"),
    rotated: null,
  });
  assert.equal(d.kind, "refuse");
  assert.equal((d as { reason: string }).reason, "unknown_secret");
});

test("an unknown secret cannot kill a session even when the session looks reused", () => {
  // Selector known, session heavily used, secret a random string. If this ever
  // returns "revoke", anyone who learns a selector can end that session.
  const d = decideRefresh({
    ...base,
    session: session({ lastUsedAt: new Date(NOW.getTime() - 1) }),
    presentedSecretHash: sha256Hex("attacker-guess"),
    rotated: null,
  });
  assert.notEqual(d.kind, "revoke");
});

// ── §4.2 — grace ────────────────────────────────────────────────────────────
test("a rotated secret inside its grace window rotates", () => {
  const d = decideRefresh({
    ...base,
    session: session(),
    presentedSecretHash: sha256Hex("previous"),
    rotated: { graceUntil: new Date(NOW.getTime() + 1_000) },
  });
  assert.deepEqual(d, { kind: "rotate", reason: "within_grace" });
});

test("grace is inclusive at its boundary", () => {
  const d = decideRefresh({
    ...base,
    session: session(),
    presentedSecretHash: sha256Hex("previous"),
    rotated: { graceUntil: NOW },
  });
  assert.equal(d.kind, "rotate");
});

// ── §4.4 — divergence, and the lost-response case it must not be confused with
test("past grace WITH later use is chain divergence", () => {
  const graceUntil = new Date(NOW.getTime() - 10_000);
  const d = decideRefresh({
    ...base,
    // used AFTER that grace ended → somebody else holds a later credential
    session: session({ lastUsedAt: new Date(graceUntil.getTime() + 5_000) }),
    presentedSecretHash: sha256Hex("previous"),
    rotated: { graceUntil },
  });
  assert.deepEqual(d, { kind: "revoke", reason: "refresh_chain_divergence" });
});

test("past grace WITHOUT later use is a lost response, not theft", () => {
  const graceUntil = new Date(NOW.getTime() - 10_000);
  const d = decideRefresh({
    ...base,
    // the session has not been used since that secret was retired
    session: session({ lastUsedAt: new Date(graceUntil.getTime() - 5_000) }),
    presentedSecretHash: sha256Hex("previous"),
    rotated: { graceUntil },
  });
  assert.equal(d.kind, "refuse");
  assert.equal((d as { reason: string }).reason, "grace_expired_no_divergence");
});

test("divergence needs STRICTLY later use — equal timestamps are not evidence", () => {
  const graceUntil = new Date(NOW.getTime() - 10_000);
  const d = decideRefresh({
    ...base,
    session: session({ lastUsedAt: graceUntil }),
    presentedSecretHash: sha256Hex("previous"),
    rotated: { graceUntil },
  });
  assert.equal(d.kind, "refuse");
});

// ── the refusals that precede any secret comparison ─────────────────────────
test("a revoked session refuses", () => {
  const d = decideRefresh({
    ...base,
    session: session({ revokedAt: NOW }),
    presentedSecretHash: CURRENT,
    rotated: null,
  });
  assert.equal((d as { reason: string }).reason, "session_revoked");
});

test("the 90-day ceiling refuses even with the current secret", () => {
  const d = decideRefresh({
    ...base,
    session: session({ absoluteExpiresAt: new Date(NOW.getTime() - 1) }),
    presentedSecretHash: CURRENT,
    rotated: null,
  });
  assert.equal((d as { reason: string }).reason, "absolute_expired");
});

test("idle expiry refuses", () => {
  const d = decideRefresh({
    ...base,
    session: session({ idleExpiresAt: new Date(NOW.getTime() - 1) }),
    presentedSecretHash: CURRENT,
    rotated: null,
  });
  assert.equal((d as { reason: string }).reason, "idle_expired");
});

test("global logout reaches a session issued under an older generation", () => {
  const d = decideRefresh({
    ...base,
    currentTokenVersion: 4,
    session: session({ tokenVersionAtIssue: 3 }),
    presentedSecretHash: CURRENT,
    rotated: null,
  });
  assert.equal((d as { reason: string }).reason, "token_version_stale");
});

test("an account under deletion quarantine cannot refresh", () => {
  const d = decideRefresh({
    ...base,
    accountAcceptsUse: false,
    session: session(),
    presentedSecretHash: CURRENT,
    rotated: null,
  });
  assert.equal((d as { reason: string }).reason, "account_quarantined");
});

test("the ceiling is checked before the secret — an expired session with a valid secret still refuses", () => {
  const d = decideRefresh({
    ...base,
    session: session({ absoluteExpiresAt: new Date(NOW.getTime() - 1), revokedAt: null }),
    presentedSecretHash: CURRENT,
    rotated: { graceUntil: new Date(NOW.getTime() + 10_000) },
  });
  assert.equal(d.kind, "refuse");
});

// ── credential mechanics ────────────────────────────────────────────────────
test("a minted secret is 256 bits of base64url and never looks like a digest", () => {
  const { secret, secretHash } = mintSecret();
  assert.equal(secret.length, 43);
  assert.ok(!/^[0-9a-f]{64}$/.test(secret), "a secret must not be mistakable for a hash");
  assert.match(secretHash, /^[0-9a-f]{64}$/);
  assert.equal(secretHash, sha256Hex(secret));
});

test("two mints never collide", () => {
  const a = mintSecret();
  const b = mintSecret();
  assert.notEqual(a.secret, b.secret);
  assert.notEqual(a.secretHash, b.secretHash);
});

test("hashesEqual is true for equal and false for different", () => {
  assert.ok(hashesEqual(CURRENT, CURRENT));
  assert.ok(!hashesEqual(CURRENT, sha256Hex("other")));
});

test("hashesEqual does not throw on a length mismatch", () => {
  assert.doesNotThrow(() => hashesEqual(CURRENT, "short"));
  assert.ok(!hashesEqual(CURRENT, "short"));
});

// ── cookie parsing: every malformed shape is a refusal, never a lookup ──────
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
test("a well-formed cookie parses", () => {
  const p = parseRefreshCookie(buildRefreshCookieValue(UUID, "abcdefghijklmnop"));
  assert.deepEqual(p, { sessionId: UUID, secret: "abcdefghijklmnop" });
});

for (const [label, raw] of [
  ["empty", ""],
  ["null", null],
  ["no dot", UUID],
  ["dot only", "."],
  ["no selector", ".secretsecretsecret"],
  ["no secret", `${UUID}.`],
  ["selector not a uuid", "not-a-uuid.secretsecretsecret"],
  ["secret too short", `${UUID}.short`],
  ["extra dot", `${UUID}.aaaaaaaaaaaaaaaa.bbbb`],
] as const) {
  test(`a malformed cookie (${label}) parses to null`, () => {
    assert.equal(parseRefreshCookie(raw), null);
  });
}

test("the cookie header is read by exact name", () => {
  const req = new Request("https://x.test/", {
    headers: { cookie: `other=1; ${REFRESH_COOKIE_NAME}=${UUID}.secretsecretsecret; z=2` },
  });
  assert.equal(readRefreshCookie(req), `${UUID}.secretsecretsecret`);
});

test("a similarly-named cookie is not mistaken for ours", () => {
  const req = new Request("https://x.test/", {
    headers: { cookie: `${REFRESH_COOKIE_NAME}_old=nope` },
  });
  assert.equal(readRefreshCookie(req), null);
});

// ── cookie attributes ───────────────────────────────────────────────────────
test("the cookie is HttpOnly, Secure, SameSite=Strict and path-scoped", () => {
  const c = serializeRefreshCookie("v", 100);
  for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api/auth", "Max-Age=100"]) {
    assert.ok(c.includes(attr), `missing ${attr}`);
  }
});

test("clearing keeps the attributes that identify the cookie being cleared", () => {
  const c = clearRefreshCookie();
  assert.ok(c.includes("Max-Age=0"));
  assert.ok(c.includes("Path=/api/auth") && c.includes("SameSite=Strict"));
});

test("cookie lifetime never exceeds the absolute ceiling", () => {
  const nearEnd = new Date(NOW.getTime() + 60_000);
  assert.equal(cookieMaxAgeSeconds(NOW, nearEnd), 60);
  const farEnd = new Date(NOW.getTime() + ABSOLUTE_TTL_MS);
  assert.equal(cookieMaxAgeSeconds(NOW, farEnd), IDLE_TTL_MS / 1000);
});

test("an already-expired ceiling yields a zero lifetime, never negative", () => {
  assert.equal(cookieMaxAgeSeconds(NOW, new Date(NOW.getTime() - 5_000)), 0);
});

// ── CSRF ────────────────────────────────────────────────────────────────────
function req(headers: Record<string, string>) {
  return new Request("https://internal.invalid/api/auth/refresh", { method: "POST", headers });
}

test("a same-origin POST passes", () => {
  const v = verifyRefreshCsrf(
    req({ host: "app.test", origin: "https://app.test", "sec-fetch-site": "same-origin" })
  );
  assert.deepEqual(v, { ok: true });
});

test("a cross-site Sec-Fetch-Site is refused before Origin is even considered", () => {
  const v = verifyRefreshCsrf(
    req({ host: "app.test", origin: "https://app.test", "sec-fetch-site": "cross-site" })
  );
  assert.deepEqual(v, { ok: false, reason: "cross_site" });
});

test("a missing Origin FAILS CLOSED", () => {
  const v = verifyRefreshCsrf(req({ host: "app.test" }));
  assert.deepEqual(v, { ok: false, reason: "origin_missing" });
});

test("an attacker origin is refused", () => {
  const v = verifyRefreshCsrf(req({ host: "app.test", origin: "https://evil.test" }));
  assert.deepEqual(v, { ok: false, reason: "origin_mismatch" });
});

test("the forwarded host is what the origin is compared against", () => {
  const v = verifyRefreshCsrf(
    req({ host: "internal-1.vercel", "x-forwarded-host": "app.test", origin: "https://app.test" })
  );
  assert.deepEqual(v, { ok: true });
});

// ── the session window ──────────────────────────────────────────────────────
test("a new session gets 30-day idle and 90-day absolute from ONE instant", () => {
  const w = newSessionWindow(NOW);
  assert.equal(w.createdAt.getTime(), NOW.getTime());
  assert.equal(w.lastUsedAt.getTime(), NOW.getTime());
  assert.equal(w.idleExpiresAt.getTime() - NOW.getTime(), IDLE_TTL_MS);
  assert.equal(w.absoluteExpiresAt.getTime() - NOW.getTime(), ABSOLUTE_TTL_MS);
});

test("the frozen parameters are exactly the ratified ones", () => {
  assert.equal(GRACE_WINDOW_MS, 120_000);
  assert.equal(IDLE_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(ABSOLUTE_TTL_MS, 90 * 24 * 60 * 60 * 1000);
});

console.log(`\n[refresh-session] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
