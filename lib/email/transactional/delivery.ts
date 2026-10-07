/**
 * Delivery — moves one row PENDING → SENDING → SENT | PENDING (retry) | FAILED | EXPIRED.
 *
 *   1. CLAIM. One conditional UPDATE: the row is due (PENDING whose nextAttemptAt has come, or a
 *      SENDING whose lease ran out because its worker died) and not expired. It becomes SENDING,
 *      `attempts` goes up by one and `nextAttemptAt` becomes the lease end. PostgreSQL re-checks the
 *      WHERE under the row lock, so of two workers racing for the same row exactly one matches;
 *      the other claims nothing and sends nothing.
 *   2. RENDER from the stored payload (unknown kind / invalid payload → FAILED, never retried).
 *   3. SEND with the idempotency key `te:<id>` — the same on every attempt of the row, so even a
 *      worker that crashed after the provider accepted, followed by a re-claim, cannot produce a
 *      second email: the provider answers the repeat with the first result. The row's lifetime
 *      (WELCOME: 24h) never exceeds the provider's 24h idempotency window.
 *   4. FINALIZE, fenced on (status SENDING, attempts = the claimed attempt): only the claim holder
 *      can record the outcome.
 *
 * It runs on the signup / delivery plane (app_auth), which holds UPDATE on the delivery columns
 * only. While TRANSACTIONAL_EMAIL_ENABLED is not "true" nothing here touches the database or the
 * network. Logs carry the row id, kind, status and machine codes — never an address, a name or
 * a body.
 */

import type { PrismaClient } from "@prisma/client";

import { authDb, isAuthPlaneActive } from "@/lib/prisma-auth";

import { readTransactionalEmailConfig, type TransactionalEmailEnv } from "./config";
import { idempotencyKeyFor, type EmailProvider, type SendResult } from "./provider";
import { renderStored } from "./registry";
import { createResendProvider } from "./resend";

/** Longer than the provider timeout, so an attempt is over before anyone may re-claim the row. */
export const CLAIM_LEASE_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 7;
/** Delay before attempt n+1, by attempts already made (1-based). */
export const RETRY_DELAYS_MS = [
  60_000, // after 1st
  5 * 60_000, // after 2nd
  15 * 60_000, // after 3rd
  60 * 60_000, // after 4th
  3 * 60 * 60_000, // after 5th
  6 * 60 * 60_000, // after 6th
] as const;

export type DeliveryOutcome =
  | "disabled"
  | "not_configured"
  | "auth_plane_inactive"
  | "not_claimable"
  | "sent"
  | "retry_scheduled"
  | "failed"
  | "expired"
  | "lost_claim";

export type Finalization =
  | { status: "SENT"; providerMessageId: string | null }
  | { status: "PENDING"; nextAttemptAt: Date; code: string }
  | { status: "FAILED"; code: string }
  | { status: "EXPIRED"; code: string };

export function retryDelayMs(attemptsMade: number, retryAfterMs: number | null): number {
  const base = RETRY_DELAYS_MS[Math.min(Math.max(attemptsMade, 1), RETRY_DELAYS_MS.length) - 1];
  return retryAfterMs !== null && retryAfterMs > base ? retryAfterMs : base;
}

/** What a send result means for the row. Pure: the whole retry / expiry policy in one place. */
export function decideFinalization(
  result: SendResult,
  row: { attempts: number; expiresAt: Date },
  now: Date
): Finalization {
  if (result.outcome === "sent") return { status: "SENT", providerMessageId: result.providerMessageId };
  if (result.outcome === "permanent") return { status: "FAILED", code: result.code };
  if (row.attempts >= MAX_ATTEMPTS) return { status: "FAILED", code: `${result.code}_max_attempts` };
  const nextAttemptAt = new Date(now.getTime() + retryDelayMs(row.attempts, result.retryAfterMs));
  if (nextAttemptAt.getTime() >= row.expiresAt.getTime()) return { status: "EXPIRED", code: `${result.code}_ttl` };
  return { status: "PENDING", nextAttemptAt, code: result.code };
}

