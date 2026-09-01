/**
 * Run: npx tsx lib/auth-token.test.ts
 *
 * CASA Wave A — the application session token lifetime (CASA 2.2.3).
 *
 * 2.2.3 verification, identical at AL1 and AL2:
 *   "Non-revocable stateless authentication tokens shall have an expiration
 *    time within 24 hours of being issued."
 *
 * This token IS such a token: a stateless HMAC-SHA256 envelope with no
 * server-side session store, no jti and no revocation list. It was issued with
 * a 30-day lifetime before Wave A.
 *
 * These tests assert the ceiling holds for every configuration path, including
 * hostile ones — the guarantee must not depend on an environment variable being
 * present and correct.
 *
 * Deterministic, offline: no DB, no network, no real secret.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTH_TOKEN_MAX_TTL_SECONDS,
  resolveAuthTokenTtlSeconds,
  signAuthToken,
  verifyAuthToken,
} from "./auth-token";
import { GMAIL_STATE_TTL_SECONDS } from "./services/integrations/gmail/signed-state.service";
import { AUTHORITY_STATE_TTL_SECONDS } from "./services/billing/authority/billing-authority-signed-state.service";

const ONE_DAY = 24 * 60 * 60;

/** Read a token's payload without verifying — tests inspect, they don't trust. */
function payloadOf(token: string): { sub: number; iat: number; exp: number } {
  const [, payloadB64] = token.split(".");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.AUTH_TOKEN_TTL_SECONDS;
  if (value === undefined) delete process.env.AUTH_TOKEN_TTL_SECONDS;
  else process.env.AUTH_TOKEN_TTL_SECONDS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AUTH_TOKEN_TTL_SECONDS;
    else process.env.AUTH_TOKEN_TTL_SECONDS = prev;
  }
}

process.env.AUTH_TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || "wave_a_local_synthetic_secret_not_a_real_key";

