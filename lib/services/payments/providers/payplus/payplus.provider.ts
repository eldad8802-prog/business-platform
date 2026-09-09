/**
 * PayPlus provider — the second real acquirer, and the test of whether the
 * provider abstraction actually holds for something that is not CardCom.
 *
 * It differs from CardCom in the two places that matter:
 *   - it publishes a REAL webhook signature (HMAC-SHA256), keyed by the
 *     MERCHANT's own secret, so authentication is merchant-scoped rather than
 *     structural — this is why `authenticateWebhook` exists;
 *   - it has a genuinely SEPARATE sandbox host, rather than a test terminal on
 *     the live host, so a Preview environment can be pointed somewhere safe.
 *
 * Baseline scope only: connect, create a hosted payment, authenticate a
 * callback, and verify the outcome authoritatively. No refunds, tokens,
 * recurring or installments — none of those are attempted or implied here.
 *
 * Card data: Dubiz never handles it. The cardholder pays on PayPlus's hosted
 * page; this adapter builds the link and reads result metadata.
 *
 * Documentation basis (docs.payplus.co.il, fetched 2026-09-09):
 *   - environments      /reference/payplus-rest-api-urls
 *   - generate link     POST /PaymentPages/generateLink
 *   - callback shape    /reference/get_yourdomain-yourendpoint
 *   - signature         /reference/validate-requests-received-from-payplus
 *   - status query      POST /Transactions/View
 *   - currencies        GET  /Currencies
 *
 * ⚠️ DOCS-CONFIRM, and the reason this provider ships DISABLED: the signature
 * documentation shows the message as `JSON.stringify(response.body)` — a
 * RE-SERIALISED object, not the raw bytes — which does not pin down the exact
 * string being signed. `verifyPayPlusSignature` handles both readings and says
 * why. The ambiguity must be settled against a real sandbox callback before
 * PayPlus is enabled anywhere.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { PaymentProvider } from "../../payments.types";
import {
  PaymentProviderError,
  type AuthenticateWebhookInput,
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
import type { ProviderDescriptor } from "../provider-descriptor.types";

const PAYPLUS_PROVIDER: PaymentProvider = "PAYPLUS";

const SANDBOX_BASE_URL = "https://restapidev.payplus.co.il/api/v1.0";
const PRODUCTION_BASE_URL = "https://restapi.payplus.co.il/api/v1.0";

const GENERATE_LINK_PATH = "/PaymentPages/generateLink";
const TRANSACTIONS_VIEW_PATH = "/Transactions/View";

/** PayPlus success status code, per the documented callback and view shapes. */
const SUCCESS_STATUS_CODE = "000";

/**
 * Currencies PayPlus documents as supported system-wide (GET /Currencies).
 *
 * A STATIC list is declared rather than fetched, deliberately. The currency
 * gate runs before a PaymentRequest row exists and must be able to refuse
 * without a network call; an adapter that had to ask the provider first could
 * not fail closed when the provider is unreachable. The documented list is the
 * conservative choice: a currency missing from it is refused rather than
 * attempted, which is the safe direction to be wrong in.
 *
 * PayPlus additionally notes that the merchant's card issuer must support the
 * currency — that is a merchant-level fact this adapter cannot know, and it is
 * why a listed currency is still only ATTEMPTED, never promised.
 */
export const PAYPLUS_SUPPORTED_CURRENCIES: readonly string[] = Object.freeze([
  "ILS",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "DKK",
  "NOK",
  "ZAR",
  "SEK",
  "CHF",
  "JOD",
  "LBP",
  "EGP",
]);

// --- injectable HTTP (mocked in tests; defaults to global fetch) -----------

export interface PayPlusHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type PayPlusHttpClient = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<PayPlusHttpResponse>;

