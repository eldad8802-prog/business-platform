import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

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
  const ttlRaw = process.env.AUTH_TOKEN_TTL_SECONDS;
  const ttl =
    typeof ttlRaw === "string" && ttlRaw.trim().length > 0
      ? Number(ttlRaw)
      : DEFAULT_TTL_SECONDS;
  const ttlSeconds =
    Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_SECONDS;

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
