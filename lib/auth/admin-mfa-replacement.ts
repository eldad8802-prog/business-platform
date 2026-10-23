/**
 * Platform-admin authenticator REPLACEMENT envelope — carries a not-yet-active
 * TOTP seed from "begin" to "confirm" without storing it, so replacing the
 * authenticator app is one atomic swap instead of reset-then-enroll.
 *
 * Why not reset + enroll: a reset deletes the record (recovery codes included)
 * and enrollment is identity-only and first-come, so between the two calls
 * anyone holding the session could enroll an authenticator of their own and lock
 * the owner out. With this envelope the OLD authenticator stays active until a
 * code from the NEW one is proven, and the swap is a single update.
 *
 * Same construction as the MFA elevation (platform-admin-elevation.ts): an
 * HMAC-SHA256 envelope under a PURPOSE-DERIVED subkey of AUTH_TOKEN_SECRET, so it
 * can never validate as an elevation, a session or any other envelope.
 *
 * Properties:
 *   - the seed inside is already AES-GCM ciphertext under ADMIN_MFA_ENCRYPTION_KEY
 *     (admin-mfa-crypto.ts): the client holds it, but cannot read it;
 *   - bound to `sub` (the admin's user id);
 *   - bound to the CURRENT seed it replaces (`replaces` = sha256 of the stored
 *     ciphertext): once the swap happens the envelope no longer matches, so it is
 *     single use, and an envelope begun before another change is refused;
 *   - lifetime 10 minutes — long enough to scan a QR code and type one code.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const PURPOSE = "platform-admin-mfa-replacement";
const KEY_DERIVATION_LABEL = "dubiz-platform-admin-mfa-replacement-v1";

export const MFA_REPLACEMENT_TTL_SECONDS = 10 * 60;

type ReplacementPayload = {
  v: number;
  purpose: string;
  sub: number;
  /** The NEW seed, as stored ciphertext (`gcm_v1:…`). */
  enc: string;
  kid: string;
  /** sha256(hex) of the ciphertext this replacement is allowed to overwrite. */
  replaces: string;
  iat: number;
  exp: number;
};

export type ReplacementVerifyResult =
  | { ok: true; secretEncrypted: string; encryptionKeyId: string; replaces: string }
  | {
      ok: false;
      reason: "missing" | "malformed" | "bad_signature" | "wrong_purpose" | "expired" | "user_mismatch";
    };

function deriveKey(): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) {
    throw new Error("AUTH_TOKEN_SECRET is not configured");
  }
  return createHmac("sha256", secret).update(KEY_DERIVATION_LABEL).digest();
}

function sign(payloadB64: string): Buffer {
  return createHmac("sha256", deriveKey()).update(payloadB64).digest();
}

/** Fingerprint of a stored seed ciphertext (what a replacement is bound to). */
export function seedFingerprint(secretEncrypted: string): string {
  return createHash("sha256").update(secretEncrypted, "utf8").digest("hex");
}

export function issueMfaReplacementToken(
  input: { userId: number; secretEncrypted: string; encryptionKeyId: string; replaces: string },
  nowMs: number = Date.now()
): string {
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new Error("userId must be a positive integer");
  }
  const iat = Math.floor(nowMs / 1000);
  const payload: ReplacementPayload = {
    v: VERSION,
    purpose: PURPOSE,
    sub: input.userId,
    enc: input.secretEncrypted,
    kid: input.encryptionKeyId,
    replaces: input.replaces,
    iat,
    exp: iat + MFA_REPLACEMENT_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64).toString("base64url")}`;
}

/** Verify an envelope for this user. Never throws for bad input. */
export function verifyMfaReplacementToken(
  raw: unknown,
  expectedUserId: number,
  nowMs: number = Date.now()
): ReplacementVerifyResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "missing" };
  if (raw.length > 4096) return { ok: false, reason: "malformed" };
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1 || raw.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64 = raw.slice(0, dot);
  const provided = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = sign(payloadB64);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: ReplacementPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ReplacementPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.purpose !== PURPOSE || payload.v !== VERSION) return { ok: false, reason: "wrong_purpose" };
  if (
    typeof payload.enc !== "string" ||
    payload.enc.length === 0 ||
    typeof payload.kid !== "string" ||
    payload.kid.length === 0 ||
    typeof payload.replaces !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.replaces) ||
    !Number.isInteger(payload.exp)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(nowMs / 1000) >= payload.exp) return { ok: false, reason: "expired" };
  if (payload.sub !== expectedUserId) return { ok: false, reason: "user_mismatch" };
  return { ok: true, secretEncrypted: payload.enc, encryptionKeyId: payload.kid, replaces: payload.replaces };
}
