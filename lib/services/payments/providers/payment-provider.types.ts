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
  /**
   * A high-entropy, single-use secret minted by the orchestration for THIS
   * request, for providers whose callback carries no signature.
   *
   * Such a provider proves authenticity by possessing a URL only it was given.
   * The adapter's job is to embed this value in whatever callback URL it
   * registers; the orchestration stores only its hash and resolves the tenant
   * from it later. Adapters that authenticate callbacks by signature ignore it.
   *
   * Never logged, never returned to a browser, never persisted in the clear.
   */
  callbackSecret?: string | null;
}

export interface CreatePaymentLinkResult {
  paymentUrl: string;
  /**
   * Provider-side identifier we store as `PaymentRequest.providerRequestId`.
   *
   * OPTIONAL, because not every provider issues one. CardCom returns a
   * LowProfileId and PayPlus a page_request_uid, but SUMIT's hosted checkout
   * returns a payment page URL and nothing else — its published response object
   * declares `additionalProperties: false` around a single `RedirectURL`, and a
   * live sandbox run confirmed it.
   *
   * An adapter with no id MUST omit it rather than synthesise one. A fabricated
   * value would make the field's name untrue and would poison the routing index
   * that callbacks resolve against, which is keyed on it. A provider that omits
   * it correlates some other way — see `callbackSecret` above.
   */
  providerRequestId?: string | null;
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
  /**
   * The PROVIDER's identifier for the payment session, as the provider issued
   * it. Null for a provider that issues none, which is exactly the case this
   * whole capability exists for. Never a Dubiz id: putting our own id in a field
   * named for the provider's would make the name untrue.
   */
  providerRequestId: string | null;
  merchantId: string | null;
  credential: string | null;
  /**
   * The Dubiz-issued value that round-trips through the provider, present when
   * the provider carries one through the payment.
   *
   * For a provider with no session id this is the ONLY way to ask the
   * authoritative question at all: SUMIT's clearing record is searchable by the
   * external identifier we set at checkout and by nothing else we control.
   * Adapters that do not need it ignore it.
   */
  correlationValue?: string | null;
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

  /**
   * Declares that this provider's callbacks are authenticated by POSSESSION of
   * a URL rather than by a signature on the message.
   *
   * When true the orchestration mints a fresh high-entropy secret for every
   * checkout, hands it to `createPaymentLink`, and stores only its hash as the
   * route from a later callback back to this request. When absent or false
   * nothing is minted and nothing is stored, so existing signature-based
   * providers are untouched.
   *
   * A provider should declare this only if it genuinely publishes no signature.
   * Preferring a URL secret over a signature the provider does offer would be a
   * downgrade.
   */
  readonly usesCallbackSecret?: boolean;

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

  /**
   * Reverse part or all of a settled payment.
   *
   * OPTIONAL, and absence is meaningful: a provider that cannot reverse a
   * payment must not declare this, and the domain then refuses the refund
   * rather than pretending. There is no default implementation to inherit,
   * because "reverse money" has no safe default.
   *
   * The adapter receives the settlement Dubiz already holds, never a client's
   * idea of it, and never a credential from a request body. Everything a
   * provider needs beyond the amount — a stored customer id, a transaction
   * reference — it reads out of `settlement`, which keeps provider-shaped
   * knowledge inside the provider's own adapter.
   *
   * Implementations must not report success they have not established. An
   * accepted-but-unconfirmed reversal is `UNKNOWN`, which the domain treats as
   * still in flight, never as done and never as failed.
   */
  refundPayment?(input: RefundPaymentInput): Promise<RefundPaymentResult>;
}

/**
 * The settled payment a refund reverses, exactly as Dubiz persisted it.
 *
 * This is the authority a refund is computed against. It comes from the store,
 * never from the caller, so a client cannot nominate which settlement it is
 * reversing or how large that settlement was.
 */
export interface SettlementRef {
  /** The provider's own id for the settlement, when it issued one. */
  providerTransactionId: string | null;
  amount: string;
  currency: string;
  /**
   * The provider body Dubiz stored with the settlement.
   *
   * Opaque to the domain and meaningful only to the adapter that wrote it. It
   * is how a provider recovers its own identifiers — SUMIT's customer id, for
   * one — without the domain having to learn any provider's field names.
   */
  rawPayload: unknown;
}

export interface RefundPaymentInput {
  merchantId: string | null;
  credential: string | null;
  /** Positive decimal string. The domain has already bounded it. */
  amount: string;
  currency: string;
  description?: string | null;
  /** Dubiz's own request id, for providers that correlate on it. */
  paymentRequestId: number;
  settlement: SettlementRef;
}

/**
 * REFUNDED means the provider established the reversal. UNKNOWN means it did
 * not — the request may have reached the provider and may yet settle, so the
 * amount stays reserved and no further refund is allowed until a human
 * resolves it. There is deliberately no FAILED: a definite refusal is an
 * exception, not a result, so it can never be mistaken for an outcome.
 */
export interface RefundPaymentResult {
  providerRefundId: string | null;
  outcome: "REFUNDED" | "UNKNOWN";
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
