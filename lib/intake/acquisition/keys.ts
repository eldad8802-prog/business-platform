/**
 * M6 — endpoint ids and shared keys for acquisition connections.
 *
 *   publicId  opaque, random, URL-safe; names an endpoint, carries no tenant information.
 *   key       a shared secret shown to the owner ONCE (to paste into Google Ads / their website's
 *             server). Only its sha256 is stored; verification hashes what arrives and asks the
 *             database for an exact match (m6_acquisition_resolve_keyed).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PUBLIC_ID_BYTES = 24; // 32 base64url chars
const KEY_BYTES = 32;

export const KEY_PREFIX = { "google.lead_form": "dgk_", "web.form": "dwk_" } as const;

export function newPublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString("base64url");
}

export function newSharedKey(sourceKey: keyof typeof KEY_PREFIX): { key: string; hash: string; hint: string } {
  const key = KEY_PREFIX[sourceKey] + randomBytes(KEY_BYTES).toString("base64url");
  return { key, hash: hashKey(key), hint: key.slice(-4) };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Constant-time string equality (for tokens compared in the application, e.g. a verify token). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