type Db = Pick<PrismaClient, "transactionalEmail">;

export type DeliverOptions = {
  now?: Date;
  env?: TransactionalEmailEnv;
  db?: Db;
  provider?: EmailProvider;
  /** Test seam for the auth-plane mode check. */
  authPlaneActive?: () => boolean;
};

function log(event: string, fields: Record<string, string | number | null>) {
  console.info(`[transactional-email] ${event}`, fields);
}

/** The claim condition, shared by the claim and the sweep's scan. */
export function dueWhere(now: Date) {
  return {
    expiresAt: { gt: now },
    OR: [
      { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: "SENDING", nextAttemptAt: { lte: now } },
    ],
  };
}

/** Claims and delivers one row. Never throws: a failure is an outcome, not an exception. */
export async function deliverTransactionalEmail(id: number, opts: DeliverOptions = {}): Promise<DeliveryOutcome> {
  try {
    return await deliverOnce(id, opts);
  } catch (error) {
    log("delivery_error", { id, error: error instanceof Error ? error.name : "unknown" });
    return "not_claimable";
  }
}

async function deliverOnce(id: number, opts: DeliverOptions): Promise<DeliveryOutcome> {
  const state = readTransactionalEmailConfig(opts.env);
  if (!state.enabled) return "disabled";
  if (!state.ok) {
    log("not_configured", { id, missing: state.missing.join(",") });
    return "not_configured";
  }
  if (!(opts.authPlaneActive ?? isAuthPlaneActive)()) return "auth_plane_inactive";

  const db: Db = opts.db ?? authDb();
  const now = opts.now ?? new Date();
  const provider = opts.provider ?? createResendProvider({ apiKey: state.config.apiKey });

  const claim = await db.transactionalEmail.updateMany({
    where: { id, ...dueWhere(now) },
    data: {
      status: "SENDING",
      attempts: { increment: 1 },
      nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      updatedAt: now,
    },
  });
  if (claim.count !== 1) return "not_claimable";

  const row = await db.transactionalEmail.findUnique({
    where: { id },
    select: { id: true, kind: true, toEmail: true, payload: true, attempts: true, expiresAt: true },
  });
  if (!row) return "lost_claim";

  const rendered = renderStored(row.kind, row.payload, { appBaseUrl: state.config.appBaseUrl });
  const result: SendResult = rendered
    ? await provider.send({
        idempotencyKey: idempotencyKeyFor(row.id),
        from: state.config.from,
        replyTo: state.config.replyTo,
        to: row.toEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      })
    : { outcome: "permanent", code: "invalid_payload" };

  const done = opts.now ?? new Date();
  const fin = decideFinalization(result, row, done);
  const fence = { id: row.id, status: "SENDING", attempts: row.attempts };
  const data =
    fin.status === "SENT"
      ? { status: "SENT", sentAt: done, provider: provider.name, providerMessageId: fin.providerMessageId, nextAttemptAt: null, lastErrorCode: null, updatedAt: done }
      : fin.status === "PENDING"
        ? { status: "PENDING", nextAttemptAt: fin.nextAttemptAt, lastErrorCode: fin.code, provider: provider.name, updatedAt: done }
        : { status: fin.status, nextAttemptAt: null, lastErrorCode: fin.code, provider: rendered ? provider.name : null, updatedAt: done };
  const written = await db.transactionalEmail.updateMany({ where: fence, data });
  if (written.count !== 1) {
    log("lost_claim", { id: row.id, kind: row.kind, attempt: row.attempts });
    return "lost_claim";
  }

  log("delivery", {
    id: row.id,
    kind: row.kind,
    attempt: row.attempts,
    status: fin.status,
    code: fin.status === "SENT" ? null : fin.code,
  });
  if (fin.status === "SENT") return "sent";
  if (fin.status === "PENDING") return "retry_scheduled";
  return fin.status === "FAILED" ? "failed" : "expired";
}
