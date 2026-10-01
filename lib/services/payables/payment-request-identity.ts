/**
 * The semantic identity of a payment request — what an idempotency key promises
 * to mean. Pure; no database.
 *
 * A key is a promise that a RETRY is the same economic event. Two requests that
 * share a key are the same event only if they agree on every field that decides
 * what money moved and what it settles:
 *
 *   commitmentId       which obligation the money is applied to
 *   amountMinor        how much moved (exact agorot)
 *   paidDate           the Israel business date the money left — the date Cash
 *                      Out is booked on. The clock time inside that day is not
 *                      part of the fact (a retry built from the same form may
 *                      carry a different instant for the same paid date).
 *   method             how it moved
 *   installmentIds     the occurrences the caller asked to settle (sorted, unique;
 *                      null = "due-date order", which is a different request
 *                      from any explicit list)
 *   externalReference  the bank / provider reference that identifies the transfer
 *
 * Deliberately NOT part of the identity: the note (a free-text annotation that
 * settles nothing), the actor (who pressed the button is not what moved), and
 * transport metadata (headers, timestamps of the request itself).
 *
 * The identity's fingerprint is stored on the PAYMENT_RECORDED audit event, so
 * a replay can be compared exactly. Payments recorded before fingerprints
 * existed are compared field by field from what was stored (`legacyMismatches`).
 */
import { createHash } from "node:crypto";
import { civilDayStart, toMinorUnits } from "@/lib/services/payables/payables-core";

export type PaymentRequestIdentity = {
  commitmentId: number;
  amountMinor: number;
  paidDate: string;
  method: string;
  installmentIds: number[] | null;
  externalReference: string | null;
};

export const PAYMENT_IDENTITY_FIELDS = [
  "commitmentId",
  "amountMinor",
  "paidDate",
  "method",
  "installmentIds",
  "externalReference",
] as const;
export type PaymentIdentityField = (typeof PAYMENT_IDENTITY_FIELDS)[number];

/** Version tag inside the fingerprint, so a future change of fields cannot collide. */
const IDENTITY_VERSION = "payment-request/v1";

/** The Israel business date of an instant, as YYYY-MM-DD. */
export function paidDateOf(paidAt: Date): string {
  return civilDayStart(paidAt).toISOString().slice(0, 10);
}

export function normalizeIdempotencyKey(key: string | null | undefined): string | null {
  return key?.trim() || null;
}

export function paymentRequestIdentity(input: {
  commitmentId: number;
  amount: string | number;
  paidAt: Date;
  method: string;
  installmentIds?: number[] | null;
  externalReference?: string | null;
}): PaymentRequestIdentity {
  const ids = input.installmentIds?.length ? [...new Set(input.installmentIds)].sort((a, b) => a - b) : null;
  return {
    commitmentId: input.commitmentId,
    amountMinor: toMinorUnits(input.amount),
    paidDate: paidDateOf(input.paidAt),
    method: input.method,
    installmentIds: ids,
    externalReference: input.externalReference?.trim() || null,
  };
}

/** Canonical JSON (fixed field order) → sha256 hex. */
export function paymentRequestFingerprint(identity: PaymentRequestIdentity): string {
  const canonical = JSON.stringify([IDENTITY_VERSION, ...PAYMENT_IDENTITY_FIELDS.map((f) => identity[f])]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Fields that differ between two identities (empty = the same request). */
export function identityMismatches(a: PaymentRequestIdentity, b: PaymentRequestIdentity): PaymentIdentityField[] {
  return PAYMENT_IDENTITY_FIELDS.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
}

/**
 * A payment recorded before fingerprints existed: compare against what was
 * stored. The requested installment set was never stored, only its result —
 * so the request matches on that field when every active allocation of the
 * recorded payment lies inside the requested set (a request naming a different
 * installment cannot have produced them).
 */
export function legacyMismatches(
  requested: PaymentRequestIdentity,
  recorded: {
    commitmentId: number | null;
    amountMinor: number;
    paidAt: Date;
    method: string;
    externalReference: string | null;
    activeAllocationInstallmentIds: number[];
  },
): PaymentIdentityField[] {
  const out: PaymentIdentityField[] = [];
  if (recorded.commitmentId !== requested.commitmentId) out.push("commitmentId");
  if (recorded.amountMinor !== requested.amountMinor) out.push("amountMinor");
  if (paidDateOf(recorded.paidAt) !== requested.paidDate) out.push("paidDate");
  if (recorded.method !== requested.method) out.push("method");
  if ((recorded.externalReference?.trim() || null) !== requested.externalReference) out.push("externalReference");
  if (
    requested.installmentIds &&
    recorded.activeAllocationInstallmentIds.some((id) => !requested.installmentIds!.includes(id))
  ) {
    out.push("installmentIds");
  }
  return out;
}

export function conflictMessage(fields: readonly string[]): string {
  return `This idempotency key was already used for a different payment request (differs in: ${fields.join(", ")}). Nothing was recorded.`;
}
