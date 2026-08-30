/**
 * D2 / P7-W4E-B — Tamper-evident Tax Authority (ITA) OAuth state envelope.
 *
 * Replaces the previous tenant source, which was a plain `authority_oauth_business_id`
 * cookie: the callback trusted whatever business that cookie named, while the
 * separate `state` cookie was compared with `timingSafeEqual` and therefore
 * provided CSRF protection only — it bound no identity. A caller who controls
 * their own cookies could name another tenant, and the callback would then
 * faithfully persist ITA token material onto that tenant's connection. Adding
 * FORCE RLS on top of that would have enforced the *wrong* tenant precisely.
 *
 * The tenant identity is now cryptographically BOUND to the state itself.
 *
 * Envelope: `base64url(json payload) + "." + base64url(hmac)`
 *   payload = { v, purpose, businessId, userId, environment, nonce, iat, exp }
 *
 * Key: HMAC-SHA256 derived from the canonical server secret `AUTH_TOKEN_SECRET`
 * with a purpose-separated derivation label — no new secret sprawl, and no
 * envelope from another purpose (Bearer auth tokens, the Gmail OAuth state)
 * can ever validate here, or this one there. That separation is proven in both
 * directions by the W4E-B battery.
 *
 * `environment` is bound because ITA connections are unique per
 * (businessId, environment): a SANDBOX authorization must never be able to
 * install itself as the PRODUCTION connection, so the environment the flow
 * started in is part of what the signature covers.
 *
 * Replay: the callback additionally requires the matching httpOnly state
 * cookie (double-submit, cleared on every callback outcome), so a captured
 * state URL cannot be replayed from another browser session. `exp` bounds the
 * window regardless.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const PURPOSE = "authority-oauth-state";
const KEY_DERIVATION_LABEL = "dubiz-authority-oauth-state-v1";
export const AUTHORITY_STATE_TTL_SECONDS = 10 * 60;

/** Environments an ITA connection can belong to (mirrors the stored column). */
export const AUTHORITY_ENVIRONMENTS = ["SANDBOX", "PRODUCTION"] as const;
export type AuthorityEnvironment = (typeof AUTHORITY_ENVIRONMENTS)[number];

export class AuthorityStateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityStateConfigError";
  }
}

type SignedStatePayload = {
  v: number;
  purpose: string;
  businessId: number;
  userId: number;
  environment: string;
  nonce: string;
  iat: number;
  exp: number;
};

export type VerifiedAuthorityState = {
  businessId: number;
  userId: number;
  environment: AuthorityEnvironment;
  nonce: string;
};

export type AuthorityStateVerifyResult =
  | { ok: true; state: VerifiedAuthorityState }
  | {
      ok: false;
      reason:
        | "malformed"
        | "bad_signature"
        | "wrong_purpose"
        | "wrong_version"
        | "wrong_environment"
        | "expired"
        | "invalid_payload";
    };

function deriveKey(): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) {
    // Fail closed — never fall back to an unsigned state.
    throw new AuthorityStateConfigError("AUTH_TOKEN_SECRET is not configured");
  }
  return createHmac("sha256", secret).update(KEY_DERIVATION_LABEL).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string): Buffer {
  return createHmac("sha256", deriveKey()).update(payloadB64).digest();
}

function isEnvironment(value: unknown): value is AuthorityEnvironment {
  return (
    typeof value === "string" &&
    (AUTHORITY_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

/**
 * Create a signed OAuth state binding the server-derived tenant identity.
 * All three identity inputs must come from the authenticated session and the
 * server's own environment resolution — never from the request body/query.
 */
export function createSignedAuthorityState(input: {
  businessId: number;
  userId: number;
  environment: AuthorityEnvironment;
  nowMs?: number;
}): string {
  const { businessId, userId, environment } = input;
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new AuthorityStateConfigError("businessId must be a positive integer");
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AuthorityStateConfigError("userId must be a positive integer");
  }
  if (!isEnvironment(environment)) {
    throw new AuthorityStateConfigError("environment must be SANDBOX or PRODUCTION");
  }
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const payload: SignedStatePayload = {
    v: VERSION,
    purpose: PURPOSE,
    businessId,
    userId,
    environment,
    nonce: b64url(randomBytes(16)),
    iat,
    exp: iat + AUTHORITY_STATE_TTL_SECONDS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${b64url(sign(payloadB64))}`;
}

/** Verify a signed state. Never throws for bad input — returns a typed reason. */
export function verifySignedAuthorityState(
  raw: string | null | undefined,
  nowMs?: number
): AuthorityStateVerifyResult {
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
  if (!isEnvironment(payload.environment)) {
    return { ok: false, reason: "wrong_environment" };
  }
  const now = Math.floor((nowMs ?? Date.now()) / 1000);
  if (now >= payload.exp) return { ok: false, reason: "expired" };

  return {
    ok: true,
    state: {
      businessId: payload.businessId,
      userId: payload.userId,
      environment: payload.environment,
      nonce: payload.nonce,
    },
  };
}
