/**
 * Tranzila provider adapter.
 *
 * Implements `PaymentProviderAdapter` over Tranzila's hosted checkout page.
 * The cardholder enters card details on Tranzila's page — Dubiz never sees or
 * stores them. We only build the hosted-page URL and interpret the inbound
 * notification.
 *
 * ⚠️ DOCS-CONFIRM: the exact hosted-page parameter names, the notification
 * field names, and the notification authentication scheme MUST be confirmed
 * against current Tranzila integration docs before enabling against a live
 * terminal. The mappings below follow Tranzila's classic hosted-page model
 * (sum / currency / echoed custom fields, Response="000" => success) and are
 * isolated here so confirming them touches only this file. Nothing here makes
 * live HTTP calls yet (link creation is URL construction; status polling is
 * intentionally left unimplemented for P1).
 */

import type { PaymentProvider } from "../../payments.types";
import type {
  CreatePaymentLinkInput,
  CreatePaymentLinkResult,
  ParsedPaymentOutcome,
  ParsedWebhookEvent,
  ParseWebhookInput,
  PaymentProviderAdapter,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from "../payment-provider.types";

const TRANZILA_PROVIDER: PaymentProvider = "TRANZILA";

/** ILS currency code on Tranzila's hosted page (1 = ILS). */
const TRANZILA_CURRENCY_CODE: Record<string, string> = {
  ILS: "1",
  USD: "2",
  EUR: "978",
};

/** Custom field we attach to the hosted page so the notification echoes it. */
const REQUEST_ID_FIELD = "dubiz_request_id";

function tranzilaBaseUrl(merchantId: string): string {
  // DOCS-CONFIRM: classic hosted page lives at direct.tranzila.com/<terminal>/
  return `https://direct.tranzila.com/${encodeURIComponent(merchantId)}/`;
}

function stableProviderRequestId(input: CreatePaymentLinkInput): string {
  // Our own correlation id, echoed back via the custom field. Deterministic
  // from the payment request so retries map to the same id.
  return `dubiz-${input.businessId}-${input.paymentRequestId}`;
}

/**
 * Flatten a webhook body into a string map, accepting either JSON or
 * application/x-www-form-urlencoded. Never throws.
 */
function flattenWebhookBody(input: ParseWebhookInput): Record<string, string> {
  const out: Record<string, string> = {};

  const fromObject = (obj: unknown): void => {
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v == null) continue;
        out[k.toLowerCase()] = String(v);
      }
    }
  };

  if (input.parsedBody !== undefined) {
    fromObject(input.parsedBody);
    return out;
  }

  const raw = input.rawBody ?? "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      fromObject(JSON.parse(trimmed));
      return out;
    } catch {
      // fall through to urlencoded
    }
  }

  try {
    const params = new URLSearchParams(raw);
    for (const [k, v] of params.entries()) {
      out[k.toLowerCase()] = v;
    }
  } catch {
    // leave out empty — caller treats as UNKNOWN
  }
  return out;
}

function mapResponseToOutcome(fields: Record<string, string>): ParsedPaymentOutcome {
  // DOCS-CONFIRM: Tranzila returns Response="000" on success.
  const response = fields["response"] ?? fields["responsecode"] ?? null;
  const status = fields["status"] ?? null;

  if (status === "cancelled" || status === "canceled") return "CANCELLED";
  if (response === "000") return "PAID";
  if (response != null && response !== "") return "FAILED";
  if (status === "paid" || status === "success") return "PAID";
  if (status === "failed" || status === "error") return "FAILED";
  return "UNKNOWN";
}

export const tranzilaProvider: PaymentProviderAdapter = {
  provider: TRANZILA_PROVIDER,

  async createPaymentLink(
    input: CreatePaymentLinkInput
  ): Promise<CreatePaymentLinkResult> {
    if (!input.merchantId) {
      throw new Error("tranzila.createPaymentLink: merchantId is required");
    }

    const providerRequestId = stableProviderRequestId(input);
    const currencyCode = TRANZILA_CURRENCY_CODE[input.currency] ?? "1";

    const params = new URLSearchParams();
    // DOCS-CONFIRM: hosted-page field names (sum / currency / custom fields).
    params.set("sum", input.amount);
    params.set("currency", currencyCode);
    if (input.description) params.set("pdesc", input.description);
    params.set(REQUEST_ID_FIELD, providerRequestId);
    if (input.successUrl) params.set("success_url_address", input.successUrl);
    if (input.failureUrl) params.set("fail_url_address", input.failureUrl);

    const paymentUrl = `${tranzilaBaseUrl(input.merchantId)}?${params.toString()}`;

    return {
      paymentUrl,
      providerRequestId,
      expiresAt: input.expiresAt ?? null,
    };
  },

  verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
    // DOCS-CONFIRM: Tranzila notification authentication. When a shared secret
    // is configured we require it to match a header/field; when none is
    // configured we accept (foundation stage) and rely on matching + the fact
    // that no funds move through Dubiz. Harden before production.
    const secret = input.secret;
    if (!secret) {
      return { ok: true };
    }

    const headerToken =
      input.headers["x-tranzila-secret"] ??
      input.headers["x-webhook-secret"] ??
      null;
    if (headerToken && headerToken === secret) {
      return { ok: true };
    }

    // Also allow the secret as a body field (urlencoded notifications).
    const fields = flattenWebhookBody({ rawBody: input.rawBody });
    if (fields["secret"] && fields["secret"] === secret) {
      return { ok: true };
    }

    return { ok: false, reason: "invalid_or_missing_secret" };
  },

  parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent {
    const fields = flattenWebhookBody(input);

    const providerRequestId =
      fields[REQUEST_ID_FIELD.toLowerCase()] ??
      fields["dubiz_request_id"] ??
      null;

    // DOCS-CONFIRM: transaction identifier field (index / TransactionID /
    // ConfirmationCode). We try the common ones.
    const providerTransactionId =
      fields["transaction_id"] ??
      fields["transactionid"] ??
      fields["index"] ??
      fields["confirmationcode"] ??
      null;

    const providerEventId =
      fields["event_id"] ??
      fields["notify_id"] ??
      providerTransactionId ??
      null;

    const outcome = mapResponseToOutcome(fields);

    return {
      providerEventId,
      eventType: fields["event_type"] ?? fields["type"] ?? null,
      providerRequestId,
      providerTransactionId,
      outcome,
      amount: fields["sum"] ?? fields["amount"] ?? null,
      currency: fields["currency"] ?? null,
    };
  },
};
