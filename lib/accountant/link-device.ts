/**
 * The accountant's portal on a new device — a one-time code to the delivery's own recipient (G5 M5, option C).
 * SERVER-ONLY.
 *
 * THE MODEL
 *   The link (public id + secret in the URL fragment, 14 days, revocable) stays exactly as it is, and is checked FIRST:
 *   a revoked or expired link answers as such before anything here runs, so no code or device can bring it back.
 *   A valid link is necessary but no longer sufficient: the portal, every file and the ZIP also need a TRUSTED DEVICE —
 *   a browser that proved, once, that it reads the inbox the package was approved to.
 *
 *   1. CODE. Six digits from the CSPRNG, sent only to the delivery's recipient SNAPSHOT (the address the owner approved
 *      for this package; a visitor cannot type one, and a later recipient change does not move it). The database keeps
 *      a salted HMAC of it (never the code), valid 10 minutes, 5 wrong attempts at most, used once. Limits per delivery:
 *      one code per 60 seconds, 3 per 15 minutes, 10 per day — plus a per-address bucket at the route.
 *   2. DEVICE. The right code turns into a random 256-bit cookie value (httpOnly, Secure, SameSite=Strict, path
 *      /api/accountant/link, one cookie name per link). The database keeps its HMAC, bound to THIS delivery only, until
 *      the link expires. A device of one delivery is worth nothing for another delivery, month or business.
 *   3. REVOCATION. The owner revoking the link marks every device of it revoked (lib/accountant/delivery.service.ts),
 *      and the link check refuses first anyway.
 *
 * Every step leaves a trail event with codes only (LINK_CODE_SENT / LINK_CODE_FAILED / LINK_DEVICE_VERIFIED): never a
 * code, a cookie value, an address or an IP. Nothing here is logged with a secret.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";

import { AuthTokenConfigError } from "@/lib/auth-token";
import { readTransactionalEmailConfig } from "@/lib/email/transactional/config";
import type { EmailProvider } from "@/lib/email/transactional/provider";
import { createResendProvider } from "@/lib/email/transactional/resend";
import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";

import { renderAccountantCodeEmail } from "./email-template";
import { periodLabelHe } from "./period";
import { appendEvent } from "./store";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_AFTER_MS = 60 * 1000;
export const CODE_LIMIT_15MIN = 3;
export const CODE_LIMIT_DAY = 10;
export const DEVICE_COOKIE_PATH = "/api/accountant/link";

const CODE = /^[0-9]{6}$/;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/;

function key(label: string): Buffer {
  const raw = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!raw) throw new AuthTokenConfigError("AUTH_TOKEN_SECRET is not configured");
  return createHmac("sha256", raw).update(label).digest();
}

export function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value);
}

/** A fresh six-digit code from the CSPRNG (000000–999999, uniform). */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashCode(deliveryId: number, salt: string, code: string): string {
  return createHmac("sha256", key("dubiz:accountant-otp:v1")).update(`${deliveryId}.${salt}.${code}`).digest("hex");
}

export function hashDeviceToken(token: string): string {
  return createHmac("sha256", key("dubiz:accountant-device:v1")).update(token).digest("hex");
}

/** One cookie per link, so a browser holding two months' links keeps both. The name reveals nothing of the secret. */
export function deviceCookieName(publicId: string): string {
  return `dz_acct_${createHash("sha256").update(`cookie:${publicId}`).digest("hex").slice(0, 16)}`;
}

export function readDeviceToken(req: Request, publicId: string): string | null {
  const name = deviceCookieName(publicId);
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      const value = v.join("=");
      return COOKIE_VALUE.test(value) ? value : null;
    }
  }
  return null;
}