export interface PayPlusProviderOptions {
  fetchImpl?: PayPlusHttpClient;
  /** Explicit base URL. Overrides environment resolution; used by tests. */
  baseUrl?: string;
  publicBaseUrl?: string;
  /**
   * Deadline for a single PayPlus HTTP call. Tests set it low; production uses
   * `PAYPLUS_DEFAULT_TIMEOUT_MS`. A non-finite or non-positive value falls back
   * to the default rather than disabling the deadline — "wait forever" is not an
   * outcome this provider is allowed to have.
   */
  requestTimeoutMs?: number;
}

/**
 * Default per-request deadline.
 *
 * Sits below the platform's serverless function limit so that a provider hang
 * surfaces as OUR bounded error — which every caller already treats as "not
 * settled" — rather than as the platform killing the function mid-flight with
 * no record of what happened. Deliberately generous: a hosted-page creation
 * that is merely slow must still be allowed to succeed, because abandoning it
 * early can leave a payment page live at PayPlus for which Dubiz holds no
 * `providerRequestId`.
 */
export const PAYPLUS_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Run one HTTP attempt under a hard deadline.
 *
 * Two mechanisms, on purpose. The `AbortSignal` asks the transport to release
 * the socket, which is the clean path; the race is what guarantees the deadline
 * is actually observed even when the transport ignores the signal — a real
 * possibility for an injected client, and precisely the case where an unbounded
 * wait would hold a tenant transaction open.
 *
 * On timeout this REJECTS. It never resolves to a synthetic response: no caller
 * may be able to mistake "we stopped waiting" for "the provider answered".
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
      reject(new Error(`PayPlus request exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  // NOT `unref`ed, deliberately. An unref'd timer does not hold the event loop
  // open, so while a slow provider is being awaited the loop can look empty and
  // the process exits silently with code 0 — mid-request, mid-transaction, and
  // with no error anywhere. This timer is always cleared in the `finally` below,
  // so it can never outlive the request it bounds.
  try {
    return await Promise.race([attempt(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// --- credential model ------------------------------------------------------

/**
 * The encrypted credential blob for a PayPlus connection.
 *
 * `payment_page_uid` is the merchant/terminal identifier and lives in the
 * `merchantId` column, not here. `secretKey` is both an API credential AND the
 * webhook signing key, which is exactly why webhook authentication cannot
 * happen before the tenant is known.
 */
interface PayPlusCredential {
  apiKey: string;
  secretKey: string;
}

function parseCredential(raw: string | null): PayPlusCredential | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.apiKey === "string" &&
      obj.apiKey &&
      typeof obj.secretKey === "string" &&
      obj.secretKey
    ) {
      return { apiKey: obj.apiKey, secretKey: obj.secretKey };
    }
  } catch {
    // fall through
  }
  return null;
}

// --- base URL resolution: fail closed, never silently live -----------------

/**
 * Resolve the PayPlus host.
 *
 * This is written the way it is because of a defect found in the CardCom
 * adapter: its base URL fell back to the LIVE host whenever the override was
 * unset, which meant a non-Production environment would quietly talk to the
 * production acquirer. That must not be repeated here.
 *
 * The rules, in order:
 *   1. an explicit `PAYPLUS_BASE_URL` wins, and must be one of the two hosts
 *      PayPlus documents — an arbitrary URL is refused rather than trusted;
 *   2. with no override, the PRODUCTION host is used only when the runtime is
 *      genuinely production;
 *   3. every other environment falls back to SANDBOX.
 *
 * So the failure mode of a missing variable is "talks to sandbox", not "takes
 * a real payment".
 */
export function resolvePayPlusBaseUrl(env: NodeJS.ProcessEnv): string {
  const override = (env.PAYPLUS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (override) {
    if (override === SANDBOX_BASE_URL || override === PRODUCTION_BASE_URL) {
      return override;
    }
    throw new PaymentProviderError(
      PAYPLUS_PROVIDER,
      "INVALID_BASE_URL",
      "PAYPLUS_BASE_URL must be exactly the documented PayPlus sandbox or production host."
    );
  }
  // No override. Only a real production runtime may reach the live host.
  const vercelEnv = (env.VERCEL_ENV ?? "").toLowerCase();
  const nodeEnv = (env.NODE_ENV ?? "").toLowerCase();
  const isProduction =
    vercelEnv === "production" || (vercelEnv === "" && nodeEnv === "production");
  return isProduction ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
}

// --- signature verification ------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length through an exception. Compare lengths first and still run the
  // constant-time compare on equal-length inputs.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hmacBase64(message: string, secret: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("base64");
}

/**
 * Verify a PayPlus callback signature.
 *
 * PayPlus documents two things a caller must satisfy: a `user-agent` of
 * exactly `PayPlus`, and a `hash` header holding the base64 HMAC-SHA256 of the
 * body under the merchant's secret key.
 *
 * THE AMBIGUITY, stated rather than hidden. The published sample computes the
 * message as `JSON.stringify(response.body)` — i.e. over a body that has
 * already been parsed and re-serialised, not over the bytes on the wire. Those
 * two strings are usually identical and sometimes are not: any difference in
 * whitespace or number formatting between PayPlus's serialiser and Node's
 * changes the message and therefore the hash. The specification does not say
 * which one is authoritative.
 *
 * Both candidates are therefore accepted, and that is not a weakening: each
 * candidate still requires possession of the merchant's secret key, so the set
 * of forgeable messages does not grow. What it avoids is rejecting a genuine
 * callback — which, for a settlement path, is the more damaging failure.
 *
 * This is DOCS-CONFIRM work, and it is the specific reason PayPlus ships
 * disabled: once a real sandbox callback shows which form PayPlus actually
 * signs, the other candidate should be deleted.
 */
export function verifyPayPlusSignature(input: {
  rawBody: string;
  headers: Record<string, string | null | undefined>;
  secretKey: string;
}): VerifyWebhookResult {
  const userAgent = input.headers["user-agent"];
  if (userAgent !== "PayPlus") {
    return { ok: false, reason: "unexpected_user_agent" };
  }

  const provided = input.headers["hash"];
  if (typeof provided !== "string" || provided.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }

  // Candidate 1 — the raw bytes as received. This is what every other signed
  // webhook in this codebase verifies against, and the only reading that is
  // robust to a serialiser disagreement.
  if (safeEqual(hmacBase64(input.rawBody, input.secretKey), provided)) {
    return { ok: true };
  }

  // Candidate 2 — the documented sample's re-serialised form.
  let canonical: string | null = null;
  try {
    canonical = JSON.stringify(JSON.parse(input.rawBody));
  } catch {
    canonical = null;
  }
  if (
    canonical !== null &&
    canonical !== input.rawBody &&
    safeEqual(hmacBase64(canonical, input.secretKey), provided)
  ) {
    return { ok: true };
  }

  return { ok: false, reason: "signature_mismatch" };
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
 * The fields a PayPlus callback carries, flattened.
 *
 * PayPlus nests the payment under `transaction`, but has been observed in its
 * own documentation to describe fields both nested and at the top level, so
 * both are read. Nothing here is trusted — this is parsing, not authority.
 */
export interface PayPlusCallbackFields {
  transactionUid: string | null;
  pageRequestUid: string | null;
  statusCode: string | null;
  amount: string | null;
  currency: string | null;
  moreInfo: string | null;
}

export function extractPayPlusCallbackFields(
  input: ParseWebhookInput
): PayPlusCallbackFields {
  let body: unknown = null;
  if (input.parsedBody && typeof input.parsedBody === "object") {
    body = input.parsedBody;
  } else {
    try {
      body = JSON.parse(input.rawBody ?? "");
    } catch {
      body = null;
    }
  }

  const tx = get(body, "transaction") ?? body;

  return {
    transactionUid: asString(get(tx, "uid") ?? get(body, "transaction_uid")),
    pageRequestUid: asString(
      get(tx, "payment_request_uid") ?? get(body, "page_request_uid")
    ),
    statusCode: asString(get(tx, "status_code") ?? get(body, "status_code")),
    amount: asString(get(tx, "amount")),
    currency: asString(get(tx, "currency")),
    moreInfo: asString(get(tx, "more_info") ?? get(body, "more_info")),
  };
}

/**
 * Interpret a `/Transactions/View` result into an outcome.
 *
 * PAID requires an explicit success status code AND a transaction that is not
 * cancelled. Anything the response does not positively establish is UNKNOWN,
 * which the orchestration treats as "do not settle" — never as failure and
 * never as success.
 */
export function interpretPayPlusTransaction(
  result: unknown
): ProviderPaymentStatus {
  const results = get(result, "results");
  const outerStatus = asString(get(results, "status"));

  // The transaction may arrive as a single object or as a list.
  const data = get(result, "data");
  const record = Array.isArray(data) ? (data[0] ?? null) : (data ?? null);

  const transactionUid = asString(get(record, "uid") ?? get(record, "transaction_uid"));
  const statusCode = asString(get(record, "status_code"));
  const cancelled = get(record, "transaction_is_cancelled");

  if (record == null) {
    // The query succeeded but named no transaction: the payment page exists and
    // nothing has been charged against it yet.
    return { outcome: "UNKNOWN", providerTransactionId: null };
  }
  if (cancelled === true) {
    return { outcome: "CANCELLED", providerTransactionId: transactionUid };
  }
  if (statusCode === SUCCESS_STATUS_CODE && outerStatus !== "error") {
    return { outcome: "PAID", providerTransactionId: transactionUid };
  }
  if (statusCode != null && statusCode !== SUCCESS_STATUS_CODE) {
    return { outcome: "FAILED", providerTransactionId: transactionUid };
  }
  return { outcome: "UNKNOWN", providerTransactionId: transactionUid };
}

// --- provider factory ------------------------------------------------------

export function createPayPlusProvider(
  options: PayPlusProviderOptions = {}
): PaymentProviderAdapter {
  const fetchImpl: PayPlusHttpClient =
    options.fetchImpl ??
    ((url, init) =>
      (globalThis.fetch as unknown as PayPlusHttpClient)(url, init));

  const baseUrl = (): string =>
    options.baseUrl?.replace(/\/+$/, "") ?? resolvePayPlusBaseUrl(process.env);

  // Fail-closed on a nonsense value: an unbounded wait is not a configuration
  // this provider offers, so 0, a negative, or NaN resolves to the default.
  const requestTimeoutMs =
    typeof options.requestTimeoutMs === "number" &&
    Number.isFinite(options.requestTimeoutMs) &&
    options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : PAYPLUS_DEFAULT_TIMEOUT_MS;

  const resolvePublicBaseUrl = (): string | null => {
    const v = options.publicBaseUrl ?? process.env.PAYMENTS_PUBLIC_BASE_URL ?? null;
    return v ? v.replace(/\/+$/, "") : null;
  };

  async function post(
    path: string,
    credential: PayPlusCredential,
    body: unknown
  ): Promise<unknown> {
    let res: PayPlusHttpResponse;
    try {
      // BOUNDED. A provider that accepts the connection and then never answers
      // would otherwise hold a webhook — and its tenant transaction — open
      // indefinitely. The deadline turns that into an ordinary network error,
      // which the authority path already treats as "not settled" rather than as
      // success. Never invent an outcome from a timeout.
      res = await withDeadline(
        (signal) =>
          fetchImpl(`${baseUrl()}${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              // Per-merchant credentials, sent server-side only.
              "api-key": credential.apiKey,
              "secret-key": credential.secretKey,
            },
            body: JSON.stringify(body),
            signal,
          }),
        requestTimeoutMs
      );
    } catch {
      throw new PaymentProviderError(
        PAYPLUS_PROVIDER,
        "HTTP_ERROR",
        "PayPlus request failed (network or timeout)."
      );
    }
    if (!res.ok) {
      throw new PaymentProviderError(
        PAYPLUS_PROVIDER,
        "HTTP_STATUS",
        `PayPlus request failed (status ${res.status}).`
      );
    }
    try {
      return await res.json();
    } catch {
      throw new PaymentProviderError(
        PAYPLUS_PROVIDER,
        "BAD_RESPONSE",
        "PayPlus returned an unparseable response."
      );
    }
  }

  function requireCredential(
    merchantId: string | null,
    raw: string | null
  ): PayPlusCredential {
    const credential = parseCredential(raw);
    if (!merchantId || !credential) {
      throw new PaymentProviderError(
        PAYPLUS_PROVIDER,
        "MISSING_CREDENTIALS",
        "PayPlus connection is missing its payment page id or API credentials."
      );
    }
    return credential;
  }

  return {
    provider: PAYPLUS_PROVIDER,
    supportedCurrencies: PAYPLUS_SUPPORTED_CURRENCIES,

    async createPaymentLink(
      input: CreatePaymentLinkInput
    ): Promise<CreatePaymentLinkResult> {
      const credential = requireCredential(input.merchantId, input.credential);
      const publicBaseUrl = resolvePublicBaseUrl();
      if (!publicBaseUrl) {
        throw new PaymentProviderError(
          PAYPLUS_PROVIDER,
          "MISSING_PUBLIC_BASE_URL",
          "PAYMENTS_PUBLIC_BASE_URL is required to build the PayPlus callback URL."
        );
      }

      // The currency gate in the request service has already refused anything
      // outside `supportedCurrencies`; this is the adapter's own fail-closed
      // restatement, so the rule holds however the adapter is reached.
      if (!PAYPLUS_SUPPORTED_CURRENCIES.includes(input.currency)) {
        throw new PaymentProviderError(
          PAYPLUS_PROVIDER,
          "UNSUPPORTED_CURRENCY",
          `PayPlus cannot be charged in ${input.currency}.`
        );
      }

      const result = await post(GENERATE_LINK_PATH, credential, {
        payment_page_uid: input.merchantId,
        // Documented as a JSON number in decimal units, not minor units.
        amount: Number(input.amount),
        currency_code: input.currency,
        sendEmailApproval: false,
        sendEmailFailure: false,
        // Canonical correlation: our PaymentRequest id round-trips via
        // more_info, exactly as CardCom's ReturnValue does. It is also the key
        // the authoritative lookup can search by.
        more_info: String(input.paymentRequestId),
        refURL_success: input.successUrl ?? `${publicBaseUrl}/?payment=success`,
        refURL_failure: input.failureUrl ?? `${publicBaseUrl}/?payment=failed`,
        refURL_callback: `${publicBaseUrl}/api/payments/webhook/payplus`,
      });

      const data = get(result, "data") ?? result;
      const link = asString(get(data, "payment_page_link"));
      const pageRequestUid = asString(get(data, "page_request_uid"));

      if (!link || !pageRequestUid) {
        throw new PaymentProviderError(
          PAYPLUS_PROVIDER,
          "CREATE_FAILED",
          "PayPlus did not return a payment page link."
        );
      }

      return {
        paymentUrl: link,
        providerRequestId: pageRequestUid,
        expiresAt: input.expiresAt ?? null,
      };
    },

    // Pre-correlation structural gate ONLY. PayPlus's real authentication is
    // merchant-scoped and therefore lives in `authenticateWebhook` below; this
    // step exists to reject a body that could not possibly be a PayPlus
    // callback before the system spends a lookup on it. It deliberately does
    // NOT accept-by-default: a body with no usable correlation identifier is
    // refused here.
    async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
      if (input.headers["user-agent"] !== "PayPlus") {
        return { ok: false, reason: "unexpected_user_agent" };
      }
      if (typeof input.headers["hash"] !== "string" || !input.headers["hash"]) {
        return { ok: false, reason: "missing_signature" };
      }
      const fields = extractPayPlusCallbackFields({ rawBody: input.rawBody });
      if (!fields.pageRequestUid) {
        return { ok: false, reason: "missing_page_request_uid" };
      }
      return { ok: true };
    },

    // The real authentication, run once the callback has been correlated to a
    // stored PaymentRequest and that business's key is known. Exactly one key
    // is ever tried.
    async authenticateWebhook(
      input: AuthenticateWebhookInput
    ): Promise<VerifyWebhookResult> {
      const credential = parseCredential(input.credential);
      if (!credential) {
        return { ok: false, reason: "merchant_credential_unavailable" };
      }
      return verifyPayPlusSignature({
        rawBody: input.rawBody,
        headers: input.headers,
        secretKey: credential.secretKey,
      });
    },

    parseWebhook(input: ParseWebhookInput): ParsedWebhookEvent {
      const fields = extractPayPlusCallbackFields(input);

      // The callback is a SIGNAL. Its status code is never turned into PAID
      // here — only `/Transactions/View` may establish that. A usable body
      // yields PENDING, which prompts verification; an unusable one yields
      // UNKNOWN, which the orchestration refuses before any write.
      const usable = fields.pageRequestUid != null;
      const outcome: ParsedPaymentOutcome = usable ? "PENDING" : "UNKNOWN";

      return {
        // A transaction uid is per-settlement and is the right idempotency key;
        // the page request uid is per-session and would wrongly collapse two
        // legitimate deliveries for the same request into one.
        providerEventId: fields.transactionUid ?? fields.pageRequestUid,
        eventType: "payplus_callback",
        providerRequestId: fields.pageRequestUid,
        providerTransactionId: fields.transactionUid,
        outcome,
        amount: fields.amount,
        currency: fields.currency,
        // Our own PaymentRequest id, round-tripped through more_info.
        correlationValue: fields.moreInfo,
      };
    },

    async getPaymentStatus(
      input: GetPaymentStatusInput
    ): Promise<ProviderPaymentStatus> {
      const credential = requireCredential(input.merchantId, input.credential);

      // AUTHORITY. `/Transactions/View` documents `transaction_uid` and
      // `more_info` as search keys, but NOT `page_request_uid` — which is what
      // `providerRequestId` holds for PayPlus. So the query is built from the
      // transaction id when the callback carried one, and otherwise from our
      // own correlation value. Without Gap B's addition to this input, PayPlus
      // could not answer this question at all.
      const query: Record<string, unknown> = {};
      if (input.providerTransactionId) {
        query.transaction_uid = input.providerTransactionId;
      } else if (input.correlationValue) {
        query.more_info = input.correlationValue;
      } else {
        throw new PaymentProviderError(
          PAYPLUS_PROVIDER,
          "NO_LOOKUP_KEY",
          "PayPlus status query needs a transaction id or a correlation value."
        );
      }

      const result = await post(TRANSACTIONS_VIEW_PATH, credential, query);
      return interpretPayPlusTransaction(result);
    },
  };
}

/** Default instance registered in the provider registry (global fetch + env). */
export const payPlusProvider: PaymentProviderAdapter = createPayPlusProvider();

/**
 * Declarative descriptor. Three values make up a PayPlus connection: the
 * payment page uid (the merchant identifier) plus the api key and secret key,
 * both stored inside the encrypted credential blob. `refund` and `tokens` stay
 * false — this is a baseline integration and the flags describe what is built,
 * not what the provider could theoretically do.
 */
export const payPlusDescriptor: ProviderDescriptor = {
  key: PAYPLUS_PROVIDER,
  label: "PayPlus",
  merchantIdField: { key: "paymentPageUid", label: "Payment Page UID" },
  credentialFields: [
    { key: "apiKey", label: "API Key", type: "secret", required: true },
    { key: "secretKey", label: "Secret Key", type: "secret", required: true },
  ],
  capabilities: {
    hostedCheckout: true,
    verification: true,
    refund: false,
    sandbox: true,
    webhooks: true,
    tokens: false,
  },
  supportedCurrencies: PAYPLUS_SUPPORTED_CURRENCIES,
};
