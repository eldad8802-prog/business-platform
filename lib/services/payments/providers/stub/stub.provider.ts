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

// The stub presents itself as TRANZILA so it can stand in for the only
// registered provider in P1 without widening the PaymentProvider union.
const STUB_PROVIDER: PaymentProvider = "TRANZILA";

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
    provider: STUB_PROVIDER,

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

    verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
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