export function deviceCookie(publicId: string, token: string, expiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const secure = process.env.NODE_ENV === "production" || process.env.VERCEL === "1" ? "; Secure" : "";
  return `${deviceCookieName(publicId)}=${token}; Path=${DEVICE_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

/** "d•••@example.co.il" — enough for the accountant to recognise the inbox, not enough to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

/** Whether the code-issue limits allow one more now (pure). */
export function codeIssueDecision(
  issued: Date[],
  now: Date
): { ok: true } | { ok: false; reason: "cooldown" | "limit_15min" | "limit_day"; retryAfterSec: number } {
  const t = now.getTime();
  const recent = issued.filter((d) => t - d.getTime() < 24 * 60 * 60 * 1000).sort((a, b) => b.getTime() - a.getTime());
  const last = recent[0];
  if (last && t - last.getTime() < CODE_RESEND_AFTER_MS) {
    return { ok: false, reason: "cooldown", retryAfterSec: Math.ceil((CODE_RESEND_AFTER_MS - (t - last.getTime())) / 1000) };
  }
  const in15 = recent.filter((d) => t - d.getTime() < 15 * 60 * 1000);
  if (in15.length >= CODE_LIMIT_15MIN) {
    const oldest = in15[in15.length - 1];
    return { ok: false, reason: "limit_15min", retryAfterSec: Math.ceil((15 * 60 * 1000 - (t - oldest.getTime())) / 1000) };
  }
  if (recent.length >= CODE_LIMIT_DAY) {
    const oldest = recent[recent.length - 1];
    return { ok: false, reason: "limit_day", retryAfterSec: Math.ceil((24 * 60 * 60 * 1000 - (t - oldest.getTime())) / 1000) };
  }
  return { ok: true };
}

const failed = (tx: TenantTxClient, businessId: number, periodId: number, deliveryId: number, reason: string, now: Date) =>
  appendEvent(tx, {
    businessId,
    periodId,
    deliveryId,
    eventType: "LINK_CODE_FAILED",
    actor: { type: "RECIPIENT" },
    occurredAt: now,
    payload: { reason },
    idempotencyKey: `code-failed:${deliveryId}:${now.getTime()}:${randomBytes(4).toString("hex")}`,
  });

// ── The device ───────────────────────────────────────────────────────────────────────────────────

/** Whether this request carries a live device of THIS delivery. Marks it seen. Must run inside the tenant job. */
export async function trustedDevice(businessId: number, deliveryId: number, token: string | null, now: Date): Promise<boolean> {
  if (!token) return false;
  const tokenHash = hashDeviceToken(token);
  return tenantTx(businessId, async (tx) => {
    const n = await tx.accountantLinkDevice.updateMany({
      where: { businessId, deliveryId, tokenHash, revokedAt: null, expiresAt: { gt: now } },
      data: { lastSeenAt: now },
    });
    return n.count === 1;
  });
}

// ── Issuing a code ───────────────────────────────────────────────────────────────────────────────

export type IssueOutcome =
  | { ok: true; challengeId: number; code: string; to: string; expiresAt: Date }
  | { ok: false; reason: "cooldown" | "limit_15min" | "limit_day"; retryAfterSec: number }
  | { ok: false; reason: "no_recipient" };

/**
 * Issues a code for a delivery whose link was already checked (live, accepted, not revoked). The address is the
 * delivery's own snapshot — the caller never supplies one. The limits and the insert run in one transaction under a
 * row lock on the delivery, so two requests at once cannot both pass the limit.
 */
export async function issueCode(businessId: number, deliveryId: number, now: Date): Promise<IssueOutcome> {
  return tenantTx(businessId, async (tx) => {
    const locked = await tx.$queryRaw<Array<{ periodId: number; recipientEmail: string | null }>>`
      SELECT "periodId", "recipientEmail" FROM "AccountantDelivery" WHERE "id" = ${deliveryId} AND "businessId" = ${businessId} FOR UPDATE`;
    const d = locked[0];
    if (!d || !d.recipientEmail) return { ok: false, reason: "no_recipient" } as const;
    const issued = await tx.accountantLinkChallenge.findMany({
      where: { businessId, deliveryId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      select: { createdAt: true },
    });
    const decision = codeIssueDecision(issued.map((c) => c.createdAt), now);
    if (!decision.ok) {
      await failed(tx, businessId, d.periodId, deliveryId, decision.reason, now);
      return decision;
    }
    const code = newCode();
    const salt = randomBytes(16).toString("hex");
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    const c = await tx.accountantLinkChallenge.create({
      data: { businessId, deliveryId, salt, codeHash: hashCode(deliveryId, salt, code), createdAt: now, expiresAt },
      select: { id: true },
    });
    await appendEvent(tx, {
      businessId,
      periodId: d.periodId,
      deliveryId,
      eventType: "LINK_CODE_SENT",
      actor: { type: "RECIPIENT" },
      occurredAt: now,
      payload: { challengeId: c.id },
      idempotencyKey: `code-sent:${c.id}`,
    });
    return { ok: true, challengeId: c.id, code, to: d.recipientEmail, expiresAt };
  });
}

/** The email could not be sent: recorded (the code exists but nobody received it; it still counts toward the limits). */
export async function recordCodeNotSent(businessId: number, deliveryId: number, now: Date): Promise<void> {
  await tenantTx(businessId, async (tx) => {
    const d = await tx.accountantDelivery.findFirst({ where: { id: deliveryId, businessId }, select: { periodId: true } });
    if (d) await failed(tx, businessId, d.periodId, deliveryId, "not_sent", now);
  });
}

// ── Checking a code ──────────────────────────────────────────────────────────────────────────────

export type VerifyOutcome =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: "no_code" | "expired" | "locked" | "wrong" | "used"; attemptsLeft: number };

/**
 * Checks a code against the delivery's newest live code. A wrong code costs an attempt (5 at most, counted by a
 * conditional update so concurrent guesses cannot exceed it); the right one is consumed by a conditional update, so of
 * two concurrent uses exactly one gets the device. The device lives until the link expires.
 */
export async function verifyCode(
  businessId: number,
  deliveryId: number,
  code: string,
  linkExpiresAt: Date,
  now: Date
): Promise<VerifyOutcome> {
  return tenantTx(businessId, async (tx) => {
    const d = await tx.accountantDelivery.findFirst({ where: { id: deliveryId, businessId }, select: { periodId: true } });
    if (!d) return { ok: false, reason: "no_code", attemptsLeft: 0 } as const;
    const c = await tx.accountantLinkChallenge.findFirst({
      where: { businessId, deliveryId, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const fail = async (reason: "no_code" | "expired" | "locked" | "wrong" | "used", attemptsLeft: number) => {
      await failed(tx, businessId, d.periodId, deliveryId, reason, now);
      return { ok: false, reason, attemptsLeft } as const;
    };
    if (!isCode(code)) return fail("wrong", c ? Math.max(0, CODE_MAX_ATTEMPTS - c.attempts) : 0);
    if (!c) return fail("no_code", 0);
    if (c.expiresAt.getTime() <= now.getTime()) return fail("expired", 0);
    if (c.attempts >= CODE_MAX_ATTEMPTS) return fail("locked", 0);

    const expected = Buffer.from(c.codeHash, "hex");
    const given = Buffer.from(hashCode(deliveryId, c.salt, code), "hex");
    const match = expected.length === given.length && timingSafeEqual(expected, given);
    if (!match) {
      const counted = await tx.accountantLinkChallenge.updateMany({
        where: { id: c.id, businessId, consumedAt: null, attempts: { lt: CODE_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      if (counted.count !== 1) return fail("locked", 0);
      const left = Math.max(0, CODE_MAX_ATTEMPTS - (c.attempts + 1));
      return fail(left === 0 ? "locked" : "wrong", left);
    }
    const used = await tx.accountantLinkChallenge.updateMany({
      where: { id: c.id, businessId, consumedAt: null, attempts: { lt: CODE_MAX_ATTEMPTS } },
      data: { consumedAt: now },
    });
    if (used.count !== 1) return fail("used", 0);

    const token = randomBytes(32).toString("base64url");
    const expiresAt = linkExpiresAt.getTime() > now.getTime() ? linkExpiresAt : new Date(now.getTime() + 60_000);
    const device = await tx.accountantLinkDevice.create({
      data: { businessId, deliveryId, tokenHash: hashDeviceToken(token), createdAt: now, expiresAt },
      select: { id: true },
    });
    await appendEvent(tx, {
      businessId,
      periodId: d.periodId,
      deliveryId,
      eventType: "LINK_DEVICE_VERIFIED",
      actor: { type: "RECIPIENT" },
      occurredAt: now,
      payload: { deviceId: device.id, challengeId: c.id },
      idempotencyKey: `device:${device.id}`,
    });
    return { ok: true, token, expiresAt };
  });
}

// ── Sending the code ─────────────────────────────────────────────────────────────────────────────

export type CodeDeps = { provider: (apiKey: string) => EmailProvider };
export const defaultCodeDeps: CodeDeps = { provider: (apiKey) => createResendProvider({ apiKey }) };

export type SendCodeOutcome =
  | { ok: true; maskedTo: string; expiresAt: Date }
  | { ok: false; reason: "unavailable" | "no_recipient" | "not_sent" }
  | { ok: false; reason: "cooldown" | "limit_15min" | "limit_day"; retryAfterSec: number };

/**
 * Issues a code for an opened link and emails it to the delivery's recipient. Without a working email
 * configuration nothing is issued (the limits are not spent). The provider call happens after the code's row
 * committed, under the idempotency key acct-otp:<challengeId> — a retry never sends a second, different email.
 */
export async function sendLinkCode(
  link: { businessId: number; deliveryId: number; businessName: string; periodKey: string },
  now: Date,
  deps: CodeDeps = defaultCodeDeps
): Promise<SendCodeOutcome> {
  const cfg = readTransactionalEmailConfig();
  if (!cfg.enabled || !("ok" in cfg) || !cfg.ok) return { ok: false, reason: "unavailable" };
  const issued = await issueCode(link.businessId, link.deliveryId, now);
  if (!issued.ok) return issued;
  const rendered = renderAccountantCodeEmail({
    businessName: link.businessName,
    periodLabel: periodLabelHe(link.periodKey),
    code: issued.code,
    minutes: Math.round(CODE_TTL_MS / 60_000),
  });
  let sent = false;
  try {
    const r = await deps.provider(cfg.config.apiKey).send({
      idempotencyKey: `acct-otp:${issued.challengeId}`,
      from: cfg.config.from,
      replyTo: cfg.config.replyTo,
      to: issued.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    sent = r.outcome === "sent";
  } catch {
    sent = false;
  }
  if (!sent) {
    await recordCodeNotSent(link.businessId, link.deliveryId, now);
    return { ok: false, reason: "not_sent" };
  }
  return { ok: true, maskedTo: maskEmail(issued.to), expiresAt: issued.expiresAt };
}

/** The delivery's masked recipient, for the "verify this device" screen (before any code is sent). */
export async function maskedRecipient(businessId: number, deliveryId: number): Promise<string | null> {
  const d = await tenantTx(businessId, (tx) =>
    tx.accountantDelivery.findFirst({ where: { id: deliveryId, businessId }, select: { recipientEmail: true } })
  );
  return d?.recipientEmail ? maskEmail(d.recipientEmail) : null;
}
