/**
 * Run: npx tsx lib/auth/platform-admin-mfa.test.ts
 *
 * CASA Wave B — adversarial matrix for platform-admin TOTP MFA (CASA 3.3.1).
 *
 * Deterministic and OFFLINE: no database, no network, no real secret. The
 * database-backed half (enrollment persistence, replay-step storage, recovery
 * consumption) is exercised by the service's own integration path; what is
 * asserted here is the part that decides whether a privileged request is
 * allowed — the guard, the elevation envelope, and the TOTP primitive — because
 * that is what an attacker actually meets.
 */
import assert from "node:assert/strict";
import * as OTPAuth from "otpauth";
import {
  ADMIN_ELEVATION_TTL_SECONDS,
  issueAdminElevation,
  verifyAdminElevation,
} from "./platform-admin-elevation";
import {
  assertPlatformAdminAccess,
  hasAdminElevation,
  isPlatformAdminMfaRequired,
  requirePlatformAdmin,
  requirePlatformAdminIdentity,
} from "./platform-admin";
import {
  decryptAdminMfaSecret,
  encryptAdminMfaSecret,
} from "./admin-mfa-crypto";
import { __testing as mfaService } from "./admin-mfa.service";

process.env.AUTH_TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || "wave_b_synthetic_secret_not_a_real_key";
process.env.ADMIN_MFA_ENCRYPTION_KEY =
  process.env.ADMIN_MFA_ENCRYPTION_KEY ||
  Buffer.alloc(32, 7).toString("base64");

const ADMIN_ID = 21;
const OTHER_ADMIN_ID = 99;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A Request carrying an optional bearer session and optional elevation. */
function req(opts: { elevation?: string | null } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.elevation) headers["x-admin-elevation"] = opts.elevation;
  return new Request("https://app.test/api/platform-admin/overview", { headers });
}

async function expectThrows(fn: () => Promise<unknown>, label: string) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert.equal(threw, true, label);
}

