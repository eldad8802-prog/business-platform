/**
 * Phone verification on the public booking link (G2 — appointments completion program, workstream G) — the pure rules.
 * No Prisma, no clock of its own. SERVER-ONLY (node:crypto).
 *
 * Owner requirement 3 (schema package): a one-time code lives 5 MINUTES, is used ONCE, a new code invalidates the
 * previous ones, wrong attempts are limited, a resend waits for a cooldown, and sends are capped per phone, per IP and
 * per business so WhatsApp sends cannot be abused (each one costs). Owner requirement 8: verification is mandatory for
 * EVERY business before its link can be used — whatever BookingSettings.requireVerification holds (it is never read).
 *
 * Secrets: the keyed hashes use the server's existing request-HMAC key (TASK_REQUEST_HMAC_KEY — the same key the public
 * submit already requires for its request digest), under a domain separator, so nothing new has to be provisioned.
 * Only these hashes are stored (BookingPhoneChallenge): never the phone, the code or the IP address.
 *   phoneHash = HMAC(key, "booking-otp:v1:phone:" + E.164)        — stable per phone across businesses (the caps)
 *   ipHash    = HMAC(key, "booking-otp:v1:ip:" + client IP)
 *   codeHash  = HMAC(key, "booking-otp:v1:code:" + businessId + ":" + phoneHash + ":" + code)
 * After a successful check the browser gets a VERIFICATION TOKEN — HMAC(key, "booking-otp:v1:verified:" + businessId +
 * ":" + challengeId + ":" + verifiedAt) — that only the browser which typed the code holds; the submit must present
 * it, so a verified phone cannot be "borrowed" by someone else who merely knows the number. Nothing extra is stored.
 * Key rotation (TASK_REQUEST_HMAC_KEY_PREVIOUS) is honoured on every check; caps restart with a new key (documented).
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { platformConfig } from "@/lib/notifications/customer/platform-transport";

/** The verification policy. Lifetime / attempts / single use are also enforced by the database (CHECK + trigger). */
export const OTP_POLICY = {
  codeDigits: 6,
  /** Owner requirement 3: 5 minutes (the table allows at most 10). */
  lifetimeMinutes: 5,
  /** Wrong codes before the code is dead (the table's CHECK: attempts 0..5). */
  maxAttempts: 5,
  /** A new code for the same phone at the same business no sooner than this after the previous one. */
  resendCooldownSeconds: 60,
  /** A verified code must be used by a submit within this time, else the customer verifies again. */
  verifiedUseMinutes: 30,
} as const;

/**
 * Send caps — PILOT values. Owner decision D7 (2026-11-26): approved for the business 9 PILOT ONLY; they are NOT the
 * final commercial quotas (those are a later owner decision, per plan — do not reuse these numbers as product limits).
 * Counted from the
 * BookingPhoneChallenge rows themselves (one row = one code sent): per phone and per IP across ALL businesses through
 * booking_otp_send_counts() (counts only), per business and per (business, phone) inside the tenant's own rows. The
 * IP rate-limiter buckets PUBLIC_BOOKING_OTP_SEND / _VERIFY sit in front of them (lib/security/rate-limiter/buckets.ts).
 */
export const PILOT_OTP_SEND_CAPS = {
  /** The design's "up to 3 sends": codes to one phone for one business in an hour. */
  perPhonePerBusinessPerHour: 3,
  /** One phone, all businesses. */
  perPhonePerHour: 5,
  perPhonePerDay: 10,
  /** One network address, all businesses (shared NATs / carrier IPs: kept above a household's need). */
  perIpPerHour: 10,
  perIpPerDay: 30,
  /** One business, all phones: a ceiling on what a single link can cost. */
  perBusinessPerHour: 30,
  perBusinessPerDay: 200,
} as const;

export type OtpCounts = {
  phoneHour: number;
  phoneDay: number;
  ipHour: number;
  ipDay: number;
  businessHour: number;
  businessDay: number;
  phoneBusinessHour: number;
};

/** Which cap a new send would break, or null. The answer names no phone and no business. */
export function capExceeded(c: OtpCounts, caps: typeof PILOT_OTP_SEND_CAPS = PILOT_OTP_SEND_CAPS): "phone" | "ip" | "business" | null {
  if (c.phoneBusinessHour >= caps.perPhonePerBusinessPerHour || c.phoneHour >= caps.perPhonePerHour || c.phoneDay >= caps.perPhonePerDay) return "phone";
  if (c.ipHour >= caps.perIpPerHour || c.ipDay >= caps.perIpPerDay) return "ip";
  if (c.businessHour >= caps.perBusinessPerHour || c.businessDay >= caps.perBusinessPerDay) return "business";
  return null;
}

