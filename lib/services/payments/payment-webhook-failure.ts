/**
 * When a payment webhook must NOT be acknowledged.
 *
 * The rule before this file: every outcome of an enabled provider's webhook answered 200 { ok: true }, "to avoid
 * provider retry storms". That rule made one class of failure silent and permanent: when the database (or the
 * provider's verification API) was unavailable, the callback was answered 200, nothing — or only a FAILED row —
 * was kept, and the provider never sent it again. During the 2026-10-30/31 Neon outage every callback in a ~40 h
 * window would have been lost this way; only reconciliation could still find the money, slowly.
 *
 * The rule now — exactly two answers, decided here and nowhere else:
 *
 *   503 { ok: false, error: "temporarily_unavailable" }
 *       the callback could not be received or processed because INFRASTRUCTURE failed: the database could not be
 *       reached / timed out / dropped the connection, or the provider's own verification API could not be asked
 *       (resolution VERIFICATION_ERROR). Asking the provider to send it again is exactly right: CardCom resends a
 *       non-200 report up to 7 times (after 1, 2, 2, 16, 60 minutes, then 12 h and 12 h — CardCom KB, API v11
 *       "Create payment page & retrieve transaction details"), and a redelivery is safe:
 *         - the money row is UNIQUE (provider, providerTransactionId) with a P2002 read-back;
 *         - the accounting settlement is UNIQUE per payment transaction, so one receipt;
 *         - a redelivered event that ended RECEIVED / FAILED is asked again, PROCESSED is a no-op.
 *
 *   200 { ok: true }
 *       everything else, unchanged: processed, duplicate, pending at the provider, and EVERY refusal (bad shape or
 *       signature, unknown request, correlation / amount / currency mismatch, quarantined business, no active
 *       connection) and any non-infrastructure error. A refusal is not retried — retrying it cannot change it — and
 *       it must look the same whether or not the identifiers exist (no enumeration oracle; docs/casa-7-2-cardcom-
 *       webhook-compensating-control-v1.md). A 503 is never a function of the identifiers: a database failure at the
 *       correlation step happens before anything about them is known.
 *
 * Nothing here changes what is recorded, charged or issued — only whether the provider is told to try again.
 */

import { classifyFailure } from "@/lib/ops/db-health";
import { safeErrorSummary, type SafeErrorSummary } from "@/lib/security/log-safe-error";

/**
 * Prisma error codes that mean "the database was not available for this operation", not "this operation is wrong":
 * P1001 can't reach, P1002 timed out reaching, P1008 operation timed out, P1017 server closed the connection,
 * P2024 connection-pool timeout, P2028 transaction API error (expired / closed under us), P2034 write conflict or
 * deadlock (retryable by definition).
 */
const PRISMA_TRANSIENT = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"]);
/** Driver / socket / Postgres class-08 and resource codes with the same meaning. */
const DRIVER_TRANSIENT = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08004", "08006",
]);

/** True only for a failure of the database itself (reachability, timeout, dropped connection, pool exhaustion). */
export function isTransientInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "PrismaClientInitializationError" || error.name === "PrismaClientRustPanicError") return true;
  const raw = (error as { code?: unknown; errorCode?: unknown }).errorCode ?? (error as { code?: unknown }).code;
  if (typeof raw === "string" && (PRISMA_TRANSIENT.has(raw) || DRIVER_TRANSIENT.has(raw))) return true;
  // Prisma 6 does not always attach a code; the probe's fixed wording patterns decide (the text is never echoed).
  return classifyFailure(error) === "unreachable";
}

/**
 * Result reasons (ProcessWebhookResult.reason) that are infrastructure failures the service records and returns
 * instead of throwing. `verification_error`: the provider's status API could not be asked (network, timeout,
 * provider outage) — nothing was established, the event stays FAILED, and a redelivery asks again.
 */
export const TRANSIENT_RESULT_REASONS: ReadonlySet<string> = new Set(["verification_error"]);

export type WebhookAnswer =
  | { status: 200; body: { ok: true } }
  | { status: 503; body: { ok: false; error: "temporarily_unavailable" }; retryAfterSeconds: number };

export const ACKNOWLEDGED: WebhookAnswer = { status: 200, body: { ok: true } };
export const RETRY_LATER: WebhookAnswer = {
  status: 503,
  body: { ok: false, error: "temporarily_unavailable" },
  retryAfterSeconds: 60,
};

/** The answer for an error that escaped processing (or a route's own wiring). */
export function answerForError(error: unknown): WebhookAnswer {
  return isTransientInfrastructureError(error) ? RETRY_LATER : ACKNOWLEDGED;
}

/** The answer for a completed processing result. */
export function answerForResult(result: { reason: string | null }): WebhookAnswer {
  return result.reason !== null && TRANSIENT_RESULT_REASONS.has(result.reason) ? RETRY_LATER : ACKNOWLEDGED;
}

/** What a webhook log line may carry about an error: its class and machine code, never its message. */
export function webhookErrorLog(error: unknown): SafeErrorSummary & { transient: boolean } {
  return { ...safeErrorSummary(error), transient: isTransientInfrastructureError(error) };
}