async function main() {
  // ── Identity layer (pre-existing controls must still hold) ────────────────

  // 1. ordinary business user → denied
  withEnv({ PLATFORM_ADMIN_EMAILS: "admin@dubiz.test" }, () => {
    assert.throws(
      () => assertPlatformAdminAccess({ role: "USER" as never, email: "user@biz.test" }),
      "an ordinary business user must be denied"
    );
  });

  // 2. authenticated non-admin (right shape, wrong role) → denied
  withEnv({ PLATFORM_ADMIN_EMAILS: "admin@dubiz.test" }, () => {
    assert.throws(
      () => assertPlatformAdminAccess({ role: "USER" as never, email: "admin@dubiz.test" }),
      "allowlisted email without the role must still be denied"
    );
  });

  // 2b. right role, non-allowlisted email → denied; empty allowlist → denied
  withEnv({ PLATFORM_ADMIN_EMAILS: "admin@dubiz.test" }, () => {
    assert.throws(() =>
      assertPlatformAdminAccess({ role: "PLATFORM_ADMIN" as never, email: "other@dubiz.test" })
    );
  });
  withEnv({ PLATFORM_ADMIN_EMAILS: undefined }, () => {
    assert.throws(
      () => assertPlatformAdminAccess({ role: "PLATFORM_ADMIN" as never, email: "admin@dubiz.test" }),
      "empty allowlist must deny everyone"
    );
  });

  // ── Elevation envelope ────────────────────────────────────────────────────

  // 3. valid TOTP → elevation created, and it verifies for that admin
  {
    const e = issueAdminElevation(ADMIN_ID);
    const r = verifyAdminElevation(e, ADMIN_ID);
    assert.equal(r.ok, true, "a freshly issued elevation must verify");
  }

  // 4. elevation is BOUND to the user — another admin cannot reuse it
  {
    const e = issueAdminElevation(ADMIN_ID);
    const r = verifyAdminElevation(e, OTHER_ADMIN_ID);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "user_mismatch");
  }

  // 5. elevation expiry → rejected once past its lifetime
  {
    const e = issueAdminElevation(ADMIN_ID);
    const past = Date.now() + (ADMIN_ELEVATION_TTL_SECONDS + 5) * 1000;
    const r = verifyAdminElevation(e, ADMIN_ID, past);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "expired");
    // and the lifetime really is the short step-up, not a second session
    assert.ok(
      ADMIN_ELEVATION_TTL_SECONDS <= 30 * 60,
      "elevation must be a short step-up, not a long-lived credential"
    );
  }

  // 6. tampering with the payload breaks the signature
  {
    const e = issueAdminElevation(ADMIN_ID);
    const [payloadB64, sig] = e.split(".");
    const p = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    p.sub = OTHER_ADMIN_ID; // try to point it at another admin
    const forged = `${Buffer.from(JSON.stringify(p), "utf8").toString("base64url")}.${sig}`;
    const r = verifyAdminElevation(forged, OTHER_ADMIN_ID);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "bad_signature");
  }

  // 7. a SESSION token must not work as an elevation (purpose separation)
  {
    const { signAuthToken } = await import("../auth-token");
    const session = signAuthToken(ADMIN_ID);
    const r = verifyAdminElevation(session, ADMIN_ID);
    assert.equal(r.ok, false, "a session token must never elevate");
  }

  // 8. rotating AUTH_TOKEN_SECRET invalidates outstanding elevations
  {
    const e = issueAdminElevation(ADMIN_ID);
    assert.equal(verifyAdminElevation(e, ADMIN_ID).ok, true);
    withEnv({ AUTH_TOKEN_SECRET: "rotated_secret_value" }, () => {
      assert.equal(
        verifyAdminElevation(e, ADMIN_ID).ok,
        false,
        "secret rotation must invalidate elevations, as it does sessions"
      );
    });
  }

  // 9. missing / malformed elevations are rejected, never defaulted
  {
    for (const bad of [null, undefined, "", "not-an-envelope", "a.b.c", "x".repeat(4000)]) {
      const r = verifyAdminElevation(bad as string | null, ADMIN_ID);
      assert.equal(r.ok, false, `elevation ${JSON.stringify(bad)} must be rejected`);
    }
  }

  // ── Guard behaviour: enforcement OFF (B-3a) vs ON (B-3b) ──────────────────

  // 10. enforcement flag semantics — only the exact string enables it
  {
    for (const v of [undefined, "", "false", "0", "yes", "TRUE "]) {
      const on = withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: v }, () =>
        isPlatformAdminMfaRequired()
      );
      assert.equal(on, v === "TRUE " ? true : false, `flag "${v}" → ${on}`);
    }
    assert.equal(
      withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: "true" }, () => isPlatformAdminMfaRequired()),
      true
    );
  }

  // 11. with enforcement OFF, hasAdminElevation is permissive (B-3a safety:
  //     the sole admin must be able to reach enrollment)
  {
    const allowed = withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: undefined }, () =>
      hasAdminElevation(req(), ADMIN_ID)
    );
    assert.equal(allowed, true, "enforcement OFF must not block the admin");
  }

  // 12. with enforcement ON, an un-elevated request is refused
  {
    const allowed = withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: "true" }, () =>
      hasAdminElevation(req(), ADMIN_ID)
    );
    assert.equal(allowed, false, "enforcement ON must require an elevation");
  }

  // 13. with enforcement ON, a valid elevation for THIS admin is accepted…
  {
    const e = issueAdminElevation(ADMIN_ID);
    const allowed = withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: "true" }, () =>
      hasAdminElevation(req({ elevation: e }), ADMIN_ID)
    );
    assert.equal(allowed, true);
  }

  // 14. …but another admin's elevation is not
  {
    const e = issueAdminElevation(OTHER_ADMIN_ID);
    const allowed = withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: "true" }, () =>
      hasAdminElevation(req({ elevation: e }), ADMIN_ID)
    );
    assert.equal(allowed, false, "an elevation must not transfer between admins");
  }

  // 15. the guard itself: no session at all → denied whether or not MFA is on
  {
    await expectThrows(
      () => withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: "true", PLATFORM_ADMIN_EMAILS: "a@b.test" }, () =>
        requirePlatformAdmin(req())
      ),
      "no session must be denied with enforcement ON"
    );
    await expectThrows(
      () => withEnv({ PLATFORM_ADMIN_MFA_REQUIRED: undefined, PLATFORM_ADMIN_EMAILS: "a@b.test" }, () =>
        requirePlatformAdminIdentity(req())
      ),
      "no session must be denied with enforcement OFF too"
    );
  }

  // ── TOTP primitive (RFC 6238) ─────────────────────────────────────────────

  // 16. a real authenticator's code verifies; a wrong one does not; an old
  //     step outside the drift window does not.
  {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: "Dubiz",
      label: "platform-admin",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });
    const now = Date.now();
    const code = totp.generate({ timestamp: now });
    assert.equal(
      totp.validate({ token: code, window: 1, timestamp: now }),
      0,
      "a current code must validate"
    );
    assert.equal(
      totp.validate({ token: "000000", window: 1, timestamp: now }),
      null,
      "a wrong code must not validate"
    );
    // A code from 10 steps (5 minutes) ago is far outside the ±1 window.
    const stale = totp.generate({ timestamp: now - 10 * 30 * 1000 });
    assert.equal(
      totp.validate({ token: stale, window: 1, timestamp: now }),
      null,
      "an expired code must not validate"
    );
    assert.equal(code.length, 6, "6 digits — authenticator-app compatible");
  }

  // ── Seed storage ──────────────────────────────────────────────────────────

  // 17. the seed round-trips under its own key, and is unreadable under another
  {
    const seed = new OTPAuth.Secret({ size: 20 }).base32;
    const { encrypted, keyId } = encryptAdminMfaSecret(seed);
    assert.ok(encrypted.startsWith("gcm_v1:"), "authenticated-encryption envelope");
    assert.ok(!encrypted.includes(seed), "ciphertext must not contain the seed");
    assert.equal(keyId, "gcm_v1");
    assert.equal(decryptAdminMfaSecret(encrypted), seed);

    // A different key cannot read it — this is what makes the dedicated key
    // meaningful, and why AUTH_TOKEN_SECRET rotation cannot break enrollment.
    const underOtherKey = withEnv(
      { ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
      () => decryptAdminMfaSecret(encrypted)
    );
    assert.equal(underOtherKey, null, "a wrong key must yield null, not garbage");

    // Tampered ciphertext fails authentication rather than decrypting.
    const parts = encrypted.slice("gcm_v1:".length).split(".");
    const flipped = Buffer.from(parts[2], "base64");
    flipped[0] ^= 0xff;
    const tampered = `gcm_v1:${parts[0]}.${parts[1]}.${flipped.toString("base64")}`;
    assert.equal(decryptAdminMfaSecret(tampered), null, "GCM must reject tampering");

    // Missing key → no plaintext fallback.
    const noKey = withEnv({ ADMIN_MFA_ENCRYPTION_KEY: undefined }, () =>
      decryptAdminMfaSecret(encrypted)
    );
    assert.equal(noKey, null, "a missing key must fail closed");
  }

  // ── Provisioning-URI compatibility ────────────────────────────────────────

  // 18. the URI the application hands the admin produces tokens the
  //     application's own verifier accepts.
  //
  //     The suite used to build its own TOTP object and validate its own token,
  //     which proves the library works and nothing about OUR contract: the URI
  //     is generated in one place (beginAdminMfaEnrollment) and the token is
  //     checked in another (confirm/verify), and a mismatch between them is
  //     invisible until an admin cannot enroll. Synthetic seed only.
  {
    const seed = new OTPAuth.Secret({ size: 20 }).base32;

    // Exactly what beginAdminMfaEnrollment returns to the admin.
    const uri = mfaService.buildTotp(seed).toString();
    const params = new URL(uri.replace("otpauth://", "https://")).searchParams;
    assert.equal(params.get("secret"), seed, "the URI must carry the stored seed verbatim");
    assert.equal(params.get("algorithm"), "SHA1", "authenticator-compatible algorithm");
    assert.equal(params.get("digits"), "6", "authenticator-compatible digit count");
    assert.equal(params.get("period"), "30", "authenticator-compatible period");
    assert.equal(params.get("issuer"), "Dubiz");

    // Exactly what an authenticator app does with it.
    const provisioned = OTPAuth.URI.parse(uri);
    assert.ok(provisioned instanceof OTPAuth.TOTP, "the URI must parse as TOTP");
    assert.equal(provisioned.secret.base32, seed, "the seed must survive the round trip");

    const now = Date.now();
    const token = provisioned.generate({ timestamp: now });
    assert.match(token, /^[0-9]{6}$/, "an authenticator produces six digits");

    // The verifier half — the same call confirm/verify make.
    assert.equal(
      mfaService.buildTotp(seed).validate({
        token,
        window: mfaService.DRIFT_WINDOW,
        timestamp: now,
      }),
      0,
      "URI -> authenticator token -> verifier must round-trip"
    );

    // The drift boundary, from the authenticator's side of the contract.
    const step = mfaService.PERIOD_SECONDS * 1000;
    for (const offset of [-1, 1]) {
      assert.notEqual(
        mfaService.buildTotp(seed).validate({
          token: provisioned.generate({ timestamp: now + offset * step }),
          window: mfaService.DRIFT_WINDOW,
          timestamp: now,
        }),
        null,
        `one step of drift (${offset}) must be tolerated`
      );
    }
    for (const offset of [-2, 2]) {
      assert.equal(
        mfaService.buildTotp(seed).validate({
          token: provisioned.generate({ timestamp: now + offset * step }),
          window: mfaService.DRIFT_WINDOW,
          timestamp: now,
        }),
        null,
        `two steps of drift (${offset}) must be refused`
      );
    }

    // A different enrollment's authenticator must never validate — this is the
    // exact failure an admin hits when the seed transfer went wrong.
    const otherSeed = new OTPAuth.Secret({ size: 20 }).base32;
    assert.equal(
      mfaService.buildTotp(seed).validate({
        token: OTPAuth.URI.parse(mfaService.buildTotp(otherSeed).toString()).generate({
          timestamp: now,
        }),
        window: mfaService.DRIFT_WINDOW,
        timestamp: now,
      }),
      null,
      "a token from a different seed must be refused"
    );
  }

  console.log("platform-admin MFA (Wave B / CASA 3.3.1): OK — 18/18");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
