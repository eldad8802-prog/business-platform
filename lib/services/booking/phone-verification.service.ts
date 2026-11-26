/**
 * Phone verification on the public booking link (G2, design c — appointments completion program, workstream G).
 * SERVER-ONLY. The rules are in phone-verification.core.ts; the table and its guarantees in migration
 * 20261230090000_appointments_completion ("BookingPhoneChallenge": hashes only, 5-minute default lifetime, attempts
 * 0..5, a guard trigger for single use, one OPEN challenge per business + phone).
 *
 *   issue    a new 6-digit code for (business, phone): the IP and every send cap are checked first (platform-wide through
 *            booking_otp_send_counts() — counts only —, the business's own rows in its tenant transaction), then the
 *            resend cooldown; the open challenge is superseded and the new one inserted IN THE SAME TRANSACTION (the
 *            partial unique index refuses a second open one — a racing request is answered as the cooldown); a
 *            verified-but-unused one is retired (consumedAt). AFTER that transaction commits, workstream F's
 *            sendBookingVerificationCode() sends it (messageClass VERIFICATION, one delivery row per send — the code is
 *            never stored). A failed send is final (the worker never retries it); the customer asks again after the
 *            cooldown, which is a new challenge, inside the caps.
 *   verify   the business's open challenge for the phone, locked FOR UPDATE (parallel guesses are serialized, so the
 *            attempt limit holds); expired, superseded, out of attempts, unknown and wrong are ONE answer (OTP_INVALID);
 *            a wrong code counts an attempt; a right one sets verifiedAt and hands the browser a verification token.
 *   consume  inside the submit's own locked transaction: a verified, unconsumed challenge for the SAME phone at the SAME
 *            business, verified within OTP_POLICY.verifiedUseMinutes, whose token the browser presents — consumed in that
 *            transaction (single use; a rolled-back submit leaves it usable). Owner requirement 8: there is no path that
 *            skips this, whatever BookingSettings.requireVerification holds (the column is never read).
 *
 * No answer depends on whether the phone has bookings or is a known customer: nothing here reads them.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { toE164 } from "@/lib/notifications/customer/appointment-messages";
import { sendBookingVerificationCode, type VerificationSendResult } from "@/lib/notifications/customer/verification";
import { customerMessagesEntitlement } from "@/lib/notifications/customer/customer-entitlement";
import type { TransportDeps } from "@/lib/notifications/customer/platform-transport";

import { AppointmentServiceError, invalid } from "@/lib/services/appointment/appointment-errors";

import { parsePublicPhone } from "./booking.core";
import {
  capExceeded,
  codeHashOf,
  codeMatches,
  cooldownLeftSeconds,
  ipHashOf,
  newOtpCode,
  OTP_CODE,
  OTP_POLICY,
  otpKeysFromEnv,
  phoneHashesOf,
  phoneHashOf,
  tokenMatches,
  VERIFICATION_TOKEN,
  verificationDeliveryAvailable,
  verificationTokenOf,
  type OtpCounts,
} from "./phone-verification.core";

type Tx = Prisma.TransactionClient;
const MIN = 60_000;

// ── Test seams (the DB batteries; never set by application code) ───────────────────────────────────

type OtpHooks = {
  /** Replace the random code (tests read it back). */
  generateCode?: () => string;
  /** Replace the delivery-path decision (tests: true without live credentials). */
  deliveryAvailable?: () => boolean;
  /** Passed to sendBookingVerificationCode (tests: { transport: { env: {} } } — simulate, no network). */
  send?: { transport?: TransportDeps; entitled?: (businessId: number) => Promise<boolean> };
};
let hooks: OtpHooks = {};
export function __setOtpTestHooks(next: OtpHooks | null): void {
  hooks = next ?? {};
}

/** Can a code be DELIVERED now (live WhatsApp path)? The public door answers 404 while it cannot (G3). */
export function otpDeliveryAvailable(): boolean {
  return hooks.deliveryAvailable ? hooks.deliveryAvailable() : verificationDeliveryAvailable();
}