function main() {
  // --- 0. the ceiling is 24h, in code ---------------------------------------
  assert.equal(
    AUTH_TOKEN_MAX_TTL_SECONDS,
    ONE_DAY,
    "CASA 2.2.3 ceiling must be 86400 seconds"
  );

  // --- 1. default issued token expires within 24h ---------------------------
  {
    const token = withEnv(undefined, () => signAuthToken(1));
    const { iat, exp } = payloadOf(token);
    const life = exp - iat;
    assert.equal(life, ONE_DAY, "default lifetime must be exactly 24h");
    assert.ok(life <= ONE_DAY, "default lifetime must not exceed 24h");
    // Also assert against wall-clock issuance, not just the self-declared iat,
    // so a token cannot claim a short life while being valid far longer.
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(
      exp - nowSec <= ONE_DAY + 5,
      "expiry measured from real issuance time must be within 24h"
    );
  }

  // --- 2. an override BELOW the ceiling is respected -------------------------
  {
    const token = withEnv("3600", () => signAuthToken(2));
    const { iat, exp } = payloadOf(token);
    assert.equal(exp - iat, 3600, "a shorter configured TTL must be honoured");
  }

  // --- 3. an override ABOVE the ceiling is clamped ---------------------------
  {
    for (const hostile of [
      String(30 * ONE_DAY), // the old 30-day value
      "86401", // one second over
      "999999999",
      "1e12", // exponent notation
      " 604800 ", // padded
    ]) {
      const token = withEnv(hostile, () => signAuthToken(3));
      const { iat, exp } = payloadOf(token);
      assert.ok(
        exp - iat <= ONE_DAY,
        `override "${hostile}" must be clamped to <= 24h, got ${exp - iat}s`
      );
      assert.equal(
        resolveAuthTokenTtlSeconds(hostile),
        ONE_DAY,
        `override "${hostile}" must clamp to exactly the ceiling`
      );
    }
  }

  // --- 4. malformed overrides cannot produce an overlong token --------------
  {
    for (const bad of ["", "   ", "abc", "-1", "0", "NaN", "Infinity", "1_000"]) {
      const token = withEnv(bad, () => signAuthToken(4));
      const { iat, exp } = payloadOf(token);
      assert.ok(
        exp - iat <= ONE_DAY,
        `malformed override "${bad}" must not exceed 24h, got ${exp - iat}s`
      );
    }
    // Undefined (the production state — the variable is absent) is compliant.
    assert.equal(resolveAuthTokenTtlSeconds(undefined), ONE_DAY);
  }

  // --- 5. verification rejects an expired token ------------------------------
  {
    // Issue with a 1-second life, then move past it without sleeping.
    const token = withEnv("1", () => signAuthToken(5));
    assert.equal(verifyAuthToken(token), 5, "must be valid before expiry");
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5_000;
      assert.equal(
        verifyAuthToken(token),
        null,
        "an expired token must be rejected"
      );
    } finally {
      Date.now = realNow;
    }
  }

  // --- 6. a valid token still round-trips (login path not broken) -----------
  {
    const token = withEnv(undefined, () => signAuthToken(42));
    assert.equal(verifyAuthToken(token), 42, "a fresh token must verify");
  }

  // --- 7. a token signed under a DIFFERENT secret is rejected ---------------
  //        This is the mechanism the compliance cutover relies on: rotating
  //        AUTH_TOKEN_SECRET invalidates every previously issued token.
  {
    const prev = process.env.AUTH_TOKEN_SECRET;
    process.env.AUTH_TOKEN_SECRET = "secret_before_rotation";
    const oldToken = withEnv(undefined, () => signAuthToken(7));
    assert.equal(verifyAuthToken(oldToken), 7, "valid under the old secret");
    process.env.AUTH_TOKEN_SECRET = "secret_after_rotation";
    assert.equal(
      verifyAuthToken(oldToken),
      null,
      "a token issued before rotation must be rejected after it"
    );
    const newToken = withEnv(undefined, () => signAuthToken(7));
    assert.equal(verifyAuthToken(newToken), 7, "a token issued after rotation verifies");
    assert.notEqual(oldToken, newToken, "rotation must change the signature");
    process.env.AUTH_TOKEN_SECRET = prev;
  }

  // --- 8. tampering with exp to extend the token breaks the signature -------
  {
    const token = withEnv(undefined, () => signAuthToken(8));
    const [version, payloadB64, sig] = token.split(".");
    const p = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    p.exp = p.iat + 30 * ONE_DAY; // try to buy back the old 30 days
    const forged = `${version}.${Buffer.from(JSON.stringify(p), "utf8").toString(
      "base64url"
    )}.${sig}`;
    assert.equal(
      verifyAuthToken(forged),
      null,
      "an extended exp must fail signature verification"
    );
  }

  // --- 9. the OAuth state windows are INDEPENDENT and unchanged -------------
  //        Wave A narrowed exactly one lifetime. The Gmail and ITA OAuth state
  //        envelopes derive their HMAC key from the same server secret, but
  //        carry their own 10-minute TTL, which must not move with it.
  {
    assert.equal(
      GMAIL_STATE_TTL_SECONDS,
      10 * 60,
      "Gmail OAuth state TTL must stay 10 minutes, independent of the session TTL"
    );
    assert.equal(
      AUTHORITY_STATE_TTL_SECONDS,
      10 * 60,
      "ITA authority OAuth state TTL must stay 10 minutes"
    );
    assert.notEqual(
      GMAIL_STATE_TTL_SECONDS,
      AUTH_TOKEN_MAX_TTL_SECONDS,
      "the two lifetimes must not be coupled"
    );
  }

  // --- 10. Google OAuth token handling is untouched by this change ----------
  //         Gmail access/refresh tokens are provider-issued, stored encrypted
  //         under a SEPARATE key, and their expiry comes from Google's
  //         `expires_in` — never from the application session TTL. Asserting
  //         the key separation here makes an accidental future coupling a
  //         test failure rather than a silent compliance and data hazard.
  {
    const cryptoSrc = readFileSync(
      new URL(
        "./services/integrations/gmail/token-crypto.placeholder.ts",
        import.meta.url
      ),
      "utf8"
    );
    assert.ok(
      cryptoSrc.includes("GMAIL_TOKEN_ENCRYPTION_KEY"),
      "Gmail token encryption must use its own key"
    );
    assert.ok(
      !cryptoSrc.includes("AUTH_TOKEN_SECRET"),
      "Gmail token encryption must NOT depend on AUTH_TOKEN_SECRET — rotating " +
        "the session secret must never touch stored Google tokens"
    );
    assert.ok(
      !cryptoSrc.includes("AUTH_TOKEN_TTL_SECONDS"),
      "Gmail token lifetime must not be governed by the session TTL"
    );
  }

  console.log("auth-token TTL (Wave A / CASA 2.2.3): OK — 10/10");
}

main();
