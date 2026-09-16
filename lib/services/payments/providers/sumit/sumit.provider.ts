/**
 * SUMIT (formerly OfficeGuy) — the third real provider, and the first that
 * issues NO session identifier at checkout.
 *
 * Every behaviour encoded here was observed against SUMIT's sandbox on
 * 2026-09-15 with a test terminal and their published test cards, not inferred
 * from documentation. Where the live API and the published OpenAPI disagree,
 * the live API won and the disagreement is called out at the point it matters.
 *
 * WHAT MAKES THIS PROVIDER DIFFERENT
 *
 *   1. `BeginRedirect` returns a payment page URL and NOTHING else. The
 *      published response object declares `additionalProperties: false` around
 *      a single `RedirectURL`, and the live call agreed. So there is no
 *      provider session id to store, and none is invented.
 *   2. The callback carries no signature of any kind. Authenticity is
 *      possession of a URL only SUMIT was given, so the orchestration mints an
 *      opaque per-request secret and this adapter embeds it in `IPNURL`.
 *   3. `IPNURL` is UNDOCUMENTED. It does not appear in the OpenAPI schema,
 *      whose request object also declares `additionalProperties: false`. SUMIT's
 *      own WooCommerce plugin sends it, and the live sandbox both accepted it
 *      and called it back for a CARD payment. That combination — their code
 *      plus our observation — is why it is relied on, and why the reconciliation
 *      path below does not depend on it.
 *   4. Authority is a two-step SERVER-SIDE lookup keyed on a value Dubiz
 *      generated before the payment existed. The browser redirect does carry
 *      identifiers, and they are never read.
 *
 * Card data: Dubiz never handles it. The cardholder pays on SUMIT's hosted page.
 * Refunds run against the customer's stored payment method, so they need no card
 * number and no CVV either.
 */

import type { PaymentProvider } from "../../payments.types";
import {
  PaymentProviderError,
  type CreatePaymentLinkInput,
  type CreatePaymentLinkResult,
  type GetPaymentStatusInput,
  type ParseWebhookInput,
  type ParsedPaymentOutcome,
  type ParsedWebhookEvent,
  type PaymentProviderAdapter,
  type ProviderPaymentStatus,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
} from "../payment-provider.types";
import type { ProviderDescriptor } from "../provider-descriptor.types";
import { buildCallbackUrl } from "../../payment-callback-secret";

const SUMIT_PROVIDER: PaymentProvider = "SUMIT";

/**
 * There is exactly one host.
 *
 * Unlike CardCom and PayPlus, SUMIT publishes no separate sandbox host. Their
 * own plugin references `dev.api.sumit.co.il`, which does not resolve in DNS at
 * all. Testing is done by pointing at a test ORGANISATION on the production
 * host, identified by its own CompanyID and API key and wired to a test
 * terminal.
 *
 * The safety consequence is important and worth stating plainly: for this
 * provider, "am I about to move real money" is a property of the CREDENTIAL, not
 * of the URL. There is no host-level fail-safe to build, so none is pretended.
 */
const SUMIT_BASE_URL = "https://api.sumit.co.il";

const BEGIN_REDIRECT_PATH = "/billing/payments/beginredirect/";
const PAYMENTS_GET_PATH = "/billing/payments/get/";
const PAYMENTS_CHARGE_PATH = "/billing/payments/charge/";
const LIST_ENTITIES_PATH = "/crm/data/listentities/";

/**
 * The CRM folder that holds completed credit-card clearings, and the property on
 * it that carries the external identifier we set at checkout.
 *
 * ⚠️ BOTH ARE PER-COMPANY VALUES, discovered by calling `/crm/schema/listfolders/`
 * and `/crm/schema/getfolder/`. The ids below are from the Dubiz test company and
 * are NOT portable. The folder is resolved by NAME at runtime for that reason;
 * the id is kept only to document what was observed.
 *
 * ⚠️ AND THE FILTER TAKES THE PROPERTY NAME, NOT ITS ID. The spec says the filter
 * accepts "either property identifier (numeric) or property name". Filtering by
 * the numeric id returned by `getfolder` fails in the live API with
 * `Filter property not found`. Only the name works. This cost a round trip to
 * discover and is the single most surprising thing in the integration.
 */
