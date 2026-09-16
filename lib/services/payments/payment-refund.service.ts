/**
 * PAYMENT REVERSAL (M5) — the generic seam.
 *
 * Until now the payments domain could take money and could not give it back.
 * One adapter grew a working reversal mechanism against its provider's sandbox,
 * but nothing in the product could reach it: no capability on the adapter
 * interface, no service, no route. This module is the smallest correct way to
 * close that, and it is deliberately provider-agnostic — the word SUMIT does
 * not appear in it.
 *
 * THE SHAPE OF THE PROBLEM
 *
 * A refund is not a payment run backwards. A payment is something the provider
 * tells us happened and we verify; a refund is something WE instruct and then
 * find out about. That inverts the risk. The dangerous failure is not "the
 * refund did not happen" — it is "the refund happened twice", or "it happened
 * and we did not record it", because the second one is money that left the
 * merchant with nothing on our side to show for it.
 *
 * So the order of operations here is not the obvious one:
 *
 *   1. bound the amount against what is actually refundable,
 *   2. RESERVE that amount as a PENDING reversal row, before any money moves,
 *   3. re-check that the reservation we just wrote is the only one in flight,
 *   4. only then call the provider, outside any tenant transaction,
 *   5. resolve the row to what the provider established.
 *
 * Step 2 is what makes step 4 safe to retry against. A reservation that never
 * resolves keeps its amount committed, so a second attempt is refused rather
 * than doubling a reversal we cannot account for. Fail-closed here means
 * refusing a legitimate refund until a human looks — which is the right way
 * round, because the other failure spends real money.
 *
 * WHERE A REVERSAL LIVES
 *
 * In `PaymentTransaction`, as a row carrying a NEGATIVE amount. That is not a
 * trick to avoid a migration; it is what a settlement row already means — one
 * settled movement of money against one request, with the provider's own id for
 * it. A reversal is exactly that, in the other direction. It inherits the
 * table's tenant policy, its parent-join, and the unique on
 * `(provider, providerTransactionId)` that settlement idempotency already rests
 * on, rather than re-earning all three on a new table.
 *
 * The request's own status is deliberately NOT changed. `PaymentRequest.status`
 * records whether the ask was met, and it was: the money arrived. What happened
 * afterwards is a separate movement, and overwriting the first fact with the
 * second would lose it.
 */

import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordPaymentAuditEvent } from "./payment-audit.service";
import {
  assertPaymentProviderEnabled,
} from "./providers/provider-availability";
import type {
  PaymentProviderAdapter,
  RefundPaymentResult,
} from "./providers/payment-provider.types";
import type {
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentStore,
  PaymentTransactionRecord,
} from "./payments.types";

/**
 * Raised when the provider behind this payment cannot reverse anything.
 *
 * A 409 rather than a 500: nothing is broken, the answer is simply no, and the
 * caller can act on it. Both refund errors are AppErrors for that reason —
 * a refusal a person can read beats an opaque server error on a money path.
 */
export class PaymentRefundUnsupportedError extends ConflictError {
  readonly provider: string;

  constructor(provider: string) {
    super(
      "REFUND_NOT_SUPPORTED",
      `This payment provider cannot process refunds: ${provider}`
    );
    this.name = "PaymentRefundUnsupportedError";
    this.provider = provider;
  }
}

/** Raised when an earlier reversal on this payment never resolved. */
export class PaymentRefundInFlightError extends ConflictError {
  constructor() {
    super(
      "REFUND_IN_FLIGHT",
      "An earlier refund on this payment has not resolved yet. " +
        "It must be settled before another refund can be issued."
    );
    this.name = "PaymentRefundInFlightError";
  }
}

export interface RefundPaymentRequestInput {
  /** From the authenticated actor — never from request input. */
  businessId: number;
  actorUserId: number;
  requestId: number;
  /** Positive decimal string or number. Bounded below against the settlement. */
  amount: string | number;
  reason?: string | null;
}

