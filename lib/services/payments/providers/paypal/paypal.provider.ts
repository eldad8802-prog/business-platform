/**
 * PayPal provider — implements `PaymentProviderAdapter` over PayPal's Orders v2
 * API (sandbox-first), for end-to-end testing of the Collection Workspace on
 * real provider data before CardCom production is available.
 *
 *   - createPaymentLink  → OAuth token → POST /v2/checkout/orders (intent CAPTURE)
 *                          → hosted approve URL + order id (providerRequestId)
 *   - getPaymentStatus   → the AUTHORITY: GET /v2/checkout/orders/{id}; if the
 *                          buyer APPROVED, capture it; PAID only when the order is
 *                          COMPLETED with a COMPLETED capture.
 *   - verifyWebhook      → accept the signal (foundation). The webhook is only a
 *                          signal; a forged webhook can NEVER make a request PAID
 *                          because getPaymentStatus independently re-reads the
 *                          truth from PayPal. Signature verification via the
 *                          verify-webhook-signature API + PAYPAL_WEBHOOK_ID is a
 *                          future hardening (it is async; the sync contract here
 *                          accepts-as-signal and relies on the authority re-check).
 *   - parseWebhook       → signal only; extracts the order id; never throws.
 *
 * Credentials come from ENV (sandbox): PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET,
 * PAYPAL_ENV (sandbox|live → base URL), PAYPAL_WEBHOOK_ID; PAYMENTS_PUBLIC_BASE_URL
 * for the return/webhook URLs. The per-business connection is used only as an
 * activation flag (its stored credential is ignored here).
 *
 * Card data: Dubiz never handles it — the buyer pays on PayPal's hosted page.
 *
 * NOTE — bit (ביט): bit is NOT implemented here and is out of scope for this
 * provider. bit is an Israeli payment method that requires integration through
 * an Israeli acquirer / payment provider (e.g. Grow / PayMe / Upay / CardCom).
 * It must be handled later behind such a provider adapter — never as a PayPal
 * capability.
 */

import type { PaymentProvider } from "../../payments.types";
import {
  PaymentProviderError,
  type CreatePaymentLinkInput,
  type CreatePaymentLinkResult,
  type GetPaymentStatusInput,
  type ParsedWebhookEvent,
  type ParseWebhookInput,
  type PaymentProviderAdapter,
  type ProviderPaymentStatus,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
} from "../payment-provider.types";
import type { ProviderDescriptor } from "../provider-descriptor.types";

const PAYPAL_PROVIDER: PaymentProvider = "PAYPAL";
const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const LIVE_BASE = "https://api-m.paypal.com";

// --- injectable HTTP (mocked in tests; defaults to global fetch) -----------

export interface PayPalHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type PayPalHttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<PayPalHttpResponse>;

