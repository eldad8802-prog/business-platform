/**
 * Create-payment-link flow.
 *
 *   1. validate business + input
 *   2. find the active BusinessPaymentConnection
 *   3. create a PENDING PaymentRequest (persisted before calling the provider,
 *      so the request is never lost if the provider call fails)
 *   4. call provider.createPaymentLink
 *   5. save paymentUrl + providerRequestId
 *   6. return the PaymentRequest + paymentUrl
 *
 * Depends only on the `PaymentStore` port and an injected provider resolver +
 * credential decryptor, so it is fully unit-testable without a database or a
 * real provider.
 */

import { NotFoundError, ValidationError } from "@/lib/errors";
import type {
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentRequestRecord,
  PaymentStore,
} from "./payments.types";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";
import { recordPaymentAuditEvent } from "./payment-audit.service";
import { assertAmountPayableAgainstDocument } from "./payment-document-authority";
import { assertPaymentProviderEnabled } from "./providers/provider-availability";
import { isSupportedProvider } from "./providers/provider-registry";

export interface CreatePaymentRequestInput {
  businessId: number;
  amount: string | number;
  currency?: string;
  description?: string | null;
  customerId?: number | null;
  billingDocumentId?: number | null;
  expiresAt?: Date | null;
  /** Provider to use; defaults to the active connection's provider. */
  provider?: PaymentProvider;
  successUrl?: string;
  failureUrl?: string;
  /** Authenticated user who created the charge (for the audit trail). */
  actorUserId?: number | null;
}

export interface CreatePaymentRequestDeps {
  store: PaymentStore;
  resolveProvider: (provider: PaymentProvider) => PaymentProviderAdapter;
  /** Returns the decrypted merchant credential, or null on failure. */
  decryptConnectionCredential: (
    connection: PaymentConnectionRecord
  ) => string | null;
  now?: () => Date;
}

export interface CreatePaymentRequestResult {
  paymentRequest: PaymentRequestRecord;
  paymentUrl: string;
}

const DEFAULT_CURRENCY = "ILS";

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
}

/** Normalize an amount to a positive, 2-decimal string. */
export function normalizePaymentAmount(amount: string | number): string {
  const num = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    throw new ValidationError("amount must be a positive number");
  }
  // Round to 2 decimals defensively; provider currencies here are 2-decimal.
  return (Math.round(num * 100) / 100).toFixed(2);
}

function normalizeCurrency(currency: string | undefined): string {
  const value = (currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new ValidationError("currency must be a 3-letter ISO code");
  }
  return value;
}

/**
 * Raised when a business has several active providers and the caller named
 * none. Carries the candidates so the caller can present a choice instead of
 * a dead end — this is the ONLY ambiguity in provider selection, and the system
 * refuses to resolve it silently.
 */
export class AmbiguousPaymentProviderError extends ValidationError {
  readonly candidates: readonly PaymentProvider[];

  constructor(candidates: readonly PaymentProvider[]) {
    super(
      `This business has more than one active payment provider (${candidates.join(", ")}). Specify which one to use.`
    );
    this.name = "AmbiguousPaymentProviderError";
    // A stable machine-readable code, so a client can react by asking the user
    // to choose rather than by parsing prose. `handleError` already emits
    // `code` for any AppError.
    this.code = "PAYMENT_PROVIDER_REQUIRED";
    this.candidates = candidates;
  }
}

/**
 * SEC-05 — refuse a currency the adapter cannot encode.
 *
 * `supportedCurrencies === null` means the adapter forwards the ISO code
 * unchanged and translates nothing, so it has no table to fall out of and the
 * provider itself is the authority on acceptance. A concrete list is exhaustive
 * by construction, and anything outside it is refused rather than substituted.
 */
export function assertCurrencySupported(
  adapter: Pick<PaymentProviderAdapter, "provider" | "supportedCurrencies">,
  currency: string
): void {
  const supported = adapter.supportedCurrencies;
  if (supported === null) return;
  if (!supported.includes(currency)) {
    throw new ValidationError(
      `${adapter.provider} cannot be charged in ${currency}. Supported: ${supported.join(", ")}.`
    );
  }
}

