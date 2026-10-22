/**
 * Run: npx tsx lib/auth/admin-passkey.test.ts
 *
 * Admin Control Center A1 — adversarial matrix for the platform-admin passkey
 * factor: the ceremony challenge envelope (what binds an options call to its
 * verify call) and the availability decision (when the factor may be offered).
 *
 * Deterministic and OFFLINE: no database, no network, no authenticator. The
 * WebAuthn signature checks themselves are @simplewebauthn/server's (pinned);
 * the database half (the single-winner acceptance UPDATE, the grants) is proven
 * as the real roles by .apa1/battery.ts.
 */
import assert from "node:assert/strict";
import {
  PASSKEY_CHALLENGE_TTL_SECONDS,
  issuePasskeyChallenge,
  verifyPasskeyChallenge,
} from "./admin-passkey-challenge";
import { issueAdminElevation, verifyAdminElevation } from "./platform-admin-elevation";
import { challengeBytes, normalizePasskeyLabel, passkeyAvailability } from "./admin-passkey.service";
import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "a1_synthetic_secret_not_a_real_key";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const ADMIN = 21;
const OTHER = 99;
const T0 = 1_800_000_000_000;

check("a fresh registration challenge verifies for its user and ceremony", () => {
  const { challenge, token } = issuePasskeyChallenge(ADMIN, "register", T0);
  const r = verifyPasskeyChallenge(token, ADMIN, "register", T0 + 1000);
  assert.deepEqual(r, { ok: true, challenge, issuedAt: new Date(T0) });
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
});

check("a challenge is bound to the user it was issued for", () => {
  const { token } = issuePasskeyChallenge(ADMIN, "authenticate", T0);
  assert.deepEqual(verifyPasskeyChallenge(token, OTHER, "authenticate", T0), { ok: false, reason: "user_mismatch" });
});

check("a registration challenge cannot finish an authentication (and vice versa)", () => {
  const reg = issuePasskeyChallenge(ADMIN, "register", T0).token;
  const auth = issuePasskeyChallenge(ADMIN, "authenticate", T0).token;
  assert.equal(verifyPasskeyChallenge(reg, ADMIN, "authenticate", T0).ok, false);
  assert.equal(verifyPasskeyChallenge(auth, ADMIN, "register", T0).ok, false);
});

check(`a challenge expires after ${PASSKEY_CHALLENGE_TTL_SECONDS}s`, () => {
  const { token } = issuePasskeyChallenge(ADMIN, "authenticate", T0);
  assert.equal(verifyPasskeyChallenge(token, ADMIN, "authenticate", T0 + (PASSKEY_CHALLENGE_TTL_SECONDS - 1) * 1000).ok, true);
  assert.deepEqual(verifyPasskeyChallenge(token, ADMIN, "authenticate", T0 + PASSKEY_CHALLENGE_TTL_SECONDS * 1000), {
    ok: false,
    reason: "expired",
  });
});

check("a tampered payload or signature is refused", () => {
  const { token } = issuePasskeyChallenge(ADMIN, "authenticate", T0);
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), sub: OTHER })
  ).toString("base64url");
  assert.equal(verifyPasskeyChallenge(`${forged}.${sig}`, OTHER, "authenticate", T0).ok, false);
  const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
  assert.equal(verifyPasskeyChallenge(`${payload}.${flipped}`, ADMIN, "authenticate", T0).ok, false);
});

check("garbage never throws and is refused", () => {
  for (const raw of [undefined, null, "", "x", "a.b.c", 42, {}, "x".repeat(5000)]) {
    assert.equal(verifyPasskeyChallenge(raw, ADMIN, "authenticate", T0).ok, false);
  }
});

check("purpose isolation: an elevation is not a challenge, a challenge is not an elevation", () => {
  const elevation = issueAdminElevation(ADMIN, T0);
  assert.equal(verifyPasskeyChallenge(elevation, ADMIN, "authenticate", T0).ok, false);
  const { token } = issuePasskeyChallenge(ADMIN, "authenticate", T0);
  assert.equal(verifyAdminElevation(token, ADMIN, T0).ok, false);
});

check("two challenges for the same user never collide", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) seen.add(issuePasskeyChallenge(ADMIN, "authenticate", T0).challenge);
  assert.equal(seen.size, 200);
});