export interface PayPalProviderOptions {
  fetchImpl?: PayPalHttpClient;
  baseUrl?: string;
  publicBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

// --- pure helpers (exported for tests) -------------------------------------

function get(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** First capture object across the order's purchase units, if any. */
function firstCapture(order: unknown): { id: string | null; status: string | null } {
  const units = get(order, "purchase_units");
  if (Array.isArray(units)) {
    for (const u of units) {
      const captures = get(get(u, "payments"), "captures");
      if (Array.isArray(captures) && captures.length > 0) {
        const c = captures[0];
        const id = get(c, "id");
        const status = get(c, "status");
        return {
          id: id == null ? null : String(id),
          status: status == null ? null : String(status),
        };
      }
    }
  }
  return { id: null, status: null };
}

/**
 * Interpret a PayPal order (post-GET or post-capture) into an outcome.
 * PAID only when the order is COMPLETED and its capture is COMPLETED — a
 * verified captured payment. VOIDED → CANCELLED. A denied/declined capture →
 * FAILED. Anything not-yet-captured → UNKNOWN (not conclusive).
 */
export function interpretOrder(order: unknown): ProviderPaymentStatus {
  const status = String(get(order, "status") ?? "");
  const capture = firstCapture(order);

  if (status === "COMPLETED" && capture.status === "COMPLETED") {
    return { outcome: "PAID", providerTransactionId: capture.id };
  }
  if (capture.status === "DECLINED" || capture.status === "FAILED") {
    return { outcome: "FAILED", providerTransactionId: capture.id };
  }
  if (status === "VOIDED") {
    return { outcome: "CANCELLED", providerTransactionId: capture.id };
  }
  return { outcome: "UNKNOWN", providerTransactionId: capture.id };
}

/** Extract the correlating order id + capture id from a PayPal webhook event. */
export interface PayPalWebhookFields {
  eventId: string | null;
  eventType: string | null;
  orderId: string | null;
  captureId: string | null;
  amount: string | null;
  currency: string | null;
}

export function extractPayPalWebhookFields(
  input: ParseWebhookInput
): PayPalWebhookFields {
  let obj: unknown = null;
  if (input.parsedBody && typeof input.parsedBody === "object") {
    obj = input.parsedBody;
  } else {
    try {
      obj = JSON.parse((input.rawBody ?? "").trim());
    } catch {
      obj = null;
    }
  }

  const eventType = get(obj, "event_type");
  const eventTypeStr = eventType == null ? null : String(eventType);
  const resource = get(obj, "resource");

  let orderId: string | null = null;
  let captureId: string | null = null;
  if (eventTypeStr && eventTypeStr.startsWith("CHECKOUT.ORDER")) {
    const id = get(resource, "id");
    orderId = id == null ? null : String(id);
  } else if (eventTypeStr && eventTypeStr.startsWith("PAYMENT.CAPTURE")) {
    const cid = get(resource, "id");
    captureId = cid == null ? null : String(cid);
    const related = get(get(resource, "supplementary_data"), "related_ids");
    const oid = get(related, "order_id");
    orderId = oid == null ? null : String(oid);
  }

  const amountObj = get(resource, "amount");
  const amountVal = get(amountObj, "value");
  const currencyVal = get(amountObj, "currency_code");
  const eventId = get(obj, "id");

  return {
    eventId: eventId == null ? null : String(eventId),
    eventType: eventTypeStr,
    orderId,
    captureId,
    amount: amountVal == null ? null : String(amountVal),
    currency: currencyVal == null ? null : String(currencyVal),
  };
}

// --- provider factory ------------------------------------------------------

export function createPayPalProvider(
  options: PayPalProviderOptions = {}
): PaymentProviderAdapter {
  const fetchImpl: PayPalHttpClient =
    options.fetchImpl ??
    ((url, init) =>
      (globalThis.fetch as unknown as PayPalHttpClient)(url, init));

  const resolveBaseUrl = (): string => {
    if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
    const env = (process.env.PAYPAL_ENV ?? "sandbox").toLowerCase();
    return (env === "live" || env === "production" ? LIVE_BASE : SANDBOX_BASE);
  };
  const resolveClientId = (): string | null =>
    options.clientId ?? process.env.PAYPAL_CLIENT_ID ?? null;
  const resolveClientSecret = (): string | null =>
    options.clientSecret ?? process.env.PAYPAL_CLIENT_SECRET ?? null;
  const resolvePublicBaseUrl = (): string | null => {
    const v = options.publicBaseUrl ?? process.env.PAYMENTS_PUBLIC_BASE_URL ?? null;
    return v ? v.replace(/\/+$/, "") : null;
  };

  async function request(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<unknown> {
    let res: PayPalHttpResponse;
    try {
      res = await fetchImpl(`${resolveBaseUrl()}${path}`, { method, headers, body });
    } catch {
      throw new PaymentProviderError(PAYPAL_PROVIDER, "HTTP_ERROR", "PayPal request failed (network).");
    }
    if (!res.ok) {
      throw new PaymentProviderError(
        PAYPAL_PROVIDER,
        "HTTP_STATUS",
        `PayPal request failed (status ${res.status}).`
      );
    }
    try {
      return await res.json();
    } catch {
      throw new PaymentProviderError(PAYPAL_PROVIDER, "BAD_RESPONSE", "PayPal returned an unparseable response.");
    }
  }

  async function getAccessToken(): Promise<string> {
    const clientId = resolveClientId();
    const clientSecret = resolveClientSecret();
    if (!clientId || !clientSecret) {
      throw new PaymentProviderError(
        PAYPAL_PROVIDER,
        "MISSING_CREDENTIALS",
        "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are required (env)."
      );
    }
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const result = await request(
      "POST",
      "/v1/oauth2/token",
      {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      "grant_type=client_credentials"
    );
    const token = get(result, "access_token");
    if (!token) {
      throw new PaymentProviderError(PAYPAL_PROVIDER, "AUTH_FAILED", "PayPal did not return an access token.");
    }
    return String(token);
  }

  async function getOrder(orderId: string, token: string): Promise<unknown> {
    return request("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });
  }

  async function captureOrder(orderId: string, token: string): Promise<unknown> {
    return request(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      "{}"
    );
  }

  return {
    provider: PAYPAL_PROVIDER,

    async createPaymentLink(
      input: CreatePaymentLinkInput
    ): Promise<CreatePaymentLinkResult> {
      const publicBaseUrl = resolvePublicBaseUrl();
      if (!publicBaseUrl) {
        throw new PaymentProviderError(
          PAYPAL_PROVIDER,
          "MISSING_PUBLIC_BASE_URL",
          "PAYMENTS_PUBLIC_BASE_URL is required to build PayPal return URLs."
        );
      }
      const token = await getAccessToken();

      const order = await request(
        "POST",
        "/v2/checkout/orders",
        { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              // Canonical correlation: our PaymentRequest id round-trips via custom_id.
              custom_id: String(input.paymentRequestId),
              description: (input.description ?? "Payment").slice(0, 127),
              amount: {
                currency_code: input.currency,
                value: input.amount,
              },
            },
          ],
          application_context: {
            user_action: "PAY_NOW",
            return_url: input.successUrl ?? `${publicBaseUrl}/?payment=success`,
            cancel_url: input.failureUrl ?? `${publicBaseUrl}/?payment=failed`,
          },
        })
      );

      const orderId = get(order, "id");
      const links = get(order, "links");
      let approveUrl: string | null = null;
      if (Array.isArray(links)) {
        for (const l of links) {
          const rel = String(get(l, "rel") ?? "");
          if (rel === "approve" || rel === "payer-action") {
            approveUrl = String(get(l, "href") ?? "");
            break;
          }
        }
      }

      if (!orderId || !approveUrl) {
        throw new PaymentProviderError(
          PAYPAL_PROVIDER,
          "CREATE_FAILED",
          "PayPal did not return an order id + approve link."
        );
      }

      return {
        paymentUrl: approveUrl,
        providerRequestId: String(orderId),
        expiresAt: input.expiresAt ?? null,
      };
    },

    async getPaymentStatus(
      input: GetPaymentStatusInput
    ): Promise<ProviderPaymentStatus> {
      const token = await getAccessToken();
      const orderId = input.providerRequestId;

      let order = await getOrder(orderId, token);
      if (String(get(order, "status") ?? "") === "APPROVED") {
        // Buyer approved — capture it now. If it was already captured
        // concurrently, re-read the order (idempotent authority).
        try {
          order = await captureOrder(orderId, token);
        } catch {
          order = await getOrder(orderId, token);
        }
      }
      return interpretOrder(order);
    },

    verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
      // PayPal is NOT provisioned: no active connection, no payment request and
      // no configured secret in any environment. Wave D removes the former
      // fail-OPEN branch (`if (!secret) return ok`), which let an unconfigured
      // provider accept arbitrary anonymous callbacks. An unconfigured provider
      // now refuses everything.
      //
      // Unlike CardCom, PayPal DOES publish a real verification mechanism
      // (the `verify-webhook-signature` API together with a `PAYPAL_WEBHOOK_ID`).
      // If PayPal is ever activated, that is what must be implemented here — not
      // the invented header convention below, which PayPal does not send.
      const secret = input.secret;
      if (!secret) return { ok: false, reason: "provider_not_configured" };
      const headerToken =
        input.headers["x-webhook-secret"] ??
        input.headers["x-paypal-secret"] ??
        null;
      if (headerToken && headerToken === secret) return { ok: true };
      return { ok: false, reason: "invalid_or_missing_secret" };
    },

    parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent {
      const fields = extractPayPalWebhookFields(input);
      const usable = fields.orderId != null;
      return {
        providerEventId: fields.eventId,
        eventType: fields.eventType,
        // Correlation is by order id (stored as providerRequestId).
        providerRequestId: fields.orderId,
        providerTransactionId: fields.captureId,
        // A usable signal yields PENDING (which triggers verification); an
        // unusable body yields UNKNOWN (rejected before verifying). NEVER PAID.
        outcome: usable ? "PENDING" : "UNKNOWN",
        amount: fields.amount,
        currency: fields.currency,
      };
    },
  };
}

/** Default instance registered in the provider registry (global fetch + env). */
export const payPalProvider: PaymentProviderAdapter = createPayPalProvider();

/**
 * Declarative descriptor. PayPal implements `getPaymentStatus` (Orders GET +
 * capture) → `capabilities.verification` is true. Credentials come from server
 * ENV (sandbox), so there are NO credential fields to collect — the connection
 * is an activation flag; the merchant-id field is a free label.
 */
export const payPalDescriptor: ProviderDescriptor = {
  key: PAYPAL_PROVIDER,
  label: "PayPal",
  merchantIdField: { key: "merchantId", label: "PayPal (sandbox activation label)" },
  credentialFields: [],
  capabilities: {
    hostedCheckout: true,
    verification: true,
    refund: false,
    sandbox: true,
    webhooks: true,
    tokens: false,
  },
};