export interface SelectPaymentProviderInput {
  businessId: number;
  /** The provider the caller asked for, or null when they named none. */
  requested: PaymentProvider | null;
}

/**
 * Choose the provider a payment request will use.
 *
 * Three modes, and the third is the whole point of this function:
 *
 *   A. the caller named a provider — it must be a REGISTERED provider, an
 *      ENABLED capability, and one this business has an ACTIVE connection to.
 *      All three are checked; none is inferred from the others.
 *   B. no provider named, exactly one active connection — use it. This is the
 *      behaviour every existing caller relies on and it is preserved exactly.
 *   C. no provider named, several active connections — REFUSE, and say which
 *      ones are available.
 *
 * Mode C previously made a business with two connections unable to create any
 * payment request at all. It still refuses, because picking one of a merchant's
 * acquirers on their behalf is not a decision this layer may make, but it now
 * refuses with the candidates attached so a caller can offer the choice. There
 * is deliberately NO default-provider column: introducing a new stored
 * preference to resolve an ambiguity the UI can resolve directly would add a
 * source of truth before anything needs one.
 */
export async function selectPaymentProvider(
  input: SelectPaymentProviderInput,
  store: Pick<PaymentStore, "listConnections">
): Promise<PaymentProvider> {
  const active = (await store.listConnections(input.businessId)).filter(
    (c) => c.isActive
  );

  if (input.requested) {
    if (!isSupportedProvider(input.requested)) {
      throw new ValidationError(
        `Unknown payment provider: ${String(input.requested)}`
      );
    }
    // A disabled provider must be refused even when a connection survives from
    // before it was switched off — otherwise a business could still be sent to
    // a checkout whose callback the system now returns 404 to, taking a real
    // payment that could never be confirmed.
    assertPaymentProviderEnabled(input.requested);
    if (!active.some((c) => c.provider === input.requested)) {
      throw new ValidationError(
        `No active ${input.requested} connection for this business. Connect it first.`
      );
    }
    return input.requested;
  }

  if (active.length === 0) {
    throw new ValidationError(
      "No active payment connection for this business. Connect a payment provider first."
    );
  }
  if (active.length === 1) {
    const only = active[0]!.provider;
    assertPaymentProviderEnabled(only);
    return only;
  }
  throw new AmbiguousPaymentProviderError(active.map((c) => c.provider));
}