function e164Of(raw: unknown): { digits: string; e164: string } {
  const digits = parsePublicPhone(raw);
  const e164 = digits ? toE164(digits) : null;
  if (!digits || !e164) throw invalid("phone");
  return { digits, e164 };
}

// ── Issue ──────────────────────────────────────────────────────────────────────────────────────

/** The platform-wide counts (all businesses) for one phone hash and one IP hash since a moment (≤ 24 h back). */
async function platformCounts(phoneHash: string, ipHash: string, since: Date): Promise<{ phone: number; ip: number }> {
  const rows = await prisma.$queryRaw<{ phoneSends: number; ipSends: number }[]>`
    SELECT "phoneSends", "ipSends" FROM public.booking_otp_send_counts(${phoneHash}, ${ipHash}, (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')::timestamp(3))`;
  return { phone: Number(rows[0]?.phoneSends ?? 0), ip: Number(rows[0]?.ipSends ?? 0) };
}

async function sumSends(tx: Tx, where: Prisma.BookingPhoneChallengeWhereInput): Promise<number> {
  const r = await tx.bookingPhoneChallenge.aggregate({ where, _sum: { sends: true } });
  return r._sum.sends ?? 0;
}

export type IssueResult = { sent: true; expiresInSeconds: number; resendInSeconds: number };

/**
 * A new code for `phone` at `businessId` (already resolved by the public door). `ip` is the client address as the
 * edge reports it (only its keyed hash is kept).
 */
export async function issueBookingCode(businessId: number, input: { phone?: unknown }, ctx: { ip: string; now?: Date }): Promise<IssueResult> {
  const now = ctx.now ?? new Date();
  const { digits, e164 } = e164Of(input.phone);
  if (!otpDeliveryAvailable()) throw new AppointmentServiceError("OTP_UNAVAILABLE");
  // The business may message customers at all (appointments AND public_booking AND the notifications_engine kill
  // switch — workstream F's gate): refused BEFORE a challenge is written, so a switched-off business burns no cap.
  const entitled = hooks.send?.entitled ? await hooks.send.entitled(businessId) : (await customerMessagesEntitlement(businessId)).allowed;
  if (!entitled) throw new AppointmentServiceError("OTP_UNAVAILABLE");
  const keys = otpKeysFromEnv();
  const phoneHash = phoneHashOf(keys.current, e164);
  const phoneHashes = phoneHashesOf(keys, e164);
  const ipHash = ipHashOf(keys.current, ctx.ip || "unknown");

  const hourAgo = new Date(now.getTime() - 60 * MIN);
  const dayAgo = new Date(now.getTime() - 24 * 60 * MIN);
  const [hour, day] = [await platformCounts(phoneHash, ipHash, hourAgo), await platformCounts(phoneHash, ipHash, dayAgo)];

  let code = "";

  const issued = await tenantTx(businessId, async (tx) => {
    const counts: OtpCounts = {
      phoneHour: hour.phone, phoneDay: day.phone, ipHour: hour.ip, ipDay: day.ip,
      businessHour: await sumSends(tx, { businessId, createdAt: { gte: hourAgo } }),
      businessDay: await sumSends(tx, { businessId, createdAt: { gte: dayAgo } }),
      phoneBusinessHour: await sumSends(tx, { businessId, phoneHash: { in: phoneHashes }, createdAt: { gte: hourAgo } }),
    };
    if (capExceeded(counts)) return { kind: "limit" as const };
    const latest = await tx.bookingPhoneChallenge.findFirst({
      where: { businessId, phoneHash: { in: phoneHashes } }, orderBy: { createdAt: "desc" }, select: { createdAt: true },
    });
    const wait = cooldownLeftSeconds(latest?.createdAt ?? null, now);
    if (wait > 0) return { kind: "cooldown" as const, wait };
    // Only now — every cap and the cooldown passed — is a code drawn (a refused request never makes one).
    code = hooks.generateCode ? hooks.generateCode() : newOtpCode();
    if (!OTP_CODE.test(code)) throw new Error("otp code generator returned a malformed code");
    // A new code invalidates the previous ones: the open one is superseded, a verified-but-unused one retired.
    await tx.bookingPhoneChallenge.updateMany({
      where: { businessId, phoneHash: { in: phoneHashes }, verifiedAt: null, supersededAt: null, erasedAt: null },
      data: { supersededAt: now },
    });
    await tx.bookingPhoneChallenge.updateMany({
      where: { businessId, phoneHash: { in: phoneHashes }, verifiedAt: { not: null }, consumedAt: null, erasedAt: null },
      data: { consumedAt: now },
    });
    const row = await tx.bookingPhoneChallenge.create({
      data: {
        businessId, phoneHash, ipHash, codeHash: codeHashOf(keys.current, businessId, phoneHash, code),
        attempts: 0, sends: 1, createdAt: now, expiresAt: new Date(now.getTime() + OTP_POLICY.lifetimeMinutes * MIN),
      },
      select: { id: true },
    });
    return { kind: "issued" as const, challengeId: row.id };
  }).catch((e: unknown) => {
    // Two requests raced past the cooldown: the partial unique index let only one open challenge in.
    if ((e as { code?: string })?.code === "P2002") return { kind: "cooldown" as const, wait: OTP_POLICY.resendCooldownSeconds };
    throw e;
  });

  if (issued.kind === "limit") throw new AppointmentServiceError("OTP_LIMIT");
  if (issued.kind === "cooldown") throw new AppointmentServiceError("OTP_COOLDOWN", { retryAfterSeconds: issued.wait });

  // AFTER the challenge's transaction committed (F's API opens its own tenant transactions).
  const sent: VerificationSendResult = await sendBookingVerificationCode(
    { businessId, challengeId: issued.challengeId, sendIndex: 1, phone: digits, code, now },
    hooks.send ?? {},
  );
  if (!sent.ok) {
    if (sent.reason === "not_entitled") throw new AppointmentServiceError("OTP_UNAVAILABLE");
    throw new AppointmentServiceError("OTP_UNAVAILABLE", { retryAfterSeconds: OTP_POLICY.resendCooldownSeconds });
  }
  return { sent: true, expiresInSeconds: OTP_POLICY.lifetimeMinutes * 60, resendInSeconds: OTP_POLICY.resendCooldownSeconds };
}

