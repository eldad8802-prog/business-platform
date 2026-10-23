/**
 * Platform-admin passkey ceremony challenge — a short-lived, tamper-evident
 * envelope that carries the WebAuthn challenge from the options call to the
 * verify call without storing it.
 *
 * Same construction as the MFA elevation (platform-admin-elevation.ts): an
 * HMAC-SHA256 envelope under a PURPOSE-DERIVED subkey of AUTH_TOKEN_SECRET, so
 * a challenge envelope can never validate as an elevation, a session or any
 * other envelope, and vice versa.
 *
 * Properties:
 *   - bound to `sub` (the admin's user id) and to the ceremony KIND, so a
 *     registration challenge cannot finish an authentication and vice versa;
 *   - lifetime 2 minutes — a ceremony, not a session;
 *   - single use is enforced where it matters: an authentication records the
 *     challenge's issue time on the credential it used and only a STRICTLY newer
 *     challenge is accepted afterwards, so no signed assertion — the last one or
 *     any older one still inside its 2 minutes — can be accepted twice
 *     (admin-passkey.service.ts); a registration cannot be replayed because the
 *     credential id is unique.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const PURPOSE = "platform-admin-passkey-challenge";
const KEY_DERIVATION_LABEL = "dubiz-platform-admin-passkey-challenge-v1";

export const PASSKEY_CHALLENGE_TTL_SECONDS = 120;

export type PasskeyCeremony = "register" | "authenticate";

type ChallengePayload = {
  v: number;
  purpose: string;
  kind: PasskeyCeremony;
  sub: number;
  /** base64url WebAuthn challenge (32 random bytes). */
  challenge: string;
  iat: number;
  /** Issue time in milliseconds — the replay guard's ordering key. */
  iatMs: number;
  exp: number;
};

export type ChallengeVerifyResult =
  | { ok: true; challenge: string; issuedAt: Date }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "bad_signature"
        | "wrong_purpose"
        | "wrong_kind"
        | "expired"
        | "user_mismatch";
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

/** A fresh 32-byte WebAuthn challenge and the envelope that vouches for it. */
export function issuePasskeyChallenge(
  userId: number,
  kind: PasskeyCeremony,
  nowMs: number = Date.now()
): { challenge: string; token: string } {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("userId must be a positive integer");
  }
  const challenge = randomBytes(32).toString("base64url");
  const iat = Math.floor(nowMs / 1000);
  const payload: ChallengePayload = {
    v: VERSION,
    purpose: PURPOSE,
    kind,
    sub: userId,
    challenge,
    iat,
    iatMs: Math.floor(nowMs),
    exp: iat + PASSKEY_CHALLENGE_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { challenge, token: `${payloadB64}.${sign(payloadB64).toString("base64url")}` };
}

/** Verify an envelope for this user and ceremony. Never throws for bad input. */
export function verifyPasskeyChallenge(
  raw: unknown,
  expectedUserId: number,
  kind: PasskeyCeremony,
  nowMs: number = Date.now()
): ChallengeVerifyResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "missing" };
  if (raw.length > 1024) return { ok: false, reason: "malformed" };
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
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ChallengePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.purpose !== PURPOSE || payload.v !== VERSION) return { ok: false, reason: "wrong_purpose" };
  if (payload.kind !== kind) return { ok: false, reason: "wrong_kind" };
  if (
    typeof payload.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{32,64}$/.test(payload.challenge) ||
    !Number.isInteger(payload.exp) ||
    !Number.isInteger(payload.iatMs) ||
    payload.iatMs <= 0
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(nowMs / 1000) >= payload.exp) return { ok: false, reason: "expired" };
  if (payload.sub !== expectedUserId) return { ok: false, reason: "user_mismatch" };
  return { ok: true, challenge: payload.challenge, issuedAt: new Date(payload.iatMs) };
}