export interface RefundPaymentRequestDeps {
  store: PaymentStore;
  resolveProvider: (provider: PaymentProvider) => PaymentProviderAdapter;
  decryptConnectionCredential: (
    connection: PaymentConnectionRecord
  ) => string | null;
}

export interface RefundPaymentRequestResult {
  refund: PaymentTransactionRecord;
  outcome: RefundPaymentResult["outcome"];
  /** Everything reversed so far, including this one when it settled. */
  refundedTotal: string;
  /** What remains reversible after this call. */
  refundableRemaining: string;
}

// --- money ----------------------------------------------------------------
//
// Amounts are decimal STRINGS everywhere in this domain, and they stay strings
// here. Parsing them into JS numbers to add them up would introduce binary
// floating point into the one place where a cent has to be a cent, so the
// arithmetic below is done in integer minor units and converted back.

const SCALE = 2;
const UNIT = 100; // 10 ** SCALE

/**
 * Minor units are plain integers, parsed out of the STRING rather than through
 * `Number(x) * 100`, which is where the rounding error would come from. Every
 * amount this domain can hold is far inside the exact-integer range, and the
 * bound is asserted rather than assumed.
 */
function toMinorUnits(value: string | number, field: string): number {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new ValidationError(`${field} must be a decimal amount`);
  }
  const negative = raw.startsWith("-");
  const digits = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = digits.split(".");
  if (fraction.length > SCALE) {
    throw new ValidationError(
      `${field} may not have more than ${SCALE} decimal places`
    );
  }
  const padded = (fraction + "0".repeat(SCALE)).slice(0, SCALE);
  const minor = Number(whole + padded);
  if (!Number.isSafeInteger(minor)) {
    throw new ValidationError(`${field} is out of range`);
  }
  return negative ? -minor : minor;
}

function fromMinorUnits(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / UNIT);
  const fraction = String(abs % UNIT).padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
}

// --- reading the settlement ledger ----------------------------------------

/** A reversal is a settled row with a negative amount. */
function isReversal(t: PaymentTransactionRecord): boolean {
  return toMinorUnits(t.amount, "amount") < 0;
}

/**
 * The settlement a refund reverses.
 *
 * The newest PAID row with a positive amount. "Newest" matters because a
 * request that was paid, reversed in full and paid again has two, and the live
 * one is the later. There is no case where a caller gets to choose.
 */
function findSettlement(
  transactions: PaymentTransactionRecord[]
): PaymentTransactionRecord | null {
  const settled = transactions.filter(
    (t) => t.status === "PAID" && !isReversal(t)
  );
  return settled.length > 0 ? settled[settled.length - 1]! : null;
}

/**
 * What has already been taken off that settlement.
 *
 * PENDING counts exactly as much as PAID does. A reversal we instructed and
 * cannot account for has, as far as the refundable balance is concerned,
 * already happened — assuming otherwise is how a double refund gets issued.
 * FAILED rows are definite refusals where no money moved, so they release.
 */
function reservedOrSettledReversals(
  transactions: PaymentTransactionRecord[]
): number {
  return transactions
    .filter((t) => isReversal(t) && (t.status === "PAID" || t.status === "PENDING"))
    .reduce((sum, t) => sum + -toMinorUnits(t.amount, "amount"), 0);
}

function unresolvedReversals(
  transactions: PaymentTransactionRecord[]
): PaymentTransactionRecord[] {
  return transactions.filter((t) => isReversal(t) && t.status === "PENDING");
}

/**
 * Reverse part or all of a settled payment.
 *
 * Business-scoped through the actor, never through input: a request belonging
 * to another business is reported as not-found, exactly as the ledger read
 * does, so a caller can never learn that another business's request id exists.
 */