export async function createPaymentRequest(
  input: CreatePaymentRequestInput,
  deps: CreatePaymentRequestDeps
): Promise<CreatePaymentRequestResult> {
  assertPositiveInt(input.businessId, "businessId");
  if (input.customerId != null) assertPositiveInt(input.customerId, "customerId");
  if (input.billingDocumentId != null) {
    assertPositiveInt(input.billingDocumentId, "billingDocumentId");
  }

  const amount = normalizePaymentAmount(input.amount);
  const currency = normalizeCurrency(input.currency);
  const now = deps.now ?? (() => new Date());

  // 2. PROVIDER SELECTION — deterministic, never arbitrary. See
  // `selectPaymentProvider` for the three modes and why the ambiguous one
  // refuses instead of guessing.
  const provider = await selectPaymentProvider(
    { businessId: input.businessId, requested: input.provider ?? null },
    deps.store
  );

  const connection = await deps.store.findActiveConnection(
    input.businessId,
    provider
  );
  if (!connection || !connection.isActive) {
    throw new ValidationError(
      `No active ${provider} connection for this business. Connect it first.`
    );
  }

  // 2b. SEC-02 — TENANT OWNERSHIP of every reference the caller supplied.
  //
  // Both ids arrive in the request body. A foreign key alone does not make them
  // safe: PostgreSQL evaluates referential integrity with row security
  // bypassed, so the constraint would accept another tenant's row without
  // complaint. They are therefore resolved server-side, scoped to the acting
  // business, and a miss is refused. The lookups return null for "missing" and
  // "someone else's" alike, so nothing here reveals another tenant's records.
  let payableDocument = null;
  if (input.billingDocumentId != null) {
    payableDocument = await deps.store.findPayableDocument(
      input.businessId,
      input.billingDocumentId
    );
    if (!payableDocument) {
      throw new NotFoundError("Billing document not found");
    }
  }
  if (input.customerId != null) {
    const customer = await deps.store.findCustomerRef(
      input.businessId,
      input.customerId
    );
    if (!customer) {
      throw new NotFoundError("Customer not found");
    }
  }

  // 2c. SEC-01 — AMOUNT AUTHORITY. Once a request names a document, the server
  // decides what may be collected against it; the client's number is a proposal
  // that has to fit inside the document's own outstanding balance. This
  // VALIDATES only — no allocation is written, no invoice is settled, no debt
  // is closed.
  if (payableDocument) {
    assertAmountPayableAgainstDocument(payableDocument, { amount, currency });
  }

  // 2d. SEC-05 — CURRENCY AUTHORITY. An adapter that translates ISO codes from
  // a fixed table can only express what that table holds; anything else used to
  // be coerced to the table's first entry, charging one currency while every
  // record claimed another. Refused here, before a PaymentRequest row exists,
  // so an unsupported currency leaves no trace and reaches no provider.
  const adapter = deps.resolveProvider(provider);
  assertCurrencySupported(adapter, currency);

  // 3. persist PENDING first.
  const created = await deps.store.createPaymentRequest({
    businessId: input.businessId,
    customerId: input.customerId ?? null,
    billingDocumentId: input.billingDocumentId ?? null,
    provider,
    amount,
    currency,
    description: input.description ?? null,
    status: "PENDING",
    expiresAt: input.expiresAt ?? null,
  });

  // audit the charge creation (best-effort; never blocks the flow).
  await recordPaymentAuditEvent(deps.store, {
    businessId: input.businessId,
    paymentRequestId: created.id,
    actorUserId: input.actorUserId ?? null,
    eventType: "PAYMENT_REQUEST_CREATED",
    source: input.actorUserId != null ? "USER" : "SYSTEM",
    summary: `Payment request ${created.id} created for ${amount} ${currency} via ${provider}`,
    metadata: {
      provider,
      amount,
      currency,
      customerId: input.customerId ?? null,
      billingDocumentId: input.billingDocumentId ?? null,
    },
    occurredAt: now(),
  });

  // 4. ask the provider for a hosted-checkout link.
  const credential = deps.decryptConnectionCredential(connection);

  let linkResult;
  try {
    linkResult = await adapter.createPaymentLink({
      businessId: input.businessId,
      paymentRequestId: created.id,
      amount,
      currency,
      description: input.description ?? null,
      merchantId: connection.merchantId,
      credential,
      successUrl: input.successUrl,
      failureUrl: input.failureUrl,
      expiresAt: input.expiresAt ?? null,
    });
  } catch (error) {
    // Provider failed — mark the request FAILED so it is not left dangling,
    // then surface a clean error.
    await deps.store.updatePaymentRequest(created.id, {
      status: "FAILED",
    });
    const message =
      error instanceof Error ? error.message : "payment provider error";
    throw new ValidationError(`Failed to create payment link: ${message}`);
  }

  // 5. save link + provider id.
  const paymentRequest = await deps.store.updatePaymentRequest(created.id, {
    paymentUrl: linkResult.paymentUrl,
    providerRequestId: linkResult.providerRequestId,
    expiresAt: linkResult.expiresAt ?? input.expiresAt ?? null,
  });

  // 5b. D2/P7-W4E — record the provider->tenant routing entry. This is what
  // later lets a session-less provider callback discover which business an
  // event belongs to: PaymentRequest is FORCE-RLS'd, so without this the
  // callback's pre-context lookup returns nothing and the webhook is
  // fail-closed. Written HERE, inside the owner-authenticated flow, so the
  // tenant on the routing row is server-derived and never payload-supplied.
  if (linkResult.providerRequestId) {
    await deps.store.upsertProviderRouting({
      provider,
      providerRequestId: linkResult.providerRequestId,
      paymentRequestId: created.id,
      businessId: input.businessId,
    });
  }

  void now; // reserved for future expiry defaults

  // 6. return.
  return { paymentRequest, paymentUrl: linkResult.paymentUrl };
}
