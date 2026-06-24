/**
 * CardCom provider (I3).
 *
 * Implements `PaymentProviderAdapter` over CardCom's LowProfile flow:
 *   - createPaymentLink  → LowProfile/Create  (returns a hosted-page Url + LowProfileId)
 *   - getPaymentStatus   → LowProfile/GetLpResult  (the AUTHORITY — see below)
 *   - verifyWebhook      → accept the signal (optionally gated by a shared secret)
 *   - parseWebhook       → signal only; never authority, never throws
 *
 * Authority model (docs/payments-authority-principle-v1.md): the webhook is a
 * SIGNAL that prompts verification. GetLpResult is the AUTHORITY. A payment is
 * PAID only when GetLpResult confirms a successful transaction.
 *
 * Card data: Dubiz never handles it — the cardholder pays on CardCom's hosted
 * page. This adapter only builds the link and reads result metadata.
 *
 * ⚠️ DOCS-CONFIRM (no official CardCom docs in repo; verified only against the
 * mocked shapes in tests): the v11 endpoint paths, request field names
 * (TerminalNumber/ApiName/Amount/ReturnValue/ISOCoinId/WebHookUrl), the
 * GetLpResult success shape (top ResponseCode===0 && TranzactionInfo.ResponseCode===0),
 * and the ISO coin ids. Confirm against current CardCom docs before live use.
 * No live calls are made here; HTTP is injectable and mocked in tests.
 */

import type { PaymentProvider } from "../../payments.types";
import {
  PaymentProviderError,
  type CreatePaymentLinkInput,
  type CreatePaymentLinkResult,
  type GetPaymentStatusInput,
  type ParsedPaymentOutcome,
  type ParsedWebhookEvent,
  type ParseWebhookInput,
  type PaymentProviderAdapter,
  type ProviderPaymentStatus,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
} from "../payment-provider.types";

const CARDCOM_PROVIDER: PaymentProvider = "CARDCOM";
const DEFAULT_BASE_URL = "https://secure.cardcom.solutions";
const CREATE_PATH = "/api/v11/LowProfile/Create";
const GET_RESULT_PATH = "/api/v11/LowProfile/GetLpResult";

/** CardCom ISO coin ids. DOCS-CONFIRM. */
const ISO_COIN_ID: Record<string, number> = { ILS: 1, USD: 2, EUR: 978 };

/**
 * CardCom ProductName length cap. Docs conflict (OpenAPI: 250, KB prose: 50);
 * we use the stricter 50 to avoid runtime rejection by CardCom.
 */
const PRODUCT_NAME_MAX = 50;

// --- injectable HTTP (mocked in tests; defaults to global fetch) -----------

export interface CardComHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type CardComHttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<CardComHttpResponse>;

export interface CardComProviderOptions {
  fetchImpl?: CardComHttpClient;
  baseUrl?: string;
  publicBaseUrl?: string;
}

// --- credential model: JSON { apiName, apiPassword } in the encrypted column -

interface CardComCredential {
  apiName: string;
  apiPassword: string;
}

function parseCredential(raw: string | null): CardComCredential | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.apiName === "string" && obj.apiName) {
      return {
        apiName: obj.apiName,
        apiPassword:
          typeof obj.apiPassword === "string" ? obj.apiPassword : "",
      };
    }
  } catch {
    // fall through
  }
  return null;
}

