/**
 * The extended Gmail scan's continuation cursor (2026-11-09 B3-a).
 *
 * # What it carries
 *
 * Where the next page starts (Gmail's own page token) and the facts that page
 * is only valid for: the business, the signed-in user, the Gmail connection,
 * the search window, how many messages the scan has already covered, and when
 * the cursor was issued.
 *
 * # Why it is encrypted AND signed
 *
 * The other envelopes in this codebase (signed-state.service.ts,
 * data-transfer signed-envelope.ts) are signed but readable. This one must not
 * be readable: Gmail's page token is never shown to the client. So the payload
 * is sealed with AES-256-GCM, and the sealed envelope is then signed with
 * HMAC-SHA256. The signature is checked first, in constant time, before
 * anything is decrypted or parsed — a forged or edited cursor never reaches a
 * business check, let alone Gmail.
 *
 * # Keys and separation
 *
 * Both keys come from the canonical server secret `AUTH_TOKEN_SECRET` (no new
 * secret) through HKDF-SHA256 (RFC 5869) with this cursor's own salt and a
 * distinct `info` per key. The other uses of that secret take it as an HMAC
 * KEY over their own messages; HKDF takes it as the HMAC MESSAGE under this
 * salt, and expands per label — so neither derived key equals, or can be
 * computed from, any value another use of the secret produces, and the
 * encryption key is independent of the signing key. Rotating the secret
 * invalidates every cursor in flight: the scan simply starts again.
 *
 * # What a cursor cannot do
 *
 * It selects nothing by itself: the request's own session decides the
 * business and user, and the request's own Gmail connection decides the
 * mailbox; a cursor is refused unless all of them match the ones it was issued
 * for, and unless the window matches and it is under 30 minutes old.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isGmailScanWindow, type GmailScanWindow } from "@/lib/services/email-import/scan-window";

const PREFIX = "gsc1";
const HKDF_SALT = "dubiz-gmail-scan-cursor";
const ENC_INFO = "enc-v1";
const MAC_INFO = "mac-v1";
export const GMAIL_SCAN_CURSOR_TTL_SECONDS = 30 * 60;
/** Clock skew tolerated on `iat` from another server instance. */
const MAX_FUTURE_SKEW_SECONDS = 60;
const MAX_CURSOR_LENGTH = 4096;
const MAX_PAGE_TOKEN_LENGTH = 1024;
/** Sanity bound on the attempt counter (the page service stops far earlier). */
const MAX_ATTEMPT_FIELD = 10;

export class GmailScanCursorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailScanCursorConfigError";
  }
}

export type GmailScanCursorFacts = {
  businessId: number;
  userId: number;
  connectionId: number;
  window: GmailScanWindow;
  /** Gmail's page token for the page this cursor resumes at; null = the first page. */
  pageToken: string | null;
  /** Messages the scan already covered before this page. */
  scanned: number;
  /** Earlier incomplete attempts at THIS page (0 for a page not tried yet). */
  attempt: number;
};

type Payload = {
  b: number;
  u: number;
  c: number;
  w: number;
  t: string | null;
  n: number;
  a: number;
  iat: number;
};

export type GmailScanCursorFailure =
  | "malformed"
  | "bad_signature"
  | "invalid_payload"
  | "expired"
  | "wrong_business"
  | "wrong_user"
  | "wrong_connection"
  | "wrong_window";

export type GmailScanCursorResult =
  | { ok: true; facts: GmailScanCursorFacts }
  | { ok: false; reason: GmailScanCursorFailure };

function deriveKey(info: string): Buffer {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) {
    // Fail closed — never issue or accept an unprotected cursor.
    throw new GmailScanCursorConfigError("AUTH_TOKEN_SECRET is not configured");
  }
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, info, 32));
}

