/**
 * Payments audit trail (M7).
 *
 * An append-only record of the meaningful events in a payment's life: who/what
 * created a charge, who connected a provider, and every authority decision the
 * webhook flow reaches (verified PAID/FAILED/CANCELLED, signal-only, errors).
 *
 * Design mirrors the Billing audit pattern (typed event whitelist, stable hash,
 * USER source requires an actor) but is payments-specific:
 *   - it links to a PaymentRequest, not a BillingDocument;
 *   - it adds a PROVIDER source for verification-established outcomes;
 *   - emission is BEST-EFFORT through the PaymentStore port — an audit failure
 *     must never break the money path, and it stays DB-free for the pure
 *     services + their in-memory tests.
 *
 * There is no update/delete here: append-only by construction.
 */

import { createHash } from "crypto";
import { UnauthorizedError, ValidationError } from "@/lib/errors";
import type {
  AppendPaymentAuditEventRow,
  PaymentAuditEventRecord,
  PaymentAuditSource,
  PaymentStore,
} from "./payments.types";

export const PAYMENT_AUDIT_EVENT_TYPES = [
  // M1 — Charge & Request
  "PAYMENT_REQUEST_CREATED",
  // Collection — the owner stopped asking (the request, never money received).
  "PAYMENT_REQUEST_CANCELLED",
  // M3 — Provider Connectivity
  "PAYMENT_CONNECTION_UPSERTED",
  // M2 — Settlement & Verification (authority decisions)
  "PAYMENT_VERIFIED_PAID",
  "PAYMENT_VERIFIED_FAILED",
  "PAYMENT_VERIFIED_CANCELLED",
  "PAYMENT_SIGNAL_ONLY_NO_VERIFICATION",
  "PAYMENT_VERIFICATION_ERROR",
  "PAYMENT_VERIFICATION_UNAVAILABLE",
  // M1 — inbound money truth. The provider proved money arrived on a request
  // Dubiz had already closed (cancelled / lapsed / failed): the money is
  // recorded and the request follows it to PAID, with the prior state kept here.
  "PAYMENT_PAID_AFTER_REQUEST_CLOSED",
  // The provider's own verified amount or currency differs from the request.
  // The money is recorded as the provider states it; accounting is paused.
  "PAYMENT_VERIFIED_AMOUNT_MISMATCH",
  "PAYMENT_VERIFIED_CURRENCY_MISMATCH",
  // The provider said PAID but its answer lacked what recording requires — its
  // own transaction id, or the amount and currency. Nothing is recorded;
  // reconciliation keeps asking. Written once per request.
  "PAYMENT_VERIFIED_WITHOUT_TRANSACTION_ID",
  "PAYMENT_VERIFIED_WITHOUT_AMOUNT",
  // The provider's transaction id is already recorded against a DIFFERENT
  // request. Never merged, never recorded twice. Written once per request.
  "PAYMENT_PROVIDER_TRANSACTION_CONFLICT",
  // The provider's answer concerned a different payment or terminal than the
  // one asked about. Nothing recorded; written once per request.
  "PAYMENT_PROVIDER_ANSWER_MISMATCH",
  // M1 Production proof: the pinned QA tenant's request was issued with a
  // callback URL nothing processes (qa-webhook-suppression.ts).
  "PAYMENT_REQUEST_QA_WEBHOOK_SUPPRESSED",
  // M5 — Reversal. Four types, because a refund has four distinguishable ends
  // and collapsing them would hide the one that matters most. REQUESTED is
  // written BEFORE the provider is called, so an instruction that left Dubiz is
  // on the record even if nothing after it survives. SETTLED is the provider's
  // own establishment of the reversal. INDETERMINATE is the provider neither
  // confirming nor refusing, which stays open rather than resolving itself in
  // either direction. FAILED is a definite refusal, where no money moved.
  "PAYMENT_REFUND_REQUESTED",
  "PAYMENT_REFUND_SETTLED",
  "PAYMENT_REFUND_INDETERMINATE",
  "PAYMENT_REFUND_FAILED",
  // C3 — Accounting settlement of a verified payment (SYSTEM-sourced). SETTLED:
  // one receipt issued and allocated. REQUIRES_ATTENTION: paused on a cause a
  // person must resolve (the money stays PAID). RETRY_SCHEDULED: a transient
  // failure rolled the attempt back and the next one is due.
  "PAYMENT_ACCOUNTING_SETTLED",
  "PAYMENT_ACCOUNTING_REQUIRES_ATTENTION",
  "PAYMENT_ACCOUNTING_RETRY_SCHEDULED",
  // The owner named who paid a verified payment that arrived with no customer.
  "PAYMENT_ACCOUNTING_CUSTOMER_NAMED",
] as const;