function caseInsensitiveGet(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const target = key.toLowerCase();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

// --- webhook field extraction (exported for tests) -------------------------

export interface CardComWebhookFields {
  lowProfileId: string | null;
  returnValue: string | null;
  transactionId: string | null;
  rawResponseCode: string | null;
}

export function extractCardComWebhookFields(
  input: ParseWebhookInput
): CardComWebhookFields {
  let obj: unknown = null;
  if (input.parsedBody && typeof input.parsedBody === "object") {
    obj = input.parsedBody;
  } else {
    const raw = (input.rawBody ?? "").trim();
    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = null;
      }
    }
    if (!obj) {
      try {
        obj = Object.fromEntries(new URLSearchParams(input.rawBody ?? ""));
      } catch {
        obj = null;
      }
    }
  }

  const asStr = (v: unknown): string | null =>
    v == null ? null : String(v);

  const tranInfo = caseInsensitiveGet(obj, "TranzactionInfo");
  const transactionId =
    asStr(caseInsensitiveGet(tranInfo, "TranzactionId")) ??
    asStr(caseInsensitiveGet(obj, "TranzactionId")) ??
    asStr(caseInsensitiveGet(obj, "InternalDealNumber"));

  return {
    lowProfileId: asStr(caseInsensitiveGet(obj, "LowProfileId")),
    returnValue: asStr(caseInsensitiveGet(obj, "ReturnValue")),
    transactionId,
    rawResponseCode: asStr(caseInsensitiveGet(obj, "ResponseCode")),
  };
}

// --- GetLpResult outcome interpretation (exported for tests) ---------------

export function interpretGetLpResult(result: unknown): ProviderPaymentStatus {
  const topCode = caseInsensitiveGet(result, "ResponseCode");
  const tranInfo = caseInsensitiveGet(result, "TranzactionInfo");
  const tranCode =
    tranInfo && typeof tranInfo === "object"
      ? caseInsensitiveGet(tranInfo, "ResponseCode")
      : undefined;
  const tranId =
    tranInfo && typeof tranInfo === "object"
      ? caseInsensitiveGet(tranInfo, "TranzactionId")
      : undefined;

  const providerTransactionId = tranId == null ? null : String(tranId);

  let outcome: ParsedPaymentOutcome;
  if (Number(topCode) === 0 && tranInfo && Number(tranCode) === 0) {
    outcome = "PAID";
  } else if (tranInfo && tranCode != null && Number(tranCode) !== 0) {
    // a transaction exists and the provider says it did not succeed
    outcome = "FAILED";
  } else {
    // no transaction yet / query-level non-zero / unparseable => not conclusive
    outcome = "UNKNOWN";
  }

  return { outcome, providerTransactionId };
}

// --- provider factory ------------------------------------------------------

