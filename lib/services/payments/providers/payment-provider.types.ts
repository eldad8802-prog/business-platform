/**
 * Provider Adapter contract.
 *
 * Every external payment provider (Tranzila first) is wrapped behind this
 * interface. Services and routes call the adapter — never the provider SDK or
 * HTTP API directly. Adding a provider means implementing this interface and
 * registering it; nothing else in the domain changes.
 *
 * The adapter NEVER receives or returns card data. `createPaymentLink` returns
 * a hosted-checkout URL; the card is entered on the provider's page.
 */

import type { PaymentProvider } from "../payments.types";

export interface CreatePaymentLinkInput {
  businessId: number;
  paymentRequestId: number;
  amount: string;
  currency: string;
  description: string | null;
  /** Provider merchant/terminal identifier from the connection. */
  merchantId: string | null;
  /** Decrypted provider credential. Used in-memory only — never persisted. */
  credential: string | null;
  successUrl?: string;
  failureUrl?: string;
  expiresAt?: Date | null;
}

export interface CreatePaymentLinkResult {
  paymentUrl: string;
  /** Provider-side identifier we store as `PaymentRequest.providerRequestId`. */
  providerRequestId: string;
  expiresAt?: Date | null;
}

export interface VerifyWebhookInput {
  rawBody: string;
  headers: Record<string, string | null | undefined>;
  /** Shared secret / signing key, if the provider authenticates webhooks. */
  secret?: string | null;
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface ParseWebhookInput {
  rawBody: string;
  /** Optional pre-parsed body when the route already did JSON.parse. */
  parsedBody?: unknown;
}

export type ParsedPaymentOutcome =
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "PENDING"
  | "UNKNOWN";

export interface ParsedWebhookEvent {
  /** Stable provider event id for idempotency. Null if the provider has none. */
  providerEventId: string | null;
  eventType: string | null;
  /** Maps back to `PaymentRequest.providerRequestId`. */
  providerRequestId: string | null;
  providerTransactionId: string | null;
  outcome: ParsedPaymentOutcome;
  amount: string | null;
  currency: string | null;
  /**
   * Optional echo of a Dubiz-issued correlation value that the provider carried
   * through the payment round-trip (CardCom: `ReturnValue`, set to the
   * PaymentRequest id at LowProfile/Create time).
   *
   * When a provider supplies one, the orchestration asserts it equals the id of
   * the PaymentRequest that `providerRequestId` resolved to. It is a SECOND,
   * independent correlation channel: a caller must reproduce two values Dubiz
   * generated, not one. Null when the provider carries no such value.
   */
  correlationValue?: string | null;
}

export interface GetPaymentStatusInput {
  providerRequestId: string;
  merchantId: string | null;
  credential: string | null;
}

export interface ProviderPaymentStatus {
  outcome: ParsedPaymentOutcome;
  providerTransactionId: string | null;
}

export interface PaymentProviderAdapter {
  readonly provider: PaymentProvider;

  createPaymentLink(
    input: CreatePaymentLinkInput
  ): Promise<CreatePaymentLinkResult>;

  /** Authenticate an inbound webhook. Implementations must never throw. */
  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult;

  /** Parse an inbound webhook into a normalized event. Must never throw. */
  parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent;

  /** Optional active status poll (not used in P1 webhook flow). */
  getPaymentStatus?(
    input: GetPaymentStatusInput
  ): Promise<ProviderPaymentStatus>;
}

export class PaymentProviderError extends Error {
  readonly provider: PaymentProvider;
  readonly code: string;

  constructor(provider: PaymentProvider, code: string, message: string) {
    super(message);
    this.name = "PaymentProviderError";
    this.provider = provider;
    this.code = code;
  }
}