const CLEARINGS_FOLDER_NAME = "סליקות אשראי";
const EXTERNAL_IDENTIFIER_PROPERTY = "מזהה חיצוני";
/** Observed on the Dubiz test company. Documentation only; never sent. */
export const OBSERVED_TEST_CLEARINGS_FOLDER_ID = "2345705517";

/** Shva success code, as returned in `Payment.Status`. */
const SUCCESS_STATUS_CODE = "000";

/**
 * Currencies this adapter will ENCODE.
 *
 * SUMIT's document-level currency enum lists roughly 160 ISO codes, but that is
 * the DOCUMENT's currency, not what the merchant's terminal can clear. A merchant
 * clearing through the Upay aggregator is limited to shekels and dollars; a
 * direct terminal can do more. The API exposes no way to ask which.
 *
 * So the honest static answer is the intersection every SUMIT merchant can
 * actually clear. Anything wider would let a request reach a terminal that
 * cannot settle it. Per-connection currency support is a real and separate
 * piece of work, deliberately out of scope here.
 */
export const SUMIT_SUPPORTED_CURRENCIES: readonly string[] = Object.freeze([
  "ILS",
  "USD",
]);

/**
 * The correlation value Dubiz carries through SUMIT.
 *
 * Derived from the PaymentRequest id rather than random, because reconciliation
 * has to RECONSTRUCT it later from nothing but the stored request. It is unique
 * by construction (the id is a primary key) and immutable (the id never
 * changes), which is what "collision-safe" requires here.
 *
 * It is not a secret and does not need to be. Knowing it buys nothing: a caller
 * cannot create a clearing under it without actually paying, and the lookup is
 * ours to perform. Authentication of the callback is the separate opaque secret.
 *
 * The one residual hazard is two Dubiz environments sharing a single SUMIT
 * company, where `dubiz-5` could match two clearings. That resolves to MORE THAN
 * ONE row, which `interpretClearingMatches` refuses rather than guesses.
 */
export function buildCorrelationValue(paymentRequestId: number | string): string {
  return `dubiz-${paymentRequestId}`;
}

// --- injectable HTTP (mocked in tests; defaults to global fetch) -----------

export interface SumitHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type SumitHttpClient = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<SumitHttpResponse>;

export interface SumitProviderOptions {
  fetchImpl?: SumitHttpClient;
  /** Explicit base URL. Used by tests only. */
  baseUrl?: string;
  publicBaseUrl?: string;
  /** Deadline for a single SUMIT call. Non-positive values fall back. */
  requestTimeoutMs?: number;
}

/**
 * Default per-request deadline. A provider that accepts the connection and then
 * never answers would otherwise hold a webhook, and its tenant transaction,
 * open indefinitely.
 */
export const SUMIT_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Run one attempt under a hard deadline. REJECTS on expiry; it never resolves to
 * a synthetic response, so no caller can mistake "we stopped waiting" for "the
 * provider answered".
 *
 * Not `unref`ed, deliberately: an unref'd timer does not hold the event loop
 * open, so while a slow provider is awaited the loop can look empty and the
 * process exits silently with code 0, mid-request. Always cleared in `finally`.
 */