// ── Verify ─────────────────────────────────────────────────────────────────────────────────────

export type VerifyResult = { verified: true; verificationToken: string; validForSeconds: number };

const isGuard = (e: unknown) => /DZA05|BOOKING_CHALLENGE_GUARD/.test(String((e as { message?: string })?.message ?? "")) || (e as { meta?: { code?: string } })?.meta?.code === "DZA05";

/** Check `code` for `phone` at `businessId`. Every failure is the same OTP_INVALID. */
export async function verifyBookingCode(businessId: number, input: { phone?: unknown; code?: unknown }, nowIn?: Date): Promise<VerifyResult> {
  const now = nowIn ?? new Date();
  const { e164 } = e164Of(input.phone);
  const code = typeof input.code === "string" ? input.code.replace(/[\s-]/g, "") : "";
  if (!OTP_CODE.test(code)) throw invalid("code");
  const keys = otpKeysFromEnv();
  const phoneHashes = phoneHashesOf(keys, e164);

  const outcome = await tenantTx(businessId, async (tx) => {
    // Locked: concurrent guesses at the same challenge are checked one after another (the attempt limit holds).
    const rows = await tx.$queryRaw<{ id: number; codeHash: string | null; attempts: number; expiresAt: Date }[]>`
      SELECT "id", "codeHash", "attempts", "expiresAt" FROM "BookingPhoneChallenge"
       WHERE "businessId" = ${businessId} AND "phoneHash" = ANY(${phoneHashes}::text[])
         AND "verifiedAt" IS NULL AND "supersededAt" IS NULL AND "erasedAt" IS NULL
       ORDER BY "id" DESC LIMIT 1 FOR UPDATE`;
    const c = rows[0];
    if (!c || !c.codeHash) {
      // Spend a comparison anyway: "no code was ever sent" must not answer faster than "wrong code".
      codeMatches(keys, "0".repeat(64), businessId, phoneHashes, code);
      return { ok: false as const };
    }
    if (c.attempts >= OTP_POLICY.maxAttempts || c.expiresAt.getTime() <= now.getTime()) {
      codeMatches(keys, c.codeHash, businessId, phoneHashes, code);
      return { ok: false as const };
    }
    if (!codeMatches(keys, c.codeHash, businessId, phoneHashes, code)) {
      await tx.bookingPhoneChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
      return { ok: false as const };
    }
    await tx.bookingPhoneChallenge.update({ where: { id: c.id }, data: { verifiedAt: now, attempts: { increment: 1 } } });
    return { ok: true as const, challengeId: c.id };
  }).catch((e: unknown) => {
    // The database's own clock found it expired a moment later (the guard trigger): the same answer.
    if (isGuard(e)) return { ok: false as const };
    throw e;
  });

  if (!outcome.ok) throw new AppointmentServiceError("OTP_INVALID");
  return {
    verified: true,
    verificationToken: verificationTokenOf(keys.current, businessId, outcome.challengeId, now),
    validForSeconds: OTP_POLICY.verifiedUseMinutes * 60,
  };
}

