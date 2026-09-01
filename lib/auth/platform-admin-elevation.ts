/**
 * Platform-admin MFA elevation envelope.
 *
 * CASA 3.3.1 requires MFA on administrative interfaces. Demanding a fresh TOTP
 * code on every privileged API call would be unusable, so a successful
 * verification mints a SHORT-LIVED, tamper-evident elevation that privileged
 * routes require alongside the ordinary session.
 *
 * Shape and construction deliberately mirror the ratified signed-state pattern
 * already used for the Gmail and ITA OAuth round-trips
 * (`lib/services/integrations/gmail/signed-state.service.ts`): an HMAC-SHA256
 * envelope keyed by a purpose-derived subkey of the canonical server secret, so
 * an elevation can never validate as a session token — or as any other envelope
 * — and vice versa.
 *
 * Deliberate properties:
 *   - lifetime 15 minutes. It is a step-up, not a second session; it is an order
 *     of magnitude shorter than the 24h session ceiling set in Wave A.
 *   - bound to `sub` — the authenticated user id. An elevation minted for one
 *     admin cannot elevate another, and it is useless without a valid session.
 *   - stateless and per-client. A different browser or device holds no
 *     elevation, so it must complete TOTP independently.
 *   - invalidated by `AUTH_TOKEN_SECRET` rotation, exactly like sessions.
 *   - cleared by logout, because the client discards it with the session.
 *
 * NOTE ON KEY CHOICE: this signs a transient envelope; it does not encrypt
 * stored material. The TOTP seed itself is encrypted under a dedicated
 * `ADMIN_MFA_ENCRYPTION_KEY` (see admin-mfa-crypto.ts), so rotating
 * `AUTH_TOKEN_SECRET` can never render an enrolled authenticator unreadable.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const PURPOSE = "platform-admin-elevation";
const KEY_DERIVATION_LABEL = "dubiz-platform-admin-elevation-v1";

/** Step-up lifetime. Short by design — see the header note. */
export const ADMIN_ELEVATION_TTL_SECONDS = 15 * 60;

/** Header the client presents alongside the ordinary Bearer session. */
export const ADMIN_ELEVATION_HEADER = "x-admin-elevation";

export class AdminElevationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminElevationConfigError";
  }
}

type ElevationPayload = {
  v: number;
  purpose: string;
  sub: number;
  nonce: string;
  iat: number;
  exp: number;
};

export type ElevationVerifyResult =
  | { ok: true; userId: number; expiresAt: number }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "bad_signature"
        | "wrong_purpose"
        | "wrong_version"
        | "expired"
        | "invalid_payload"
        | "user_mismatch";
    };

function deriveKey(): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) {
    // Fail closed — never fall back to an unsigned elevation.
    throw new AdminElevationConfigError("AUTH_TOKEN_SECRET is not configured");
  }
  return createHmac("sha256", secret).update(KEY_DERIVATION_LABEL).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string): Buffer {
  return createHmac("sha256", deriveKey()).update(payloadB64).digest();
}

/** Mint an elevation for an admin who has just proven possession of a factor. */
export function issueAdminElevation(userId: number, nowMs?: number): string {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AdminElevationConfigError("userId must be a positive integer");
  }
  const iat = Math.floor((nowMs ?? Date.now()) / 1000);
  const payload: ElevationPayload = {
    v: VERSION,
    purpose: PURPOSE,
    sub: userId,
    nonce: b64url(randomBytes(16)),
    iat,
    exp: iat + ADMIN_ELEVATION_TTL_SECONDS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${b64url(sign(payloadB64))}`;
}

/**
 * Verify an elevation and bind it to the session user. Never throws for bad
 * input — returns a typed reason so the caller decides the response.
 */
export function verifyAdminElevation(
  raw: string | null | undefined,
  expectedUserId: number,
  nowMs?: number
): ElevationVerifyResult {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (raw.length > 2048) return { ok: false, reason: "malformed" };

  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1 || raw.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64 = raw.slice(0, dot);
  const sigB64 = raw.slice(dot + 1);

  let provided: Buffer;
  try {
    provided = Buffer.from(sigB64, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = sign(payloadB64);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: ElevationPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as ElevationPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload?.purpose !== PURPOSE) return { ok: false, reason: "wrong_purpose" };
  if (payload?.v !== VERSION) return { ok: false, reason: "wrong_version" };
  if (
    !Number.isInteger(payload.sub) ||
    payload.sub <= 0 ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length === 0 ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp)
  ) {
    return { ok: false, reason: "invalid_payload" };
  }

  const now = Math.floor((nowMs ?? Date.now()) / 1000);
  if (now >= payload.exp) return { ok: false, reason: "expired" };

  // Binding: an elevation is worthless without the matching session identity.
  if (payload.sub !== expectedUserId) {
    return { ok: false, reason: "user_mismatch" };
  }

  return { ok: true, userId: payload.sub, expiresAt: payload.exp };
}

/** Read the elevation from a request without assuming a framework type. */
export function readAdminElevationHeader(req: Request): string | null {
  return req.headers.get(ADMIN_ELEVATION_HEADER);
}
