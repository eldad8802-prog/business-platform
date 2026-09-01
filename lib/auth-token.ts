import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "v1";

/**
 * CASA 2.2.3 — "Non-revocable stateless authentication tokens shall have an
 * expiration time within 24 hours of being issued."
 *
 * This token is exactly that: a stateless HMAC envelope with no server-side
 * session store, no `jti`, and no revocation list. There is therefore no
 * lifetime above 24 hours that this token may be issued with, and
 * `MAX_TTL_SECONDS` is that ceiling — not a default, a *maximum*.
 *
 * It was 30 days before Wave A. The ceiling is enforced in code rather than
 * left to configuration, so that a compliance guarantee never depends on an
 * environment variable being present and correct in every environment.
 */
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = MAX_TTL_SECONDS;

/**
 * Resolve the token lifetime. `AUTH_TOKEN_TTL_SECONDS` may LOWER it (useful for
 * tests and for tightening an environment) but can never raise it: any value
 * above the ceiling is clamped, and anything unparseable, zero or negative
 * falls back to the compliant default. No configuration path can reintroduce a
 * session longer than 24 hours.
 */
export function resolveAuthTokenTtlSeconds(
  raw: string | undefined = process.env.AUTH_TOKEN_TTL_SECONDS
): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(Math.floor(parsed), MAX_TTL_SECONDS);
}

/** The hard ceiling, exported so tests and evidence can assert against it. */
export const AUTH_TOKEN_MAX_TTL_SECONDS = MAX_TTL_SECONDS;

export class AuthTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTokenConfigError";
  }
}

type AuthTokenPayload = {
  sub: number;
  iat: number;
  exp: number;
};

function getAuthTokenSecret(): string | null {
  const raw = process.env.AUTH_TOKEN_SECRET;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireAuthTokenSecret(): string {
  const secret = getAuthTokenSecret();
  if (!secret) {
    throw new AuthTokenConfigError(
      process.env.NODE_ENV === "production"
        ? "AUTH_TOKEN_SECRET is not configured"
        : "AUTH_TOKEN_SECRET is not configured. Set it in .env.local for local dev."
    );
  }
  return secret;
}

function signPayload(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${TOKEN_VERSION}.${payloadB64}`)
    .digest();
}

function encodePayload(payload: AuthTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(payloadB64: string): AuthTokenPayload | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as Partial<AuthTokenPayload>;
    if (
      typeof parsed.sub !== "number" ||
      !Number.isInteger(parsed.sub) ||
      parsed.sub <= 0 ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    return {
      sub: parsed.sub,
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

/** Issues an HMAC-SHA256 signed bearer token for the given user id. */
export function signAuthToken(userId: number): string {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("signAuthToken: userId must be a positive integer");
  }

  const secret = requireAuthTokenSecret();
  const now = Math.floor(Date.now() / 1000);
  // Single TTL authority: the clamp lives in resolveAuthTokenTtlSeconds, so no
  // caller — and no environment variable — can widen the lifetime past the
  // CASA 2.2.3 ceiling.
  const ttlSeconds = resolveAuthTokenTtlSeconds();

  const payloadB64 = encodePayload({
    sub: userId,
    iat: now,
    exp: now + ttlSeconds,
  });
  const signature = signPayload(payloadB64, secret).toString("base64url");

  return `${TOKEN_VERSION}.${payloadB64}.${signature}`;
}

/**
 * Verifies a signed bearer token and returns the user id, or null when invalid.
 * Legacy numeric tokens are always rejected (hard cutover).
 */
export function verifyAuthToken(rawToken: string): number | null {
  const token = rawToken.trim();
  if (!token || /^\d+$/.test(token)) {
    return null;
  }

  const secret = getAuthTokenSecret();
  if (!secret) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return null;
  }

  const payloadB64 = parts[1];
  const signatureB64 = parts[2];
  if (!payloadB64 || !signatureB64) {
    return null;
  }

  let receivedSig: Buffer;
  try {
    receivedSig = Buffer.from(signatureB64, "base64url");
  } catch {
    return null;
  }

  const expectedSig = signPayload(payloadB64, secret);
  if (
    receivedSig.length !== expectedSig.length ||
    !timingSafeEqual(receivedSig, expectedSig)
  ) {
    return null;
  }

  const payload = decodePayload(payloadB64);
  if (!payload) {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload.sub;
}