/** Seconds until a new code may be sent after the latest one (0 = now). */
export function cooldownLeftSeconds(latestCreatedAt: Date | null, now: Date, cooldownSeconds: number = OTP_POLICY.resendCooldownSeconds): number {
  if (!latestCreatedAt) return 0;
  const left = latestCreatedAt.getTime() + cooldownSeconds * 1000 - now.getTime();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** A fresh code: 6 uniformly random digits (CSPRNG). */
export function newOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_POLICY.codeDigits)).padStart(OTP_POLICY.codeDigits, "0");
}

export const OTP_CODE = /^[0-9]{6}$/;

export type OtpKey = { id: string; secret: string };
export type OtpKeys = { current: OtpKey; previous: OtpKey | null };

/** The keys, from the environment the public submit already needs. Throws when missing (fail closed). */
export function otpKeysFromEnv(env: Record<string, string | undefined> = process.env): OtpKeys {
  const secret = env.TASK_REQUEST_HMAC_KEY;
  if (!secret || secret.length < 32) throw new Error("TASK_REQUEST_HMAC_KEY is missing or shorter than 32 characters");
  const prev = env.TASK_REQUEST_HMAC_KEY_PREVIOUS;
  return {
    current: { id: env.TASK_REQUEST_HMAC_KEY_ID ?? "k1", secret },
    previous: prev && prev.length >= 32 && prev !== secret ? { id: env.TASK_REQUEST_HMAC_KEY_PREVIOUS_ID ?? "k0", secret: prev } : null,
  };
}

const mac = (key: OtpKey, label: string, value: string) =>
  createHmac("sha256", key.secret).update(`booking-otp:v1:${label}:${value}`, "utf8").digest("hex");

export const phoneHashOf = (key: OtpKey, e164: string) => mac(key, "phone", e164);
export const ipHashOf = (key: OtpKey, ip: string) => mac(key, "ip", ip);
export const codeHashOf = (key: OtpKey, businessId: number, phoneHash: string, code: string) => mac(key, "code", `${businessId}:${phoneHash}:${code}`);

/** The browser's proof that it typed the right code for this challenge (stateless; base64url, 43 characters). */
export function verificationTokenOf(key: OtpKey, businessId: number, challengeId: number, verifiedAt: Date): string {
  return createHmac("sha256", key.secret).update(`booking-otp:v1:verified:${businessId}:${challengeId}:${verifiedAt.toISOString()}`, "utf8").digest("base64url");
}

export const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Constant-time equality of two strings of the same alphabet (hex hashes, base64url tokens). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) {
    // Still spend the comparison, so a length mismatch is not faster than a content mismatch.
    timingSafeEqual(x, Buffer.alloc(x.length));
    return false;
  }
  return timingSafeEqual(x, y);
}

/** Does `code` match the stored hash under the current key or the previous one (a rotation within a code's 5 minutes)? */
export function codeMatches(keys: OtpKeys, stored: string, businessId: number, phoneHashes: string[], code: string): boolean {
  let hit = false;
  for (const key of [keys.current, keys.previous]) {
    if (!key) continue;
    for (const ph of phoneHashes) hit = sameSecret(codeHashOf(key, businessId, ph, code), stored) || hit;
  }
  return hit;
}

/** The phone hashes of one number under every live key (the challenge was written under one of them). */
export function phoneHashesOf(keys: OtpKeys, e164: string): string[] {
  return [keys.current, keys.previous].filter((k): k is OtpKey => k !== null).map((k) => phoneHashOf(k, e164));
}

export function tokenMatches(keys: OtpKeys, token: string, businessId: number, challengeId: number, verifiedAt: Date): boolean {
  let hit = false;
  for (const key of [keys.current, keys.previous]) {
    if (!key) continue;
    hit = sameSecret(verificationTokenOf(key, businessId, challengeId, verifiedAt), token) || hit;
  }
  return hit;
}

/**
 * Is a platform WhatsApp path that can actually DELIVER a code available? (G3: the link cannot be enabled — and, while
 * Meta has not approved, stays effectively unavailable — without it.)
 *   live      WHATSAPP_PLATFORM_SEND_MODE=live with the platform's phone_number_id and token → available;
 *   simulate  (the default, and "live" with a credential missing) → NOT available: a simulated send reaches no one, so
 *             a customer could never verify. The one exception is an explicit lab switch, BOOKING_OTP_ALLOW_SIMULATED=1,
 *             which is refused outright on Vercel production (VERCEL_ENV=production) whatever its value.
 */
export function verificationDeliveryAvailable(env: Record<string, string | undefined> = process.env): boolean {
  // The SAME decision the transport makes (workstream F's platform-transport.ts): live only with every credential.
  if (platformConfig(env).mode === "live") return true;
  if (env.VERCEL_ENV === "production") return false;
  return env.BOOKING_OTP_ALLOW_SIMULATED === "1";
}