export function createCardComProvider(
  options: CardComProviderOptions = {}
): PaymentProviderAdapter {
  const fetchImpl: CardComHttpClient =
    options.fetchImpl ??
    ((url, init) =>
      (globalThis.fetch as unknown as CardComHttpClient)(url, init));

  const resolveBaseUrl = (): string =>
    (options.baseUrl ?? process.env.CARDCOM_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      ""
    );

  const resolvePublicBaseUrl = (): string | null => {
    const v = options.publicBaseUrl ?? process.env.PAYMENTS_PUBLIC_BASE_URL ?? null;
    return v ? v.replace(/\/+$/, "") : null;
  };

  async function postJson(path: string, body: unknown): Promise<unknown> {
    let res: CardComHttpResponse;
    try {
      res = await fetchImpl(`${resolveBaseUrl()}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new PaymentProviderError(
        CARDCOM_PROVIDER,
        "HTTP_ERROR",
        "CardCom request failed (network)."
      );
    }
    if (!res.ok) {
      throw new PaymentProviderError(
        CARDCOM_PROVIDER,
        "HTTP_STATUS",
        `CardCom request failed (status ${res.status}).`
      );
    }
    try {
      return await res.json();
    } catch {
      throw new PaymentProviderError(
        CARDCOM_PROVIDER,
        "BAD_RESPONSE",
        "CardCom returned an unparseable response."
      );
    }
  }

  return {
    provider: CARDCOM_PROVIDER,

    async createPaymentLink(
      input: CreatePaymentLinkInput
    ): Promise<CreatePaymentLinkResult> {
      const credential = parseCredential(input.credential);
      if (!input.merchantId || !credential) {
        throw new PaymentProviderError(
          CARDCOM_PROVIDER,
          "MISSING_CREDENTIALS",
          "CardCom connection is missing terminal number or API credentials."
        );
      }
      const publicBaseUrl = resolvePublicBaseUrl();
      if (!publicBaseUrl) {
        throw new PaymentProviderError(
          CARDCOM_PROVIDER,
          "MISSING_PUBLIC_BASE_URL",
          "PAYMENTS_PUBLIC_BASE_URL is required to build the CardCom webhook URL."
        );
      }

      const body: Record<string, unknown> = {
        TerminalNumber: Number(input.merchantId),
        ApiName: credential.apiName,
        Amount: Number(input.amount),
        ISOCoinId: ISO_COIN_ID[input.currency] ?? ISO_COIN_ID.ILS,
        // Canonical correlation: our PaymentRequest id round-trips via ReturnValue.
        ReturnValue: String(input.paymentRequestId),
        // ProductName has a provider length limit (I3.1 verified) — cap safely.
        ProductName: (input.description ?? "Payment").slice(0, PRODUCT_NAME_MAX),
        WebHookUrl: `${publicBaseUrl}/api/payments/webhook/cardcom`,
      };
      if (input.successUrl) body.SuccessRedirectUrl = input.successUrl;
      if (input.failureUrl) body.FailedRedirectUrl = input.failureUrl;

      const result = await postJson(CREATE_PATH, body);
      const responseCode = caseInsensitiveGet(result, "ResponseCode");
      const url = caseInsensitiveGet(result, "Url");
      const lowProfileId = caseInsensitiveGet(result, "LowProfileId");

      if (Number(responseCode) !== 0 || !url || !lowProfileId) {
        throw new PaymentProviderError(
          CARDCOM_PROVIDER,
          "CREATE_FAILED",
          "CardCom did not return a payment link."
        );
      }

      return {
        paymentUrl: String(url),
        providerRequestId: String(lowProfileId),
        expiresAt: input.expiresAt ?? null,
      };
    },

    async getPaymentStatus(
      input: GetPaymentStatusInput
    ): Promise<ProviderPaymentStatus> {
      const credential = parseCredential(input.credential);
      if (!input.merchantId || !credential) {
        throw new PaymentProviderError(
          CARDCOM_PROVIDER,
          "MISSING_CREDENTIALS",
          "CardCom connection is missing terminal number or API credentials."
        );
      }

      const result = await postJson(GET_RESULT_PATH, {
        TerminalNumber: Number(input.merchantId),
        ApiName: credential.apiName,
        LowProfileId: input.providerRequestId,
      });

      return interpretGetLpResult(result);
    },

    verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
      // The webhook is only a signal; authority is GetLpResult. When a shared
      // secret is configured we require it; otherwise we accept the signal and
      // rely on verification. (No funds move through Dubiz.)
      const secret = input.secret;
      if (!secret) return { ok: true };
      const headerToken =
        input.headers["x-cardcom-secret"] ??
        input.headers["x-webhook-secret"] ??
        null;
      if (headerToken && headerToken === secret) return { ok: true };
      const fields = extractCardComWebhookFields({ rawBody: input.rawBody });
      void fields;
      return { ok: false, reason: "invalid_or_missing_secret" };
    },

    parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent {
      const fields = extractCardComWebhookFields(input);
      // Correlation is by LowProfileId (stored as providerRequestId). A usable
      // signal yields PENDING (which triggers verification); an unusable body
      // yields UNKNOWN (which the orchestration rejects before verifying).
      const usable = fields.lowProfileId != null;
      return {
        providerEventId: fields.transactionId ?? fields.lowProfileId,
        eventType: "lowprofile",
        providerRequestId: fields.lowProfileId,
        providerTransactionId: fields.transactionId,
        outcome: usable ? "PENDING" : "UNKNOWN",
        amount: null,
        currency: null,
      };
    },
  };
}

/** Default instance registered in the provider registry (global fetch + env). */
export const cardComProvider: PaymentProviderAdapter = createCardComProvider();
