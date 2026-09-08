/**
 * Stub payment provider — used by tests and local development.
 *
 * Never makes network calls. Produces a deterministic fake payment URL and
 * provider id, and parses the simple JSON webhook shape the tests emit. This
 * is what lets the payments services run end-to-end without ever touching a
 * real provider.
 */

import type { PaymentProvider } from "../../payments.types";
import type {
  CreatePaymentLinkInput,
  CreatePaymentLinkResult,
  ParsedPaymentOutcome,
  ParsedWebhookEvent,
  ParseWebhookInput,
  PaymentProviderAdapter,
  ProviderPaymentStatus,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from "../payment-provider.types";

/**
 * The provider this stub presents itself as.
 *
 * It used to be TRANZILA — the only registered provider in P1. Tranzila is now
 * a DISABLED capability, and `createPaymentRequest` refuses disabled providers,
 * so a stub wearing that label would make every test that stands it in for "a
 * working provider" exercise a refusal path instead. It presents as CardCom,
 * the live provider, and callers that genuinely need another label pass one.
 */
const DEFAULT_STUB_PROVIDER: PaymentProvider = "CARDCOM";

export interface StubProviderOptions {
  /** When set, verifyWebhook requires this exact secret. */
  requiredSecret?: string;
  /**
   * When set, the stub is verification-capable: getPaymentStatus returns this
   * authoritative outcome, mirroring a provider whose own verification API is
   * the source of truth. When omitted, the stub has NO getPaymentStatus and is
   * signal-only — a webhook can never settle it to PAID (Authority Principle).
   */
  verifiedStatus?: ProviderPaymentStatus;
  /**
   * Currencies the stub claims it can encode. Defaults to ILS + USD, mirroring
   * a real adapter that TRANSLATES, so tests can drive the unsupported-currency
   * refusal without a real provider. `null` models a pass-through adapter.
   */
  supportedCurrencies?: readonly string[] | null;
  /**
   * When set, verifyWebhook resolves only after this promise settles. Models a
   * provider whose callback authentication needs an API round-trip — the case
   * the async contract exists for.
   */
  verifyGate?: Promise<unknown>;
  /** When set, verifyWebhook REJECTS with this error instead of returning. */
  verifyThrows?: Error;
  /** The provider label the stub presents as. Defaults to CardCom. */
  provider?: PaymentProvider;
}

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set([
  "PAID",
  "FAILED",
  "CANCELLED",
  "PENDING",
]);

function coerceOutcome(value: unknown): ParsedPaymentOutcome {
  if (typeof value === "string" && KNOWN_OUTCOMES.has(value)) {
    return value as ParsedPaymentOutcome;
  }
  return "UNKNOWN";
}

export function createStubProvider(
  options: StubProviderOptions = {}
): PaymentProviderAdapter {
  const adapter: PaymentProviderAdapter = {
    provider: options.provider ?? DEFAULT_STUB_PROVIDER,
    supportedCurrencies:
      options.supportedCurrencies === undefined
        ? ["ILS", "USD"]
        : options.supportedCurrencies,

    async createPaymentLink(
      input: CreatePaymentLinkInput
    ): Promise<CreatePaymentLinkResult> {
      const providerRequestId = `stub-req-${input.businessId}-${input.paymentRequestId}`;
      return {
        paymentUrl: `https://stub.local/checkout/${providerRequestId}`,
        providerRequestId,
        expiresAt: input.expiresAt ?? null,
      };
    },

    async verifyWebhook(
      input: VerifyWebhookInput
    ): Promise<VerifyWebhookResult> {
      if (options.verifyGate) await options.verifyGate;
      if (options.verifyThrows) throw options.verifyThrows;
      if (options.requiredSecret) {
        const provided =
          input.headers["x-webhook-secret"] ?? input.secret ?? null;
        return provided === options.requiredSecret
          ? { ok: true }
          : { ok: false, reason: "invalid_secret" };
      }
      return { ok: true };
    },

    parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent {
      let body: Record<string, unknown> = {};
      if (input.parsedBody && typeof input.parsedBody === "object") {
        body = input.parsedBody as Record<string, unknown>;
      } else {
        try {
          const parsed = JSON.parse(input.rawBody) as unknown;
          if (parsed && typeof parsed === "object") {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          body = {};
        }
      }

      const asString = (v: unknown): string | null =>
        v == null ? null : String(v);

      return {
        providerEventId: asString(body.eventId),
        eventType: asString(body.eventType),
        providerRequestId: asString(body.providerRequestId),
        providerTransactionId: asString(body.providerTransactionId),
        outcome: coerceOutcome(body.outcome),
        amount: asString(body.amount),
        currency: asString(body.currency),
      };
    },
  };

  // When a verified status is configured the stub becomes verification-capable,
  // mirroring a provider whose own verification API is the source of truth.
  // Without it the stub has no getPaymentStatus and is signal-only: a webhook
  // can never settle it to PAID (Authority Principle).
  if (options.verifiedStatus) {
    const verifiedStatus = options.verifiedStatus;
    adapter.getPaymentStatus = async () => verifiedStatus;
  }

  return adapter;
}