export async function refundPaymentRequest(
  input: RefundPaymentRequestInput,
  deps: RefundPaymentRequestDeps
): Promise<RefundPaymentRequestResult> {
  assertPositiveInt(input.businessId, "businessId");
  assertPositiveInt(input.actorUserId, "actorUserId");
  assertPositiveInt(input.requestId, "requestId");

  const requested = toMinorUnits(input.amount, "amount");
  if (requested <= 0) {
    throw new ValidationError("A refund amount must be greater than zero");
  }

  // 1. OWNERSHIP. Missing and foreign are the same answer, deliberately.
  const request = await deps.store.findPaymentRequestById(input.requestId);
  if (!request || request.businessId !== input.businessId) {
    throw new NotFoundError("Payment request not found");
  }

  // 2. There must be something to reverse. An unpaid request has taken no
  //    money, so reversing it would move money that never arrived.
  if (request.status !== "PAID") {
    throw new ValidationError(
      "Only a settled payment can be refunded"
    );
  }

  // 3. The provider must still be an active capability. Refunding through a
  //    provider the platform has withdrawn is exactly the kind of live
  //    money-moving path the capability switch exists to close.
  assertPaymentProviderEnabled(request.provider);

  const adapter = deps.resolveProvider(request.provider);
  if (typeof adapter.refundPayment !== "function") {
    // Fail closed. No emulation, no partial credit note, no "mark it refunded
    // in our records and sort it out manually" — the domain refuses to imply a
    // reversal it cannot perform.
    throw new PaymentRefundUnsupportedError(request.provider);
  }

  // 4. Bound the amount against the ledger, not against the request. The
  //    request says what was asked for; the settlement says what arrived.
  const before = await deps.store.listTransactionsByRequest(request.id);

  const stuck = unresolvedReversals(before);
  if (stuck.length > 0) {
    throw new PaymentRefundInFlightError();
  }

  const settlement = findSettlement(before);
  if (!settlement) {
    throw new ValidationError(
      "This payment has no settled transaction to refund"
    );
  }

  const settledMinor = toMinorUnits(settlement.amount, "settlement amount");
  const alreadyMinor = reservedOrSettledReversals(before);
  const refundableMinor = settledMinor - alreadyMinor;

  if (refundableMinor <= 0) {
    throw new ValidationError("This payment has already been fully refunded");
  }
  if (requested > refundableMinor) {
    throw new ValidationError(
      `A refund of ${fromMinorUnits(requested)} exceeds the refundable ` +
        `balance of ${fromMinorUnits(refundableMinor)}`
    );
  }

  // 5. The connection is the ONLY source of credentials. Nothing in the input
  //    shape can carry one, and nothing here reads one from anywhere else.
  const connection = await deps.store.findActiveConnection(
    request.businessId,
    request.provider
  );
  if (!connection) {
    throw new ValidationError(
      "This business has no active connection for the payment's provider"
    );
  }
  const credential = deps.decryptConnectionCredential(connection);

  // 6. RESERVE. Written before the provider is called, so the amount is
  //    committed against the refundable balance even if everything after this
  //    line is lost.
  const reservation = await deps.store.createTransaction({
    paymentRequestId: request.id,
    provider: request.provider,
    // No provider id yet — there is nothing to name until the provider answers.
    providerTransactionId: null,
    amount: fromMinorUnits(-requested),
    currency: settlement.currency,
    status: "PENDING",
    rawPayload: {
      kind: "refund_reservation",
      requestedAmount: fromMinorUnits(requested),
      reversesTransactionId: settlement.id,
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
    },
  });

  await recordPaymentAuditEvent(deps.store, {
    businessId: request.businessId,
    paymentRequestId: request.id,
    actorUserId: input.actorUserId,
    eventType: "PAYMENT_REFUND_REQUESTED",
    source: "USER",
    summary:
      `Refund of ${fromMinorUnits(requested)} ${settlement.currency} ` +
      `requested against ${request.provider} payment ${request.id}`,
    metadata: {
      provider: request.provider,
      amount: fromMinorUnits(requested),
      currency: settlement.currency,
      reservationId: reservation.id,
    },
  });

  // 7. RE-CHECK after writing. Two callers can both pass step 4 before either
  //    reserves, so the check that decides between them has to happen once ours
  //    is on the record and both are visible.
  //
  //    THE TIE-BREAK IS THE OLDEST RESERVATION, and it has to be a tie-break
  //    rather than "refuse if anyone else is here": mutual refusal would mean
  //    two people clicking at once both fail, which is a worse answer than one
  //    of them succeeding. Reservation ids are monotonic, so "lowest id wins"
  //    is the same verdict from inside either caller, with no coordination.
  //
  //    A younger reservation therefore releases and refuses; the oldest one
  //    counts only itself and whatever had already resolved, because every
  //    reservation below it in age is about to release.
  const after = await deps.store.listTransactionsByRequest(request.id);
  const inFlight = unresolvedReversals(after);
  const oldest = inFlight.reduce<PaymentTransactionRecord | null>(
    (min, t) => (min === null || t.id < min.id ? t : min),
    null
  );
  const weLost = oldest !== null && oldest.id !== reservation.id;

  const committed = after
    .filter(
      (t) =>
        isReversal(t) &&
        (t.status === "PAID" || (t.status === "PENDING" && t.id <= reservation.id))
    )
    .reduce((sum, t) => sum + -toMinorUnits(t.amount, "amount"), 0);

  if (weLost || committed > settledMinor) {
    await deps.store.updateTransaction(reservation.id, { status: "FAILED" });
    await recordPaymentAuditEvent(deps.store, {
      businessId: request.businessId,
      paymentRequestId: request.id,
      actorUserId: input.actorUserId,
      eventType: "PAYMENT_REFUND_FAILED",
      source: "SYSTEM",
      summary:
        "Refund refused: another refund on this payment was already in flight",
      metadata: { provider: request.provider, reservationId: reservation.id },
    });
    throw new PaymentRefundInFlightError();
  }

  // 8. THE PROVIDER CALL. Outside every tenant transaction, deliberately: a
  //    remote call inside one holds a database transaction open for the length
  //    of somebody else's network, and W4E-A forbids it for that reason.
  let result: RefundPaymentResult;
  try {
    result = await adapter.refundPayment({
      merchantId: connection.merchantId,
      credential,
      amount: fromMinorUnits(requested),
      currency: settlement.currency,
      description: input.reason ?? request.description ?? null,
      paymentRequestId: request.id,
      settlement: {
        providerTransactionId: settlement.providerTransactionId,
        amount: settlement.amount,
        currency: settlement.currency,
        // What the provider itself sent us. The adapter reads its own fields
        // out of this; the domain never looks inside.
        rawPayload: settlement.rawPayload,
      },
    });
  } catch (error) {
    // A THROW IS A DEFINITE REFUSAL. The adapters in this domain raise rather
    // than return when the provider refused or could not be reached with the
    // instruction intact, so the reservation releases and the balance is
    // restored. An adapter that is unsure must return UNKNOWN instead — the
    // branch below — and not throw.
    await deps.store.updateTransaction(reservation.id, { status: "FAILED" });
    const message =
      error instanceof Error ? error.message : "provider refused the refund";
    await recordPaymentAuditEvent(deps.store, {
      businessId: request.businessId,
      paymentRequestId: request.id,
      actorUserId: input.actorUserId,
      eventType: "PAYMENT_REFUND_FAILED",
      source: "PROVIDER",
      summary: `Refund refused by ${request.provider}: ${message}`,
      metadata: { provider: request.provider, reservationId: reservation.id },
    });
    throw new ValidationError(`Refund failed: ${message}`);
  }

  if (result.outcome !== "REFUNDED") {
    // ACCEPTED BUT UNESTABLISHED. The money may or may not have moved, so the
    // row stays PENDING and keeps its amount committed. That blocks the next
    // refund on this payment, which is the point: the alternative is issuing a
    // second reversal for a first one we cannot see.
    await deps.store.updateTransaction(reservation.id, {
      providerTransactionId: result.providerRefundId,
      rawPayload: {
        kind: "refund_indeterminate",
        requestedAmount: fromMinorUnits(requested),
        providerRefundId: result.providerRefundId,
      },
    });
    await recordPaymentAuditEvent(deps.store, {
      businessId: request.businessId,
      paymentRequestId: request.id,
      actorUserId: input.actorUserId,
      eventType: "PAYMENT_REFUND_INDETERMINATE",
      source: "PROVIDER",
      summary:
        `${request.provider} did not establish the refund of ` +
        `${fromMinorUnits(requested)} ${settlement.currency}; it remains open`,
      metadata: {
        provider: request.provider,
        reservationId: reservation.id,
        providerRefundId: result.providerRefundId,
      },
    });

    const open = await deps.store.listTransactionsByRequest(request.id);
    const openTotal = reservedOrSettledReversals(open);
    return {
      refund: await refreshed(deps.store, request.id, reservation.id),
      outcome: "UNKNOWN",
      refundedTotal: fromMinorUnits(openTotal),
      refundableRemaining: fromMinorUnits(settledMinor - openTotal),
    };
  }

  // 9. SETTLED. The provider established it, so the row resolves and carries
  //    the provider's own id for the reversal — which is what the unique on
  //    (provider, providerTransactionId) then refuses to let anything record
  //    twice.
  const settled = await deps.store.updateTransaction(reservation.id, {
    status: "PAID",
    providerTransactionId: result.providerRefundId,
    rawPayload: {
      kind: "refund_settled",
      requestedAmount: fromMinorUnits(requested),
      providerRefundId: result.providerRefundId,
      reversesTransactionId: settlement.id,
    },
  });

  await recordPaymentAuditEvent(deps.store, {
    businessId: request.businessId,
    paymentRequestId: request.id,
    actorUserId: input.actorUserId,
    eventType: "PAYMENT_REFUND_SETTLED",
    source: "PROVIDER",
    summary:
      `${request.provider} refunded ${fromMinorUnits(requested)} ` +
      `${settlement.currency} against payment ${request.id}`,
    metadata: {
      provider: request.provider,
      amount: fromMinorUnits(requested),
      currency: settlement.currency,
      providerRefundId: result.providerRefundId,
      reservationId: reservation.id,
    },
  });

  const final = await deps.store.listTransactionsByRequest(request.id);
  const total = reservedOrSettledReversals(final);

  return {
    refund: settled,
    outcome: "REFUNDED",
    refundedTotal: fromMinorUnits(total),
    refundableRemaining: fromMinorUnits(settledMinor - total),
  };
}