export async function withDeadline<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`SUMIT request exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- credential model ------------------------------------------------------

/**
 * SUMIT authenticates with `{ CompanyID, APIKey }` in the request BODY.
 *
 * `CompanyID` is the merchant identifier and lives in the `merchantId` column;
 * `apiKey` is the secret and lives in the encrypted credential blob. A public
 * key also exists for browser-facing calls, which this adapter makes none of, so
 * it is deliberately not collected.
 */
interface SumitCredential {
  apiKey: string;
}

function parseCredential(raw: string | null): SumitCredential | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj && typeof obj === "object" && typeof obj.apiKey === "string" && obj.apiKey) {
      return { apiKey: obj.apiKey };
    }
  } catch {
    // fall through
  }
  return null;
}

function parseCompanyId(merchantId: string | null): number | null {
  if (!merchantId) return null;
  const trimmed = merchantId.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// --- payload reading -------------------------------------------------------

function get(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

function asString(value: unknown): string | null {
  return value == null ? null : String(value);
}

/**
 * The fields a SUMIT IPN carries, flattened.
 *
 * OBSERVED SHAPE, and it is not what the headers claim. The delivery is a POST
 * whose `Content-Type` is `text/plain; charset=utf-8`, but the body is
 * form-encoded: `customerid=...&documentid=...&valid=...`. Parsing on the
 * declared content type alone would read nothing.
 *
 * JSON is attempted first anyway, so that a future SUMIT change to a more
 * honest content type does not break the integration.
 */
export interface SumitCallbackFields {
  customerId: string | null;
  documentId: string | null;
  valid: string | null;
}

export function extractSumitCallbackFields(
  input: ParseWebhookInput
): SumitCallbackFields {
  const raw = input.rawBody ?? "";
  let body: Record<string, unknown> | null = null;

  if (input.parsedBody && typeof input.parsedBody === "object") {
    body = input.parsedBody as Record<string, unknown>;
  } else {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        body = j as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    if (!body) {
      try {
        const params = new URLSearchParams(raw);
        const entries = [...params.entries()];
        if (entries.length > 0) body = Object.fromEntries(entries);
      } catch {
        body = null;
      }
    }
  }

  // Field names arrive lowercase in the observed delivery. Read case-insensitively
  // so a change in casing cannot silently empty the event.
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    lower[k.toLowerCase()] = v;
  }

  return {
    customerId: asString(get(lower, "customerid")),
    documentId: asString(get(lower, "documentid")),
    valid: asString(get(lower, "valid")),
  };
}

/**
 * Interpret a `/billing/payments/get/` result into an outcome.
 *
 * PAID requires BOTH the explicit validity flag and the Shva success code.
 * Anything the response does not positively establish is UNKNOWN, which the
 * orchestration treats as "do not settle" — never as failure and never as
 * success.
 */
export function interpretSumitPayment(result: unknown): ProviderPaymentStatus {
  const payment = get(get(result, "Data"), "Payment") ?? null;
  if (payment == null) {
    return { outcome: "UNKNOWN", providerTransactionId: null };
  }

  const id = asString(get(payment, "ID"));
  const valid = get(payment, "ValidPayment");
  const status = asString(get(payment, "Status"));

  if (valid === true && status === SUCCESS_STATUS_CODE) {
    return { outcome: "PAID", providerTransactionId: id };
  }
  if (valid === false) {
    return { outcome: "FAILED", providerTransactionId: id };
  }
  if (status != null && status !== SUCCESS_STATUS_CODE) {
    return { outcome: "FAILED", providerTransactionId: id };
  }
  return { outcome: "UNKNOWN", providerTransactionId: id };
}

/**
 * Turn the clearings query result into a single payment id, or refuse.
 *
 * ZERO rows means the payment has not happened yet — the correct reading of a
 * checkout that was created and never completed, and NOT a failure.
 *
 * MORE THAN ONE row means the correlation is ambiguous, which should be
 * impossible and therefore matters. Choosing one arbitrarily would settle a
 * Dubiz request against a clearing that might belong to a different one, so this
 * fails closed and says why.
 */
export function interpretClearingMatches(result: unknown): {
  outcome: "ONE" | "NONE" | "AMBIGUOUS";
  paymentId: string | null;
  count: number;
} {
  const entities = get(get(result, "Data"), "Entities");
  const list = Array.isArray(entities) ? entities : [];
  if (list.length === 0) return { outcome: "NONE", paymentId: null, count: 0 };
  if (list.length > 1) {
    return { outcome: "AMBIGUOUS", paymentId: null, count: list.length };
  }
  const id = asString(get(list[0], "ID"));
  return { outcome: id ? "ONE" : "NONE", paymentId: id, count: 1 };
}

// --- provider factory ------------------------------------------------------

export function createSumitProvider(
  options: SumitProviderOptions = {}
): PaymentProviderAdapter {
  const fetchImpl: SumitHttpClient =
    options.fetchImpl ??
    ((url, init) => (globalThis.fetch as unknown as SumitHttpClient)(url, init));

  const baseUrl = (): string =>
    (options.baseUrl ?? SUMIT_BASE_URL).replace(/\/+$/, "");

  const requestTimeoutMs =
    typeof options.requestTimeoutMs === "number" &&
    Number.isFinite(options.requestTimeoutMs) &&
    options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : SUMIT_DEFAULT_TIMEOUT_MS;

  const resolvePublicBaseUrl = (): string | null => {
    const v = options.publicBaseUrl ?? process.env.PAYMENTS_PUBLIC_BASE_URL ?? null;
    return v ? v.replace(/\/+$/, "") : null;
  };

  function requireAuth(
    merchantId: string | null,
    credential: string | null
  ): { companyId: number; apiKey: string } {
    const companyId = parseCompanyId(merchantId);
    const cred = parseCredential(credential);
    if (companyId === null || !cred) {
      // Deliberately says nothing about which half is missing and repeats no
      // credential material.
      throw new PaymentProviderError(
        SUMIT_PROVIDER,
        "MISSING_CREDENTIALS",
        "The SUMIT connection is missing its company id or API key."
      );
    }
    return { companyId, apiKey: cred.apiKey };
  }

  async function post(
    path: string,
    auth: { companyId: number; apiKey: string },
    body: Record<string, unknown>
  ): Promise<unknown> {
    // Credentials travel in the BODY over HTTPS, never in a URL or a header,
    // because that is the only shape SUMIT accepts.
    const payload = {
      Credentials: { CompanyID: auth.companyId, APIKey: auth.apiKey },
      ...body,
    };

    let res: SumitHttpResponse;
    try {
      res = await withDeadline(
        (signal) =>
          fetchImpl(`${baseUrl()}${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-OG-Client": "Dubiz",
            },
            body: JSON.stringify(payload),
            signal,
          }),
        requestTimeoutMs
      );
    } catch {
      throw new PaymentProviderError(
        SUMIT_PROVIDER,
        "HTTP_ERROR",
        "SUMIT request failed (network or timeout)."
      );
    }

    if (!res.ok) {
      throw new PaymentProviderError(
        SUMIT_PROVIDER,
        "HTTP_STATUS",
        `SUMIT request failed (status ${res.status}).`
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PaymentProviderError(
        SUMIT_PROVIDER,
        "BAD_RESPONSE",
        "SUMIT returned a response that was not JSON."
      );
    }

    // SUMIT answers HTTP 200 for business errors and signals them in the
    // envelope: Status 0 is success, 1 a business error, 2 a technical one. A
    // caller that checked only the HTTP status would read a failure as a success.
    const status = get(json, "Status");
    if (status !== 0) {
      const message = asString(get(json, "UserErrorMessage")) ?? "unspecified error";
      throw new PaymentProviderError(
        SUMIT_PROVIDER,
        "PROVIDER_ERROR",
        `SUMIT refused the request: ${message}`
      );
    }
    return json;
  }

  /**
   * The authoritative chain, in full. Both steps are server-to-server and
   * neither reads anything a browser touched.
   */
  async function resolveAuthoritativePayment(
    auth: { companyId: number; apiKey: string },
    correlation: string
  ): Promise<ProviderPaymentStatus> {
    const matches = await post(LIST_ENTITIES_PATH, auth, {
      Folder: CLEARINGS_FOLDER_NAME,
      // Property NAME, not id. The numeric id is rejected by the live API.
      Filters: [
        { Property: EXTERNAL_IDENTIFIER_PROPERTY, Value: correlation },
      ],
      Paging: { StartIndex: 0, PageSize: 10 },
    });

    const found = interpretClearingMatches(matches);

    if (found.outcome === "NONE") {
      // Created but not paid. Not a failure.
      return { outcome: "UNKNOWN", providerTransactionId: null };
    }
    if (found.outcome === "AMBIGUOUS") {
      throw new PaymentProviderError(
        SUMIT_PROVIDER,
        "AMBIGUOUS_CORRELATION",
        `SUMIT returned ${found.count} clearings for one correlation value; refusing to choose.`
      );
    }

    const payment = await post(PAYMENTS_GET_PATH, auth, {
      PaymentID: Number(found.paymentId),
    });
    return interpretSumitPayment(payment);
  }

  return {
    provider: SUMIT_PROVIDER,
    supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES,
    // SUMIT publishes no callback signature at all, so authenticity is
    // possession of the URL. See payment-callback-secret.ts.
    usesCallbackSecret: true,

    async createPaymentLink(
      input: CreatePaymentLinkInput
    ): Promise<CreatePaymentLinkResult> {
      const auth = requireAuth(input.merchantId, input.credential);

      const publicBaseUrl = resolvePublicBaseUrl();
      if (!publicBaseUrl) {
        throw new PaymentProviderError(
          SUMIT_PROVIDER,
          "MISSING_PUBLIC_BASE_URL",
          "PAYMENTS_PUBLIC_BASE_URL is required to build the SUMIT callback URL."
        );
      }
      if (!input.callbackSecret) {
        // Without it there is no way for a later callback to name this request,
        // and no signature to fall back on. Refusing here is better than
        // creating a payment that could never be attributed.
        throw new PaymentProviderError(
          SUMIT_PROVIDER,
          "MISSING_CALLBACK_SECRET",
          "SUMIT checkout requires a per-request callback secret."
        );
      }
      if (!SUMIT_SUPPORTED_CURRENCIES.includes(input.currency)) {
        throw new PaymentProviderError(
          SUMIT_PROVIDER,
          "UNSUPPORTED_CURRENCY",
          `SUMIT cannot be charged in ${input.currency}. Supported: ${SUMIT_SUPPORTED_CURRENCIES.join(", ")}.`
        );
      }

      const correlation = buildCorrelationValue(input.paymentRequestId);
      const callbackUrl = buildCallbackUrl(
        publicBaseUrl,
        "api/payments/webhook/sumit",
        input.callbackSecret
      );

      const result = await post(BEGIN_REDIRECT_PATH, auth, {
        Customer: {
          Name: input.description ? `Dubiz ${input.paymentRequestId}` : "Dubiz customer",
          ExternalIdentifier: `${correlation}-cust`,
          SearchMode: "Automatic",
        },
        Items: [
          {
            Item: {
              Name: input.description ?? "Payment",
              SearchMode: "Automatic",
            },
            Quantity: 1,
            // SUMIT takes a decimal amount, not minor units.
            UnitPrice: Number(input.amount),
            Currency: input.currency,
            Description: input.description ?? undefined,
          },
        ],
        VATIncluded: true,
        // The one value the whole authority chain is keyed on.
        ExternalIdentifier: correlation,
        RedirectURL: input.successUrl ?? `${publicBaseUrl}/?payment=success`,
        CancelRedirectURL: input.failureUrl ?? `${publicBaseUrl}/?payment=failed`,
        // UNDOCUMENTED, and accepted by the live API. See the header note.
        IPNURL: callbackUrl,
        DocumentDescription: input.description ?? undefined,
      });

      const link = asString(get(get(result, "Data"), "RedirectURL"));
      if (!link) {
        throw new PaymentProviderError(
          SUMIT_PROVIDER,
          "CREATE_FAILED",
          "SUMIT did not return a payment page link."
        );
      }

      return {
        paymentUrl: link,
        // NO provider id. SUMIT issues none, and inventing one would corrupt
        // the routing index. This is the whole reason the field is optional.
        providerRequestId: null,
        expiresAt: input.expiresAt ?? null,
      };
    },

    /**
     * Pre-correlation structural gate ONLY.
     *
     * SUMIT signs nothing, so there is no signature to verify here and this must
     * not pretend otherwise. The real authentication is the opaque URL secret,
     * which the route checks before this adapter is reached. What this step does
     * is refuse a body that could not possibly be a SUMIT callback, so an
     * obviously bogus request never costs a lookup.
     */
    async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
      const fields = extractSumitCallbackFields({ rawBody: input.rawBody });
      if (!fields.documentId && !fields.customerId) {
        return { ok: false, reason: "not_a_sumit_callback" };
      }
      return { ok: true };
    },

    parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent {
      const fields = extractSumitCallbackFields(input);

      // The callback is a SIGNAL. Its own `valid` flag is deliberately NOT
      // turned into PAID: only the authoritative lookup may do that. A usable
      // body yields PENDING, which prompts verification; an unusable one yields
      // UNKNOWN, which the orchestration refuses before any write.
      const usable = fields.documentId != null || fields.customerId != null;
      const outcome: ParsedPaymentOutcome = usable ? "PENDING" : "UNKNOWN";

      return {
        // The document id is per-settlement and is the right idempotency key.
        providerEventId: fields.documentId,
        eventType: "sumit_ipn",
        // SUMIT issues no session id, so there is nothing to correlate on from
        // the payload. The URL secret already named the request.
        providerRequestId: null,
        providerTransactionId: null,
        outcome,
        // The IPN carries neither, and the authoritative lookup supplies both.
        amount: null,
        currency: null,
        correlationValue: null,
      };
    },

    async getPaymentStatus(
      input: GetPaymentStatusInput
    ): Promise<ProviderPaymentStatus> {
      const auth = requireAuth(input.merchantId, input.credential);
      if (!input.correlationValue) {
        throw new PaymentProviderError(
          SUMIT_PROVIDER,
          "NO_LOOKUP_KEY",
          "SUMIT status query needs the Dubiz correlation value."
        );
      }
      return resolveAuthoritativePayment(
        auth,
        buildCorrelationValue(input.correlationValue)
      );
    },
  };
}

