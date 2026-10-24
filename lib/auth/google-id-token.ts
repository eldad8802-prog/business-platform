/**
 * Google ID token verification — the one place a Google sign-in becomes an identity.
 *
 * WHY A LIBRARY AND THE SIGNATURE, EVEN FROM THE TOKEN ENDPOINT: the callback receives the ID token
 * directly from Google's token endpoint over TLS, which OIDC allows to stand in for the signature. We do
 * not lean on that. Every token is verified in full with `jose` against Google's published keys (RS256
 * only), and then held to every claim below — so a token that is forged, altered, expired, minted for
 * another client (our own Gmail client included) or replayed into another browser's sign-in never yields
 * an identity, whatever path it arrived by.
 *
 * WHAT IS CHECKED
 *   signature   RS256 against Google's JWKS (the key chosen by `kid`); `alg: none`, HS256 and every other
 *               algorithm are refused before any key is consulted;
 *   iss         https://accounts.google.com or accounts.google.com;
 *   aud         exactly our sign-in client; `azp`, when present, the same client;
 *   time        exp / nbf / iat with at most 60 seconds of clock tolerance; issued no more than an hour ago;
 *   nonce       equal (constant time) to the nonce this browser's sign-in started with;
 *   email       `email_verified` is the boolean true — a string "true" or a missing claim is not;
 *   shape       a subject of 1–255 characters and an address of the shape signup accepts.
 * The answer is an identity or a reason code. Nothing here logs the token, a claim or an address, and
 * nothing here touches the database: what a verified identity may do is decided by its caller.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

import { EMAIL_SHAPE, normalizeEmail } from "@/lib/auth/signup-identity";

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ID_TOKEN_ALGORITHMS = ["RS256"];
export const CLOCK_TOLERANCE_SECONDS = 60;
/** Google signs ID tokens for one hour; an older `iat` is not a fresh sign-in. */
export const MAX_TOKEN_AGE_SECONDS = 3600;
/** Far above any real ID token; a bound before any parsing. */
export const MAX_ID_TOKEN_LENGTH = 8192;
/** The signup ticket's own bound (OAuthSignupTicket_name). */
export const MAX_GOOGLE_NAME_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;

export type GoogleIdentity = {
  /** Google's stable account id (`sub`) — the only key an identity is ever matched on. */
  subject: string;
  /** Folded exactly as signup folds it. Verified by Google (email_verified === true). */
  email: string;
  /** For prefilling the signup form only; may be null. */
  name: string | null;
};

export type GoogleIdTokenFailure =
  | "MALFORMED"
  | "SIGNATURE"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "ISSUER"
  | "AUDIENCE"
  | "AUTHORIZED_PARTY"
  | "NONCE"
  | "EMAIL_UNVERIFIED"
  | "CLAIMS"
  | "KEYS_UNAVAILABLE";

export type GoogleIdTokenResult = { ok: true; identity: GoogleIdentity } | { ok: false; reason: GoogleIdTokenFailure };

let googleKeys: JWTVerifyGetKey | null = null;
/** Google's published signing keys, fetched and cached by `jose` (refetched when an unknown `kid` arrives). */
function defaultKeys(): JWTVerifyGetKey {
  googleKeys ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  return googleKeys;
}

function sameNonce(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || actual.length === 0) return false;
  // Digests first, so the comparison is constant-time whatever the lengths.
  const a = createHash("sha256").update(actual, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function failureOf(error: unknown): GoogleIdTokenFailure {
  if (error instanceof errors.JWTExpired) return "EXPIRED";
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "iss":
        return "ISSUER";
      case "aud":
        return "AUDIENCE";
      case "nbf":
      case "iat":
        return "NOT_YET_VALID";
      case "nonce":
        return "NONCE";
      default:
        return "CLAIMS";
    }
  }
  if (error instanceof errors.JWKSTimeout) return "KEYS_UNAVAILABLE";
  if (
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof errors.JOSEAlgNotAllowed
  ) {
    return "SIGNATURE";
  }
  return "MALFORMED";
}

function nameOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, MAX_GOOGLE_NAME_LENGTH).join("");
}

/**
 * Verify a Google ID token for this sign-in. `keys` is injectable so tests can sign with their own keys;
 * production always passes nothing and gets Google's JWKS.
 */
export async function verifyGoogleIdToken(
  idToken: unknown,
  expected: { clientId: string; nonce: string; now?: Date },
  keys: JWTVerifyGetKey = defaultKeys()
): Promise<GoogleIdTokenResult> {
  if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
    return { ok: false, reason: "MALFORMED" };
  }
  // A misconfigured caller must never turn into "any audience" or "any nonce".
  if (!expected.clientId || !expected.nonce) return { ok: false, reason: "MALFORMED" };

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      algorithms: GOOGLE_ID_TOKEN_ALGORITHMS,
      issuer: GOOGLE_ISSUERS,
      audience: expected.clientId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      requiredClaims: ["sub", "email", "iat", "exp", "nonce"],
      currentDate: expected.now,
    }));
  } catch (error) {
    return { ok: false, reason: failureOf(error) };
  }

  // A token for several audiences must name us as the party it was issued to.
  if (payload.azp !== undefined && payload.azp !== expected.clientId) return { ok: false, reason: "AUTHORIZED_PARTY" };
  if (!sameNonce(payload.nonce, expected.nonce)) return { ok: false, reason: "NONCE" };
  if (payload.email_verified !== true) return { ok: false, reason: "EMAIL_UNVERIFIED" };

  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
    return { ok: false, reason: "CLAIMS" };
  }
  const rawEmail = payload.email;
  if (typeof rawEmail !== "string" || rawEmail.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(rawEmail.trim())) {
    return { ok: false, reason: "CLAIMS" };
  }

  return { ok: true, identity: { subject, email: normalizeEmail(rawEmail), name: nameOf(payload.name) } };
}
