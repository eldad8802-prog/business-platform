/**
 * Daily Tasks — repeated requests (Daily Tasks spec 12.9, 12.11). SERVER-ONLY (node:crypto).
 *
 * Three lines of defence, so the same Idempotency-Key with a different request is ALWAYS refused and the expiry
 * of a fingerprint can never allow a second write:
 *
 *   1. Key age. Every key is a UUIDv7, which carries its creation time. A key may cause a write only within
 *      24 hours of its creation (or 5 minutes in the future): IDEMPOTENCY_KEY_STALE otherwise. Fingerprints
 *      are kept 7 days, so the whole window in which a key can write is covered.
 *   2. The fingerprint ledger (TaskRequestLedger): same key + same request → the stored result; same key +
 *      different request → IDEMPOTENCY_KEY_REUSED. A row older than 7 days counts as absent even before the
 *      retention path removes it.
 *   3. The journal: every request's first event carries the key and the same digest. If the ledger row is gone
 *      while the key is still young, the comparison is made against the event; a digest that was cleared
 *      (erasure) refuses every reuse of its key.
 *
 * The digest is HMAC-SHA256 over a canonical form of the request (route, business, user, body) with a server key
 * (TASK_REQUEST_HMAC_KEY, id TASK_REQUEST_HMAC_KEY_ID). The previous key (…_PREVIOUS, …_PREVIOUS_ID) is kept
 * through a rotation so a retry is checked against the key it was first signed with (T-D5). It is not
 * reversible, but whoever holds the key could confirm a guess, so it is treated as identifying and is short-lived.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const KEY_MAX_FUTURE_MS = 5 * 60 * 1000;
export const FINGERPRINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type KeyVerdict =
  | { ok: true; createdAt: Date }
  | { ok: false; code: "IDEMPOTENCY_KEY_INVALID" | "IDEMPOTENCY_KEY_STALE" };

/** The creation time a UUIDv7 carries (its first 48 bits, Unix milliseconds). */
export function uuidV7Time(key: string): Date | null {
  if (!UUID_V7.test(key)) return null;
  const ms = parseInt(key.replace(/-/g, "").slice(0, 12), 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** May this key cause a write at `now`? */
export function checkIdempotencyKey(key: unknown, now: Date): KeyVerdict {
  if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  const createdAt = uuidV7Time(key);
  if (!createdAt) return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  const age = now.getTime() - createdAt.getTime();
  if (age > KEY_MAX_AGE_MS || age < -KEY_MAX_FUTURE_MS) return { ok: false, code: "IDEMPOTENCY_KEY_STALE" };
  return { ok: true, createdAt };
}

/** A UUIDv7 for `at` (tests and server-originated requests). */
export function uuidV7(at: Date, random: () => number = Math.random): string {
  const ms = at.getTime().toString(16).padStart(12, "0").slice(-12);
  const r = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join("");
  const variant = (8 + Math.floor(random() * 4)).toString(16);
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r(3)}-${variant}${r(3)}-${r(12)}`;
}

// ── The digest ────────────────────────────────────────────────────────────────────────────────

export type DigestKey = { id: string; secret: string };
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** The current key and, during a rotation, the previous one. Throws when the current key is missing. */
export function digestKeysFromEnv(env: Record<string, string | undefined> = process.env): { current: DigestKey; previous: DigestKey | null } {
  const secret = env.TASK_REQUEST_HMAC_KEY;
  const id = env.TASK_REQUEST_HMAC_KEY_ID ?? "k1";
  if (!secret || secret.length < 32) throw new Error("TASK_REQUEST_HMAC_KEY is missing or shorter than 32 characters");
  if (!KEY_ID.test(id)) throw new Error("TASK_REQUEST_HMAC_KEY_ID is malformed");
  const prevSecret = env.TASK_REQUEST_HMAC_KEY_PREVIOUS;
  const prevId = env.TASK_REQUEST_HMAC_KEY_PREVIOUS_ID;
  const previous = prevSecret && prevId && KEY_ID.test(prevId) && prevId !== id ? { id: prevId, secret: prevSecret } : null;
  return { current: { id, secret }, previous };
}

/** Deterministic JSON: object keys sorted at every level, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export type RequestIdentity = { route: string; businessId: number; userId: number; body: unknown };

const DIGEST_VERSION = 1;

export function requestDigest(key: DigestKey, req: RequestIdentity): string {
  return createHmac("sha256", key.secret)
    .update(canonicalJson([DIGEST_VERSION, req.route, req.businessId, req.userId, req.body]))
    .digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Recompute the digest with the key a stored fingerprint names; null when that key is no longer held. */
export function digestWithKeyId(keys: { current: DigestKey; previous: DigestKey | null }, keyId: string, req: RequestIdentity): string | null {
  if (keyId === keys.current.id) return requestDigest(keys.current, req);
  if (keys.previous && keyId === keys.previous.id) return requestDigest(keys.previous, req);
  return null;
}
