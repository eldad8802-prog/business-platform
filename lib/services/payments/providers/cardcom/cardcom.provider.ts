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
  type RefundPaymentInput,
  type RefundPaymentResult,
  type RefundStatusInput,
  type RefundStatusResult,
} from "../payment-provider.types";
import type { ProviderDescriptor } from "../provider-descriptor.types";

const CARDCOM_PROVIDER: PaymentProvider = "CARDCOM";
const DEFAULT_BASE_URL = "https://secure.cardcom.solutions";
const CREATE_PATH = "/api/v11/LowProfile/Create";
const GET_RESULT_PATH = "/api/v11/LowProfile/GetLpResult";
const REFUND_PATH = "/api/v11/Transactions/RefundByTransactionId";
const TRANSACTION_INFO_PATH = "/api/v11/Transactions/GetTransactionInfoById";

/**
 * Our own reference on a reversal, derived from the reservation id.
 *
 * Deterministic on purpose: the same intent retried carries the same
 * reference, so it can never read as a second one. CardCom accepts it as
 * ExternalRefundDealId — but whether it can be QUERIED BACK after a lost
 * response is an open question with CardCom support. Until that is answered
 * this reference is evidence for a human, not a correlation key this adapter
 * is allowed to rely on.
 */
export function externalRefundReference(reversalId: number): string {
  return `dubiz-reversal-${reversalId}`;
}

/**
 * CardCom ISO coin ids. DOCS-CONFIRM.
 *
 * This table is the only thing that lets this adapter express a currency to
 * CardCom, so its keys are exactly the currencies the adapter supports.
 */
const ISO_COIN_ID: Record<string, number> = { ILS: 1, USD: 2, EUR: 978 };

/**
 * Declared currency support — derived from `ISO_COIN_ID`, never written twice.
 *
 * SEC-05. This adapter previously resolved `ISO_COIN_ID[currency] ?? ISO_COIN_ID.ILS`.
 * A currency with no coin id was therefore charged in SHEKELS while the
 * PaymentRequest, the audit trail, the verification result and the resulting
 * FinancialEvent all recorded the currency the caller asked for. Nothing
 * downstream could catch it: the webhook's coherence gate compares the payload
 * against the stored request, and both were consistently wrong. The fallback is
 * gone — an unsupported currency is refused before any provider call.
 */
export const CARDCOM_SUPPORTED_CURRENCIES: readonly string[] = Object.freeze(
  Object.keys(ISO_COIN_ID)
);

/** Resolve a coin id, or fail closed. Never substitutes another currency. */
function resolveIsoCoinId(currency: string): number {
  const coinId = ISO_COIN_ID[currency];
  if (typeof coinId !== "number") {
    throw new PaymentProviderError(
      CARDCOM_PROVIDER,
      "UNSUPPORTED_CURRENCY",
      `CardCom cannot be charged in ${currency}. Supported: ${CARDCOM_SUPPORTED_CURRENCIES.join(", ")}.`
    );
  }
  return coinId;
}

/**
 * CardCom LowProfileId shape — a canonical GUID.
 *
 * Verified against live production data before being used as a gate: every
 * stored CardCom `PaymentRequest.providerRequestId` is a 36-character
 * 8-4-4-4-12 hex GUID. Matching is case-insensitive so an uppercase variant is
 * still accepted; the pattern is deliberately no stricter than that, because a
 * gate that rejected a legitimate CardCom callback would break settlement.
 *
 * This is a cheap structural filter only. It is NOT authentication — see
 * `verifyWebhook` for why CardCom cannot be authenticated at this layer.
 */