check("the replay guard's ordering key: a verified challenge carries its millisecond issue time", () => {
  const first = issuePasskeyChallenge(ADMIN, "authenticate", T0);
  const later = issuePasskeyChallenge(ADMIN, "authenticate", T0 + 1);
  const a = verifyPasskeyChallenge(first.token, ADMIN, "authenticate", T0 + 5);
  const b = verifyPasskeyChallenge(later.token, ADMIN, "authenticate", T0 + 5);
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) {
    assert.equal(a.issuedAt.getTime(), T0);
    // Strictly ordered even within the same second: an older assertion is refusable.
    assert.ok(b.issuedAt.getTime() > a.issuedAt.getTime());
  }
});

check("availability: OFF unless the flag is exactly true", () => {
  for (const v of [undefined, "", "false", "1", "yes"]) {
    assert.deepEqual(passkeyAvailability({ PLATFORM_ADMIN_PASSKEY_ENABLED: v, AUTH_PLANE_ENABLED: "true", APP_BASE_URL: "https://app.example" } as NodeJS.ProcessEnv), {
      enabled: false,
      reason: "FLAG_OFF",
    });
  }
});

check("availability: refuses the legacy auth plane (never reaches for the tenant runtime)", () => {
  const prev = process.env.AUTH_PLANE_ENABLED;
  process.env.AUTH_PLANE_ENABLED = "false";
  try {
    assert.deepEqual(
      passkeyAvailability({ PLATFORM_ADMIN_PASSKEY_ENABLED: "true", APP_BASE_URL: "https://app.example" } as NodeJS.ProcessEnv),
      { enabled: false, reason: "AUTH_PLANE_LEGACY" }
    );
  } finally {
    if (prev === undefined) delete process.env.AUTH_PLANE_ENABLED;
    else process.env.AUTH_PLANE_ENABLED = prev;
  }
});

check("availability: binds the relying party to APP_BASE_URL, https only (localhost excepted)", () => {
  const prev = process.env.AUTH_PLANE_ENABLED;
  process.env.AUTH_PLANE_ENABLED = "true";
  try {
    const on = (base: string | undefined) =>
      passkeyAvailability({ PLATFORM_ADMIN_PASSKEY_ENABLED: "true", APP_BASE_URL: base } as NodeJS.ProcessEnv);
    assert.deepEqual(on("https://app.dubiz.example/x"), { enabled: true, rpID: "app.dubiz.example", origin: "https://app.dubiz.example" });
    assert.deepEqual(on("http://app.dubiz.example"), { enabled: false, reason: "NO_BASE_URL" });
    assert.deepEqual(on(undefined), { enabled: false, reason: "NO_BASE_URL" });
    assert.deepEqual(on("not a url"), { enabled: false, reason: "NO_BASE_URL" });
    assert.equal(on("http://localhost:3000").enabled, true);
  } finally {
    if (prev === undefined) delete process.env.AUTH_PLANE_ENABLED;
    else process.env.AUTH_PLANE_ENABLED = prev;
  }
});

const pendingChallengeCheck = checkAsync("the browser is asked to sign EXACTLY the challenge the envelope vouches for", async () => {
  const { challenge } = issuePasskeyChallenge(ADMIN, "register", T0);
  const reg = await generateRegistrationOptions({
    rpName: "x",
    rpID: "localhost",
    userName: "a@b.invalid",
    challenge: challengeBytes(challenge),
  });
  assert.equal(reg.challenge, challenge);
  const auth = await generateAuthenticationOptions({ rpID: "localhost", challenge: challengeBytes(challenge) });
  assert.equal(auth.challenge, challenge);
  // The trap this pins: a STRING challenge is re-encoded by the library and no longer matches.
  const wrong = await generateAuthenticationOptions({ rpID: "localhost", challenge });
  assert.notEqual(wrong.challenge, challenge);
});

check("labels are trimmed, collapsed, bounded and defaulted", () => {
  assert.equal(normalizePasskeyLabel("  iPhone   של העבודה "), "iPhone של העבודה");
  assert.equal(normalizePasskeyLabel(""), "מפתח גישה");
  assert.equal(normalizePasskeyLabel(null), "מפתח גישה");
  assert.equal(normalizePasskeyLabel("x".repeat(200)).length, 60);
});

void pendingChallengeCheck.then(
  () => console.log(`\nplatform-admin passkeys (A1): OK — ${passed} checks passed`),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