function mac(signed: string): Buffer {
  return createHmac("sha256", deriveKey(MAC_INFO)).update(signed).digest();
}

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** Seal a cursor for the next (or the same) page. */
export function issueGmailScanCursor(facts: GmailScanCursorFacts, nowMs: number = Date.now()): string {
  if (!isPositiveInt(facts.businessId) || !isPositiveInt(facts.userId) || !isPositiveInt(facts.connectionId)) {
    throw new GmailScanCursorConfigError("cursor ids must be positive integers");
  }
  if (!isGmailScanWindow(facts.window)) throw new GmailScanCursorConfigError("unknown scan window");
  if (!Number.isInteger(facts.scanned) || facts.scanned < 0) {
    throw new GmailScanCursorConfigError("scanned must be a whole non-negative number");
  }
  if (!Number.isInteger(facts.attempt) || facts.attempt < 0 || facts.attempt > MAX_ATTEMPT_FIELD) {
    throw new GmailScanCursorConfigError("attempt out of range");
  }
  if (facts.pageToken !== null && (facts.pageToken.length === 0 || facts.pageToken.length > MAX_PAGE_TOKEN_LENGTH)) {
    throw new GmailScanCursorConfigError("page token out of range");
  }

  const payload: Payload = {
    b: facts.businessId,
    u: facts.userId,
    c: facts.connectionId,
    w: facts.window,
    t: facts.pageToken,
    n: facts.scanned,
    a: facts.attempt,
    iat: Math.floor(nowMs / 1000),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(ENC_INFO), iv);
  cipher.setAAD(Buffer.from(PREFIX, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const signed = [PREFIX, iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
  return `${signed}.${mac(signed).toString("base64url")}`;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Open a cursor and check it against the CURRENT request. Never throws for bad
 * input (only for missing server configuration) — returns a fixed reason.
 *
 * `expected.connectionId` is the account the request named, if it named one;
 * when it did not, the caller must still hold the resolved account to the
 * cursor's (loadGmailAccess `expectConnectionId`).
 */
export function verifyGmailScanCursor(
  raw: unknown,
  expected: { businessId: number; userId: number; window: GmailScanWindow; connectionId?: number },
  nowMs: number = Date.now()
): GmailScanCursorResult {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = raw.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX || !parts.slice(1).every((p) => p.length > 0 && B64URL.test(p))) {
    return { ok: false, reason: "malformed" };
  }

  // 1. Signature, constant time, before anything is decrypted or parsed.
  const signed = parts.slice(0, 4).join(".");
  const provided = Buffer.from(parts[4], "base64url");
  const expectedMac = mac(signed);
  if (provided.length !== expectedMac.length || !timingSafeEqual(provided, expectedMac)) {
    return { ok: false, reason: "bad_signature" };
  }

  // 2. Decrypt (GCM authenticates again).
  let payload: Payload;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const ct = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) return { ok: false, reason: "malformed" };
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(ENC_INFO), iv);
    decipher.setAAD(Buffer.from(PREFIX, "utf8"));
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    payload = JSON.parse(json) as Payload;
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }

  // 3. Shape.
  if (
    !payload ||
    typeof payload !== "object" ||
    !isPositiveInt(payload.b) ||
    !isPositiveInt(payload.u) ||
    !isPositiveInt(payload.c) ||
    !isGmailScanWindow(payload.w) ||
    !(payload.t === null || (typeof payload.t === "string" && payload.t.length > 0 && payload.t.length <= MAX_PAGE_TOKEN_LENGTH)) ||
    !Number.isInteger(payload.n) ||
    payload.n < 0 ||
    !Number.isInteger(payload.a) ||
    payload.a < 0 ||
    payload.a > MAX_ATTEMPT_FIELD ||
    !Number.isInteger(payload.iat)
  ) {
    return { ok: false, reason: "invalid_payload" };
  }

  // 4. Age.
  const now = Math.floor(nowMs / 1000);
  if (payload.iat > now + MAX_FUTURE_SKEW_SECONDS) return { ok: false, reason: "invalid_payload" };
  if (now - payload.iat >= GMAIL_SCAN_CURSOR_TTL_SECONDS) return { ok: false, reason: "expired" };

  // 5. Binding to THIS request.
  if (payload.b !== expected.businessId) return { ok: false, reason: "wrong_business" };
  if (payload.u !== expected.userId) return { ok: false, reason: "wrong_user" };
  if (expected.connectionId !== undefined && payload.c !== expected.connectionId) {
    return { ok: false, reason: "wrong_connection" };
  }
  if (payload.w !== expected.window) return { ok: false, reason: "wrong_window" };

  return {
    ok: true,
    facts: {
      businessId: payload.b,
      userId: payload.u,
      connectionId: payload.c,
      window: payload.w,
      pageToken: payload.t,
      scanned: payload.n,
      attempt: payload.a,
    },
  };
}
