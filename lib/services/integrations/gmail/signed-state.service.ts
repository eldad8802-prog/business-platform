/**
 * D2 / P7-W4A — Tamper-evident Gmail OAuth state envelope.
 *
 * Replaces the opaque random nonce + independent `gmail_oauth_business_id`
 * cookie pair. The tenant identity is now cryptographically BOUND to the
 * OAuth state itself, so the callback derives `businessId` from the verified
 * state — never from a standalone client-held cookie.
 *
 * Envelope: `base64url(json payload) + "." + base64url(hmac)`
 *   payload = { v, purpose, businessId, userId, nonce, iat, exp }
 *
 * Key: HMAC-SHA256 derived from the canonical server secret
 * `AUTH_TOKEN_SECRET` (same secret the Bearer auth tokens use — no new
 * secret sprawl) with a fixed purpose discriminator, so a Gmail state can
 * never validate as an auth token or any other envelope and vice versa.
 *
 * Replay semantics: the state is single-use in practice — the callback also
 * requires the matching `gmail_oauth_state` httpOnly cookie (double-submit,
 * cleared on every callback outcome), so a captured state URL cannot be
 * replayed from another browser session, and after the first callback the
 * cookie is gone. The `exp` bound (10 min, matching the cookie maxAge)
 * limits the window regardless.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const PURPOSE = "gmail-oauth-state";
const KEY_DERIVATION_LABEL = "dubiz-gmail-oauth-state-v1";
export const GMAIL_STATE_TTL_SECONDS = 10 * 60;

export class GmailStateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailStateConfigError";
  }
}

type SignedStatePayload = {
  v: number;
  purpose: string;
  businessId: number;
  userId: number;
  nonce: string;
  iat: number;
  exp: number;
};

export type VerifiedGmailState = {
  businessId: number;
  userId: number;
  nonce: string;
};

export type GmailStateVerifyResult =
  | { ok: true; state: VerifiedGmailState }
  | {
      ok: false;
      reason:
        | "malformed"
        | "bad_signature"
        | "wrong_purpose"
        | "wrong_version"
        | "expired"
        | "invalid_payload";
    };

function deriveKey(): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) {
    // Fail closed — never fall back to an unsigned state.
    throw new GmailStateConfigError("AUTH_TOKEN_SECRET is not configured");
  }
  return createHmac("sha256", secret).update(KEY_DERIVATION_LABEL).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string): Buffer {
  return createHmac("sha256", deriveKey()).update(payloadB64).digest();
}

/**
 * Create a signed OAuth state binding the server-derived tenant identity.
 * Both ids must come from the authenticated session (`getCurrentUser`).
 */
export function createSignedGmailState(input: {
  businessId: number;
  userId: number;
  nowMs?: number;
}): string {
  const { businessId, userId } = input;
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new GmailStateConfigError("businessId must be a positive integer");
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new GmailStateConfigError("userId must be a positive integer");
  }
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const payload: SignedStatePayload = {
    v: VERSION,
    purpose: PURPOSE,
    businessId,
    userId,
    nonce: b64url(randomBytes(16)),
    iat,
    exp: iat + GMAIL_STATE_TTL_SECONDS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${b64url(sign(payloadB64))}`;
}

/** Verify a signed state. Never throws for bad input — returns a typed reason. */
export function verifySignedGmailState(
  raw: string | null | undefined,
  nowMs?: number
): GmailStateVerifyResult {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return { ok: false, reason: "malformed" };
  }
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1 || raw.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64 = raw.slice(0, dot);
  const sigB64 = raw.slice(dot + 1);

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigB64, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expectedSig = sign(payloadB64);
  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: SignedStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as SignedStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload?.purpose !== PURPOSE) return { ok: false, reason: "wrong_purpose" };
  if (payload?.v !== VERSION) return { ok: false, reason: "wrong_version" };
  if (
    !Number.isInteger(payload.businessId) ||
    payload.businessId <= 0 ||
    !Number.isInteger(payload.userId) ||
    payload.userId <= 0 ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length === 0 ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp)
  ) {
    return { ok: false, reason: "invalid_payload" };
  }
  const now = Math.floor((nowMs ?? Date.now()) / 1000);
  if (now >= payload.exp) return { ok: false, reason: "expired" };

  return {
    ok: true,
    state: {
      businessId: payload.businessId,
      userId: payload.userId,
      nonce: payload.nonce,
    },
  };
}