// ── Consume (inside the submit's transaction) ────────────────────────────────────────────────────

async function verifiedCandidates(tx: Tx, businessId: number, phoneDigits: string, now: Date) {
  const e164 = toE164(phoneDigits);
  if (!e164) return [];
  const keys = otpKeysFromEnv();
  return tx.bookingPhoneChallenge.findMany({
    where: {
      businessId, phoneHash: { in: phoneHashesOf(keys, e164) }, verifiedAt: { not: null, gt: new Date(now.getTime() - OTP_POLICY.verifiedUseMinutes * MIN) },
      consumedAt: null, erasedAt: null,
    },
    orderBy: { verifiedAt: "desc" },
    take: 5,
    select: { id: true, verifiedAt: true },
  });
}

function matching(businessId: number, rows: { id: number; verifiedAt: Date | null }[], token: string) {
  const keys = otpKeysFromEnv();
  let hit: { id: number; verifiedAt: Date } | null = null;
  for (const r of rows) {
    if (r.verifiedAt && tokenMatches(keys, token, businessId, r.id, r.verifiedAt) && !hit) hit = { id: r.id, verifiedAt: r.verifiedAt };
  }
  return hit;
}

/**
 * A read-only look BEFORE the submit spends anything (its per-business rate limit): is there a usable verification for
 * this phone and token? The real check is consumeVerifiedPhone, in the submit's locked transaction.
 */
export async function hasVerifiedPhone(businessId: number, phoneDigits: string, token: unknown, nowIn?: Date): Promise<boolean> {
  if (typeof token !== "string" || !VERIFICATION_TOKEN.test(token)) return false;
  const now = nowIn ?? new Date();
  return tenantTx(businessId, async (tx) => matching(businessId, await verifiedCandidates(tx, businessId, phoneDigits, now), token) !== null);
}

/** Single use: marks the matching verification consumed in the caller's transaction; returns when it was verified. */
export async function consumeVerifiedPhone(tx: Tx, businessId: number, phoneDigits: string, token: unknown, now: Date): Promise<Date> {
  if (typeof token !== "string" || !VERIFICATION_TOKEN.test(token)) throw new AppointmentServiceError("PHONE_NOT_VERIFIED");
  const hit = matching(businessId, await verifiedCandidates(tx, businessId, phoneDigits, now), token);
  if (!hit) throw new AppointmentServiceError("PHONE_NOT_VERIFIED");
  const n = await tx.bookingPhoneChallenge.updateMany({ where: { id: hit.id, businessId, consumedAt: null }, data: { consumedAt: now } });
  if (n.count !== 1) throw new AppointmentServiceError("PHONE_NOT_VERIFIED");
  return hit.verifiedAt;
}