async function refreshed(
  store: PaymentStore,
  paymentRequestId: number,
  transactionId: number
): Promise<PaymentTransactionRecord> {
  const rows = await store.listTransactionsByRequest(paymentRequestId);
  const found = rows.find((t) => t.id === transactionId);
  if (!found) throw new Error("The refund row disappeared after it was written");
  return found;
}

/**
 * What a caller may still reverse on one payment, read-only.
 *
 * Exposed so a surface can show the refundable balance without attempting a
 * refund to discover it, and so the same rules decide both.
 */
export async function getRefundableBalance(
  store: Pick<PaymentStore, "findPaymentRequestById" | "listTransactionsByRequest">,
  input: { businessId: number; requestId: number }
): Promise<{
  settledAmount: string;
  refundedTotal: string;
  refundableRemaining: string;
  currency: string;
  hasUnresolvedRefund: boolean;
}> {
  assertPositiveInt(input.businessId, "businessId");
  assertPositiveInt(input.requestId, "requestId");

  const request = await store.findPaymentRequestById(input.requestId);
  if (!request || request.businessId !== input.businessId) {
    throw new NotFoundError("Payment request not found");
  }

  const transactions = await store.listTransactionsByRequest(request.id);
  const settlement = findSettlement(transactions);
  const settledMinor = settlement
    ? toMinorUnits(settlement.amount, "settlement amount")
    : 0;
  const reversed = reservedOrSettledReversals(transactions);

  return {
    settledAmount: fromMinorUnits(settledMinor),
    refundedTotal: fromMinorUnits(reversed),
    refundableRemaining: fromMinorUnits(settledMinor - reversed),
    currency: settlement?.currency ?? request.currency,
    hasUnresolvedRefund: unresolvedReversals(transactions).length > 0,
  };
}
