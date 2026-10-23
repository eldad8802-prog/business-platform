/**
 * Run: npx tsx lib/auth/admin-factor-change.test.ts
 *
 * Admin Control Center A1 — changing a platform-admin factor (adding or removing
 * a passkey, replacing the authenticator app) must not ride on an elevation that
 * is merely still alive, and replacing the authenticator must never leave a
 * window with no factor.
 *
 *   1. freshStepUpRefusal: an elevation minted ≤ 5 minutes ago passes; an older
 *      (still valid) one, a missing one, another admin's one are refused with the
 *      403 ADMIN_MFA_REQUIRED the client already answers with a fresh prompt.
 *   2. The replacement envelope: bound to the admin, to the seed it replaces and
 *      to a 10-minute life; tampering, another purpose or another user fail.
 *
 * Deterministic and OFFLINE: no database, no network.
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  ADMIN_FRESH_STEP_UP_MAX_AGE_SECONDS,
  ADMIN_MFA_REQUIRED_CODE,
  freshStepUpRefusal,
} from "./platform-admin";
import { ADMIN_ELEVATION_HEADER, issueAdminElevation } from "./platform-admin-elevation";
import { issuePasskeyChallenge } from "./admin-passkey-challenge";
import {
  MFA_REPLACEMENT_TTL_SECONDS,
  issueMfaReplacementToken,
  seedFingerprint,
  verifyMfaReplacementToken,
} from "./admin-mfa-replacement";

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "a1_factor_change_synthetic_secret";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const ADMIN = 21;
const OTHER = 99;
const T0 = 1_800_000_000_000;

const withElevation = (elevation?: string) =>
  new NextRequest("http://localhost/api/platform-admin/passkeys/register/options", {
    method: "POST",
    headers: elevation ? { [ADMIN_ELEVATION_HEADER]: elevation } : {},
  });

async function main() {
  /* ---------------------------- 1. fresh step-up --------------------------- */

  await check("an elevation minted just now passes", () => {
    assert.equal(freshStepUpRefusal(withElevation(issueAdminElevation(ADMIN, T0)), ADMIN, T0 + 1000), null);
  });

  await check("an elevation exactly at the 5-minute edge still passes", () => {
    const req = withElevation(issueAdminElevation(ADMIN, T0));
    assert.equal(freshStepUpRefusal(req, ADMIN, T0 + ADMIN_FRESH_STEP_UP_MAX_AGE_SECONDS * 1000), null);
  });

  await check("a still-valid but older elevation (6 of 15 minutes) is refused with ADMIN_MFA_REQUIRED", async () => {
    const res = freshStepUpRefusal(withElevation(issueAdminElevation(ADMIN, T0)), ADMIN, T0 + 6 * 60_000);
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code?: string; fresh?: boolean };
    assert.equal(body.code, ADMIN_MFA_REQUIRED_CODE);
    assert.equal(body.fresh, true);
  });

  await check("no elevation is refused", () => {
    assert.equal(freshStepUpRefusal(withElevation(), ADMIN, T0)?.status, 403);
  });

  await check("another admin's fresh elevation is refused", () => {
    assert.equal(freshStepUpRefusal(withElevation(issueAdminElevation(OTHER, T0)), ADMIN, T0)?.status, 403);
  });

  await check("a passkey challenge envelope is not an elevation", () => {
    const { token } = issuePasskeyChallenge(ADMIN, "authenticate", T0);
    assert.equal(freshStepUpRefusal(withElevation(token), ADMIN, T0)?.status, 403);
  });

  /* ------------------------- 2. replacement envelope ----------------------- */

  const current = "gcm_v1:current.seed.ciphertext";
  const replaces = seedFingerprint(current);
  const issue = (userId = ADMIN, now = T0) =>
    issueMfaReplacementToken({ userId, secretEncrypted: "gcm_v1:new.seed", encryptionKeyId: "k1", replaces }, now);

  await check("a fresh envelope verifies and carries the new seed and what it replaces", () => {
    assert.deepEqual(verifyMfaReplacementToken(issue(), ADMIN, T0 + 1000), {
      ok: true,
      secretEncrypted: "gcm_v1:new.seed",
      encryptionKeyId: "k1",
      replaces,
    });
  });

  await check("the fingerprint is the seed it was begun against (a later swap makes it stale)", () => {
    assert.equal(seedFingerprint(current), replaces);
    assert.notEqual(seedFingerprint("gcm_v1:new.seed"), replaces);
    assert.match(replaces, /^[0-9a-f]{64}$/);
  });

  await check("bound to the admin it was issued for", () => {
    assert.deepEqual(verifyMfaReplacementToken(issue(), OTHER, T0), { ok: false, reason: "user_mismatch" });
  });

  await check("expires after 10 minutes", () => {
    assert.deepEqual(verifyMfaReplacementToken(issue(), ADMIN, T0 + MFA_REPLACEMENT_TTL_SECONDS * 1000), {
      ok: false,
      reason: "expired",
    });
  });

  await check("a tampered payload fails the signature", () => {
    const token = issue();
    const [payload, sig] = token.split(".");
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    forged.enc = "gcm_v1:attacker.seed";
    const forgedB64 = Buffer.from(JSON.stringify(forged), "utf8").toString("base64url");
    assert.deepEqual(verifyMfaReplacementToken(`${forgedB64}.${sig}`, ADMIN, T0), { ok: false, reason: "bad_signature" });
  });

  await check("an elevation or a passkey challenge is not a replacement envelope", () => {
    assert.equal(verifyMfaReplacementToken(issueAdminElevation(ADMIN, T0), ADMIN, T0).ok, false);
    assert.equal(verifyMfaReplacementToken(issuePasskeyChallenge(ADMIN, "register", T0).token, ADMIN, T0).ok, false);
  });

  await check("garbage never throws", () => {
    for (const raw of [undefined, null, "", "a", "a.b.c", ".", "x".repeat(5000), 42]) {
      assert.equal(verifyMfaReplacementToken(raw, ADMIN, T0).ok, false);
    }
  });

  console.log(`\nAdmin factor change (A1): OK — ${passed} checks passed`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
