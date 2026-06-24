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

import { ValidationError } from "@/lib/errors";
import type {
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentRequestRecord,
  PaymentStore,
} from "./payments.types";
import type { PaymentProviderAdapter } from "./providers/payment-provider.types";

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

const DEFAULT_PROVIDER: PaymentProvider = "TRANZILA";
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
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const now = deps.now ?? (() => new Date());

  // 2. active connection — fail nicely if the business has not connected.
  const connection = await deps.store.findActiveConnection(
    input.businessId,
    provider
  );
  if (!connection || !connection.isActive) {
    throw new ValidationError(
      "No active payment connection for this business. Connect a payment provider first."
    );
  }

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

  // 4. ask the provider for a hosted-checkout link.
  const adapter = deps.resolveProvider(provider);
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

  void now; // reserved for future expiry defaults

  // 6. return.
  return { paymentRequest, paymentUrl: linkResult.paymentUrl };
}
