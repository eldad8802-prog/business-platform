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

  /**
   * Currencies this adapter can ENCODE for its provider.
   *
   * A concrete list means the adapter translates the ISO code into a
   * provider-specific value from a fixed table it carries. A code outside that
   * table cannot be expressed at all, so it must be refused BEFORE the provider
   * is called — never coerced to a neighbouring currency, which would charge a
   * cardholder in one currency while every record we keep claims another.
   *
   * `null` means the adapter forwards the ISO code unchanged and translates
   * nothing, so there is no code it could silently mis-encode; the provider
   * itself is then the authority on what it accepts and what it rejects.
   */
  readonly supportedCurrencies: readonly string[] | null;

  createPaymentLink(
    input: CreatePaymentLinkInput
  ): Promise<CreatePaymentLinkResult>;

  /**
   * Authenticate an inbound webhook.
   *
   * ASYNC BY CONTRACT. Most providers can be authenticated from the body and
   * headers alone, but a provider that verifies a callback through its own API
   * (PayPal's verify-webhook-signature, for example) needs I/O to answer, and a
   * synchronous signature made that impossible to express. An adapter needing
   * no I/O simply declares the method `async` and returns immediately.
   *
   * Implementations should not throw; a caller must nonetheless treat a
   * rejected promise as a verification FAILURE, never as a pass.
   */
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;

  /** Parse an inbound webhook into a normalized event. Must never throw. */
  parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent;

  /**
   * Provider-authoritative status query.
   *
   * Optional in the TYPE, mandatory in PRACTICE for any provider offered as an
   * active capability: the Authority Principle lets a request reach PAID only
   * from an outcome this call establishes, so an adapter without it can never
   * settle anything. `provider-availability.ts` carries that invariant, and
   * `provider-authority.test.ts` locks it — see the note there for why it is
   * enforced at the capability boundary rather than by making this required.
   */
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