const LOW_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES,

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

      // SEC-05 — fail closed on a currency this adapter cannot encode. Placed
      // before the request body is built so nothing reaches CardCom.
      const isoCoinId = resolveIsoCoinId(input.currency);

      const body: Record<string, unknown> = {
        TerminalNumber: Number(input.merchantId),
        ApiName: credential.apiName,
        // Explicit operation. Default is ChargeOnly; sent explicitly to be
        // resilient to a future default change and for auditability.
        Operation: "ChargeOnly",
        Amount: Number(input.amount),
        ISOCoinId: isoCoinId,
        // Canonical correlation: our PaymentRequest id round-trips via ReturnValue.
        ReturnValue: String(input.paymentRequestId),
        // ProductName has a provider length limit (I3.1 verified) — cap safely.
        ProductName: (input.description ?? "Payment").slice(0, PRODUCT_NAME_MAX),
        // v11 CreateLowProfile requires the redirect URLs. Use caller-supplied
        // values when present, else safe defaults from the public base URL (the
        // browser lands on a real page; settlement is server-side via webhook).
        SuccessRedirectUrl: input.successUrl ?? `${publicBaseUrl}/?payment=success`,
        FailedRedirectUrl: input.failureUrl ?? `${publicBaseUrl}/?payment=failed`,
        WebHookUrl: `${publicBaseUrl}/api/payments/webhook/cardcom`,
      };

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

    async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
      // CardCom publishes NO webhook signing mechanism. Its documented callback
      // model is an IndicatorUrl/WebHookUrl notification carrying LowProfileId
      // and ReturnValue, with authenticity obtained out-of-band by the merchant
      // calling LowProfile/GetLpResult with its own API credentials. There is no
      // HMAC header, no signing secret, and no signature to verify.
      //
      // The previous implementation invented an `x-cardcom-secret` header and,
      // when no secret was configured, returned ok — i.e. it FAILED OPEN. Worse,
      // the invented header is one CardCom never sends, so configuring a secret
      // would have rejected every legitimate callback. That model is removed
      // here rather than papered over: it could never be a real provider
      // authentication and pretending otherwise would misstate the control.
      //
      // What this function can honestly do is a fail-CLOSED structural gate. It
      // is synchronous and has no database access, so it establishes only that
      // the body is a well-formed CardCom LowProfile callback. Authenticity is
      // established downstream, and is not optional:
      //   1. the LowProfileId must resolve to a PaymentRequest THIS system
      //      created (processPaymentWebhook correlates before any persistence);
      //   2. ReturnValue must independently match that request's id;
      //   3. the outcome comes only from an authenticated server-to-server
      //      GetLpResult call — never from this payload.
      // See the CASA 7.2.1/7.2.2 compensating-control memo.
      const fields = extractCardComWebhookFields({ rawBody: input.rawBody });
      if (!fields.lowProfileId || !LOW_PROFILE_ID_PATTERN.test(fields.lowProfileId)) {
        return { ok: false, reason: "malformed_lowprofileid" };
      }
      return { ok: true };
    },

    parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent {
      const fields = extractCardComWebhookFields(input);
      // Correlation is by LowProfileId (stored as providerRequestId). A usable
      // signal yields PENDING (which triggers verification); an unusable body
      // yields UNKNOWN (which the orchestration rejects before verifying).
      // NOTE: outcome is deliberately never PAID here — the payload is a signal,
      // and only GetLpResult may establish a settlement.
      const usable =
        fields.lowProfileId != null &&
        LOW_PROFILE_ID_PATTERN.test(fields.lowProfileId);
      return {
        providerEventId: fields.transactionId ?? fields.lowProfileId,
        eventType: "lowprofile",
        providerRequestId: fields.lowProfileId,
        providerTransactionId: fields.transactionId,
        outcome: usable ? "PENDING" : "UNKNOWN",
        amount: null,
        currency: null,
        // Our own PaymentRequest id, round-tripped by CardCom via ReturnValue
        // (set at LowProfile/Create). The orchestration asserts it matches the
        // request that LowProfileId resolved to.
        correlationValue: fields.returnValue,
      };
    },

    /**
     * Reverse a settled CardCom transaction, or withdraw one before deposit.
     *
     * TRANSPORT AMBIGUITY IS NOT A REFUSAL. Every other call in this adapter
     * may throw when the network fails, because a payment that was not created
     * simply is not created. A reversal is the opposite: the instruction may
     * have arrived and executed, and only the answer was lost. Treating that as
     * a refusal releases the reservation and lets a second reversal be issued
     * for money that already left. So this returns UNKNOWN for anything it
     * cannot read as a verdict, and throws ONLY when CardCom itself states the
     * reversal did not happen.
     */
    async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
      const credential = parseCredential(input.credential);
      if (!input.merchantId || !credential || !credential.apiPassword) {
        // Configuration, not transport: nothing was sent, so nothing can have
        // happened, and a throw is the honest answer.
        throw new PaymentProviderError(
          CARDCOM_PROVIDER,
          "MISSING_CREDENTIALS",
          "CardCom connection is missing terminal number or API credentials."
        );
      }

      const transactionId = Number(input.settlement.providerTransactionId);
      if (!Number.isInteger(transactionId) || transactionId <= 0) {
        throw new PaymentProviderError(
          CARDCOM_PROVIDER,
          "MISSING_TRANSACTION_ID",
          "This CardCom payment has no numeric transaction id to reverse."
        );
      }

      const amount = Number(input.amount);
      const settled = Number(input.settlement.amount);
      const isPartial =
        Number.isFinite(amount) && Number.isFinite(settled) && amount < settled;

      const body: Record<string, unknown> = {
        ApiName: credential.apiName,
        // Required by THIS endpoint. LowProfile/Create needs only ApiName, so
        // this is the first CardCom call that sends the stored password.
        ApiPassword: credential.apiPassword,
        TransactionId: transactionId,
        ExternalRefundDealId: externalRefundReference(input.reversalId),
        // A void withdraws the transaction before deposit; a refund returns
        // money from a settled one. The domain decided which, upstream.
        CancelOnly: input.intent === "VOID",
        // Dubiz already bounds the cumulative reversal against the settled
        // amount and refuses anything beyond it before reaching this line. The
        // provider flag only PERMITS more than one; our ledger is the stricter
        // of the two, so enabling it removes no safety net we depend on — it
        // stops CardCom refusing a legitimate second part.
        AllowMultipleRefunds: input.intent === "REFUND",
      };
      if (isPartial) body.PartialSum = amount;

      let result: unknown;
      try {
        result = await postJson(REFUND_PATH, body);
      } catch {
        // Network failure, non-2xx, unparseable body — all of it is silence,
        // and silence is UNKNOWN. The reservation stays held upstream.
        return { providerRefundId: null, outcome: "UNKNOWN" };
      }

      const code = caseInsensitiveGet(result, "ResponseCode");
      const newId = caseInsensitiveGet(result, "NewTranzactionId");

      if (Number(code) === 0) {
        return {
          providerRefundId: newId == null ? null : String(newId),
          outcome: "REFUNDED",
        };
      }

      if (code == null) {
        // A 200 that says nothing we recognise establishes nothing.
        return { providerRefundId: null, outcome: "UNKNOWN" };
      }

      // CardCom stated a verdict and it is not success. THIS is the definite
      // refusal the domain releases a reservation for.
      const description = caseInsensitiveGet(result, "Description");
      throw new PaymentProviderError(
        CARDCOM_PROVIDER,
        `REFUND_${String(code)}`,
        typeof description === "string" && description.trim() !== ""
          ? description
          : `CardCom refused the reversal (code ${String(code)}).`
      );
    },

    /**
     * What became of a reversal, asked of CardCom by the reversal's own id.
     *
     * ONLY by that id. CardCom's queries correlate on ITS identifiers, not
     * ours: ListTransactions returns no field carrying the ExternalRefundDealId
     * we sent, and GetTransactionByExternalUniqTran reads a differently-named
     * field the refund contract does not populate. Matching on amount, terminal
     * and a time window would find the wrong row exactly when it matters — two
     * reversals of the same amount — so with no id this answers UNKNOWN rather
     * than guessing, and the reservation stays held.
     */
    async getRefundStatus(input: RefundStatusInput): Promise<RefundStatusResult> {
      const credential = parseCredential(input.credential);
      if (!input.merchantId || !credential || !credential.apiPassword) {
        return {
          outcome: "UNKNOWN",
          detail: "connection is not configured for verification",
        };
      }
      if (!input.providerRefundId) {
        return {
          outcome: "UNKNOWN",
          detail:
            "no CardCom reversal id was received, and CardCom exposes no " +
            "documented query for our own reference",
        };
      }

      const internalDealNumber = Number(input.providerRefundId);
      if (!Number.isInteger(internalDealNumber) || internalDealNumber <= 0) {
        return {
          outcome: "UNKNOWN",
          detail: "reversal id is not a CardCom deal number",
        };
      }

      let result: unknown;
      try {
        result = await postJson(TRANSACTION_INFO_PATH, {
          TerminalNumber: Number(input.merchantId),
          UserName: credential.apiName,
          UserPassword: credential.apiPassword,
          InternalDealNumber: internalDealNumber,
        });
      } catch {
        return { outcome: "UNKNOWN", detail: "CardCom could not be reached" };
      }

      // The documented success shape is an array of transaction parameter sets.
      // A row under the id we asked about means CardCom holds that reversal.
      if (Array.isArray(result)) {
        if (result.length > 0) {
          return {
            outcome: "REFUNDED",
            providerRefundId: String(internalDealNumber),
            detail: "CardCom holds a transaction under the reversal id",
          };
        }
        return {
          outcome: "UNKNOWN",
          detail: "CardCom returned no transaction for that id",
        };
      }

      const code = caseInsensitiveGet(result, "ResponseCode");
      return {
        outcome: "UNKNOWN",
        detail:
          code == null
            ? "CardCom returned an unrecognised response"
            : `CardCom response code ${String(code)}`,
      };
    },
  };
}

/** Default instance registered in the provider registry (global fetch + env). */
export const cardComProvider: PaymentProviderAdapter = createCardComProvider();

/**
 * Declarative descriptor (provider-driven connections). CardCom implements
 * `getPaymentStatus` (GetLpResult) → `capabilities.verification` is true.
 * Credential is stored as the generic JSON blob { apiName, apiPassword }.
 */
export const cardComDescriptor: ProviderDescriptor = {
  key: CARDCOM_PROVIDER,
  label: "CardCom",
  merchantIdField: { key: "terminalNumber", label: "Terminal Number" },
  credentialFields: [
    { key: "apiName", label: "API Name", type: "text", required: true },
    { key: "apiPassword", label: "API Password", type: "secret", required: true },
  ],
  capabilities: {
    hostedCheckout: true,
    verification: true,
    refund: true,
    partialRefund: true,
    void: true,
    refundVerification: true,
    sandbox: true,
    webhooks: true,
    tokens: false,
  },
  supportedCurrencies: CARDCOM_SUPPORTED_CURRENCIES,
};