export type PaymentAuditEventType = (typeof PAYMENT_AUDIT_EVENT_TYPES)[number];

export const PAYMENT_AUDIT_SOURCES = [
  "USER", // a person acting through an authenticated route
  "SYSTEM", // an engine decision (no human actor)
  "PROVIDER", // an outcome established by provider verification
] as const satisfies readonly PaymentAuditSource[];

const PAYMENT_AUDIT_EVENT_TYPE_SET = new Set<string>(PAYMENT_AUDIT_EVENT_TYPES);
const PAYMENT_AUDIT_SOURCE_SET = new Set<string>(PAYMENT_AUDIT_SOURCES);

export interface CreatePaymentAuditEventInput {
  businessId: number;
  paymentRequestId?: number | null;
  actorUserId?: number | null;
  eventType: PaymentAuditEventType;
  source: PaymentAuditSource;
  summary: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
}

/** Deterministic JSON for hashing — keys sorted, undefined coerced to null. */
function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function hashPaymentAuditEvent(row: Omit<AppendPaymentAuditEventRow, "eventHash">): string {
  return createHash("sha256")
    .update(
      stableJsonStringify({
        businessId: row.businessId,
        paymentRequestId: row.paymentRequestId,
        actorUserId: row.actorUserId,
        eventType: row.eventType,
        source: row.source,
        summary: row.summary,
        metadata: row.metadata,
        occurredAt: row.occurredAt.toISOString(),
      })
    )
    .digest("hex");
}

/** Validate + normalize + hash. Throws on invalid input. */
export function buildPaymentAuditRow(
  input: CreatePaymentAuditEventInput
): AppendPaymentAuditEventRow {
  if (!input.businessId || Number.isNaN(input.businessId)) {
    throw new UnauthorizedError();
  }
  assertPositiveInteger(input.businessId, "businessId");

  if (!PAYMENT_AUDIT_EVENT_TYPE_SET.has(input.eventType)) {
    throw new ValidationError("Invalid payment audit eventType");
  }
  if (!PAYMENT_AUDIT_SOURCE_SET.has(input.source)) {
    throw new ValidationError("Invalid payment audit source");
  }

  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new ValidationError("Payment audit summary is required");
  }

  const paymentRequestId = input.paymentRequestId ?? null;
  if (paymentRequestId !== null) {
    assertPositiveInteger(paymentRequestId, "paymentRequestId");
  }

  const actorUserId = input.actorUserId ?? null;
  if (actorUserId !== null) {
    assertPositiveInteger(actorUserId, "actorUserId");
  }
  // A USER-sourced event must name the human actor. SYSTEM/PROVIDER events have
  // no human actor and must leave it null.
  if (input.source === "USER" && actorUserId === null) {
    throw new ValidationError("actorUserId is required for USER audit events");
  }

  const metadata = input.metadata ?? null;
  if (metadata !== null && typeof metadata !== "object") {
    throw new ValidationError("Payment audit metadata must be an object");
  }

  const occurredAt = input.occurredAt ?? new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ValidationError("occurredAt must be a valid date");
  }

  const base = {
    businessId: input.businessId,
    paymentRequestId,
    actorUserId,
    eventType: input.eventType,
    source: input.source,
    summary,
    metadata,
    occurredAt,
  };

  return { ...base, eventHash: hashPaymentAuditEvent(base) };
}

/** Validate without persisting — for tests and preflight checks. */
export function validatePaymentAuditEventInput(
  input: CreatePaymentAuditEventInput
): AppendPaymentAuditEventRow {
  return buildPaymentAuditRow(input);
}

/**
 * Best-effort append. Builds + validates + persists the event. Any failure
 * (validation or store) is swallowed and logged — recording an audit event must
 * NEVER break the payment it describes.
 */
export async function recordPaymentAuditEvent(
  store: Pick<PaymentStore, "appendAuditEvent">,
  input: CreatePaymentAuditEventInput
): Promise<void> {
  try {
    await store.appendAuditEvent(buildPaymentAuditRow(input));
  } catch (error) {
    console.error("recordPaymentAuditEvent error:", error);
  }
}

export interface GetPaymentAuditTimelineInput {
  businessId: number;
  paymentRequestId?: number;
  limit?: number;
}

/** Read an append-only timeline, oldest-first, for a business or one request. */
export async function getPaymentAuditTimeline(
  store: Pick<PaymentStore, "listAuditEvents">,
  input: GetPaymentAuditTimelineInput
): Promise<PaymentAuditEventRecord[]> {
  assertPositiveInteger(input.businessId, "businessId");
  if (input.paymentRequestId != null) {
    assertPositiveInteger(input.paymentRequestId, "paymentRequestId");
  }
  return store.listAuditEvents(input.businessId, {
    paymentRequestId: input.paymentRequestId,
    limit: input.limit,
  });
}