/**
 * Refund a SUMIT payment.
 *
 * SUMIT has no refund endpoint, and the word does not appear in its API at all.
 * The mechanism — found in their own WooCommerce plugin and confirmed in the
 * sandbox — is a CHARGE with negative item prices and `SupportCredit: true`,
 * billed against the customer's STORED payment method. No card number and no
 * CVV is sent, which is the property that matters: refunding must not drag Dubiz
 * into card-data scope.
 *
 * A partial refund is simply a smaller negative amount. Both a partial and a
 * full remaining-balance refund were verified against the sandbox.
 *
 * Kept as a standalone function rather than an adapter method because the
 * domain has no refund seam yet; adding one is a separate piece of work and
 * inventing it here would be a redesign nobody asked for.
 */
export async function refundSumitPayment(
  options: SumitProviderOptions,
  input: {
    merchantId: string | null;
    credential: string | null;
    customerId: number;
    amount: string;
    currency: string;
    description?: string | null;
  }
): Promise<{ refundPaymentId: string | null; outcome: ParsedPaymentOutcome }> {
  const companyId = parseCompanyId(input.merchantId);
  const cred = parseCredential(input.credential);
  if (companyId === null || !cred) {
    throw new PaymentProviderError(
      SUMIT_PROVIDER,
      "MISSING_CREDENTIALS",
      "The SUMIT connection is missing its company id or API key."
    );
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaymentProviderError(
      SUMIT_PROVIDER,
      "INVALID_REFUND_AMOUNT",
      "A refund amount must be a positive number."
    );
  }
  if (!SUMIT_SUPPORTED_CURRENCIES.includes(input.currency)) {
    throw new PaymentProviderError(
      SUMIT_PROVIDER,
      "UNSUPPORTED_CURRENCY",
      `SUMIT cannot refund in ${input.currency}.`
    );
  }

  const fetchImpl: SumitHttpClient =
    options.fetchImpl ??
    ((url, init) => (globalThis.fetch as unknown as SumitHttpClient)(url, init));
  const base = (options.baseUrl ?? SUMIT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs =
    typeof options.requestTimeoutMs === "number" &&
    Number.isFinite(options.requestTimeoutMs) &&
    options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : SUMIT_DEFAULT_TIMEOUT_MS;

  const body = {
    Credentials: { CompanyID: companyId, APIKey: cred.apiKey },
    Customer: { ID: input.customerId },
    Items: [
      {
        Item: {
          Name: input.description ?? "Refund",
          SearchMode: "Automatic",
        },
        Quantity: 1,
        UnitPrice: -Math.abs(amount),
        Currency: input.currency,
      },
    ],
    SupportCredit: true,
    VATIncluded: true,
    // No PaymentMethod block: SUMIT bills the customer's stored method, so no
    // PAN and no CVV leaves Dubiz.
  };

  let res: SumitHttpResponse;
  try {
    res = await withDeadline(
      (signal) =>
        fetchImpl(`${base}${PAYMENTS_CHARGE_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-OG-Client": "Dubiz",
          },
          body: JSON.stringify(body),
          signal,
        }),
      timeoutMs
    );
  } catch {
    throw new PaymentProviderError(
      SUMIT_PROVIDER,
      "HTTP_ERROR",
      "SUMIT refund failed (network or timeout)."
    );
  }
  if (!res.ok) {
    throw new PaymentProviderError(
      SUMIT_PROVIDER,
      "HTTP_STATUS",
      `SUMIT refund failed (status ${res.status}).`
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new PaymentProviderError(
      SUMIT_PROVIDER,
      "BAD_RESPONSE",
      "SUMIT returned a refund response that was not JSON."
    );
  }
  if (get(json, "Status") !== 0) {
    const message = asString(get(json, "UserErrorMessage")) ?? "unspecified error";
    throw new PaymentProviderError(
      SUMIT_PROVIDER,
      "PROVIDER_ERROR",
      `SUMIT refused the refund: ${message}`
    );
  }

  const payment = get(get(json, "Data"), "Payment");
  const id = asString(get(payment, "ID"));
  const valid = get(payment, "ValidPayment");
  const status = asString(get(payment, "Status"));
  const settled = valid === true && status === SUCCESS_STATUS_CODE;

  return {
    refundPaymentId: id,
    outcome: settled ? "PAID" : "UNKNOWN",
  };
}

/** Default instance registered in the provider registry (global fetch + env). */
export const sumitProvider: PaymentProviderAdapter = createSumitProvider();

/**
 * Declarative descriptor. Two values make up a SUMIT connection: the CompanyID,
 * which is the merchant identifier, and the private API key, which is the
 * secret. `refund` is true because the mechanism is implemented and proven;
 * `tokens` stays false because nothing here creates or uses card tokens.
 */
export const sumitDescriptor: ProviderDescriptor = {
  key: SUMIT_PROVIDER,
  label: "SUMIT",
  merchantIdField: { key: "companyId", label: "Company ID" },
  credentialFields: [
    { key: "apiKey", label: "API Key (private)", type: "secret", required: true },
  ],
  capabilities: {
    hostedCheckout: true,
    verification: true,
    refund: true,
    sandbox: true,
    webhooks: true,
    tokens: false,
  },
  supportedCurrencies: SUMIT_SUPPORTED_CURRENCIES,
};

