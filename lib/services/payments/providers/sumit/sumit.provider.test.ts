/**
 * Run: npx tsx lib/services/payments/providers/sumit/sumit.provider.test.ts
 *
 * The SUMIT adapter.
 *
 * Every expectation here is anchored to what the live sandbox actually did on
 * 2026-09-15, not to the published schema — the two disagree in three places
 * and the disagreements are the interesting part:
 *
 *   - `IPNURL` is not in the schema, whose request object declares
 *     `additionalProperties: false`, yet the live API accepted it and called it.
 *   - the IPN's content type is `text/plain` and its body is form-encoded.
 *   - the clearings filter rejects the numeric property id the schema endpoint
 *     hands you and requires the property NAME.
 *
 * Everything runs against an injected HTTP client. No network, no credentials,
 * no SUMIT account.
 */
import assert from "node:assert/strict";

import {
  PaymentProviderError,
} from "../payment-provider.types";
import {
  SUMIT_DEFAULT_TIMEOUT_MS,
  SUMIT_SUPPORTED_CURRENCIES,
  buildCorrelationValue,
  createSumitProvider,
  extractSumitCallbackFields,
  interpretClearingMatches,
  interpretSumitPayment,
  refundSumitPayment,
  sumitDescriptor,
  withDeadline,
  type SumitHttpClient,
} from "./sumit.provider";

const BASE = "https://api.sumit.co.il";
const CREDENTIAL = JSON.stringify({ apiKey: "test-api-key" });
const COMPANY = "1234567890";
const SECRET = "x".repeat(43);

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Replies in order; extra calls repeat the last reply. */
function recorder(...responses: unknown[]): {
  calls: Call[];
  fetchImpl: SumitHttpClient;
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: SumitHttpClient = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

const LINK_OK = {
  Status: 0,
  Data: { RedirectURL: "https://pay.sumit.co.il/abc/a/redirectpayment/?redirectid=xyz" },
};
const ONE_CLEARING = { Status: 0, Data: { Entities: [{ ID: 2363103378 }] } };
const NO_CLEARING = { Status: 0, Data: { Entities: [] } };
const TWO_CLEARINGS = { Status: 0, Data: { Entities: [{ ID: 1 }, { ID: 2 }] } };
const PAID_PAYMENT = {
  Status: 0,
  Data: {
    Payment: {
      ID: 2363103378,
      CustomerID: 2362366786,
      ValidPayment: true,
      Status: "000",
      Amount: 10,
      Currency: 0,
    },
  },
};

function makeProvider(fetchImpl: SumitHttpClient, extra: Record<string, unknown> = {}) {
  return createSumitProvider({
    fetchImpl,
    baseUrl: BASE,
    publicBaseUrl: "https://app.example",
    ...extra,
  });
}

const LINK_INPUT = {
  businessId: 7,
  paymentRequestId: 4242,
  amount: "10.00",
  currency: "ILS",
  description: "Invoice #12",
  merchantId: COMPANY,
  credential: CREDENTIAL,
  callbackSecret: SECRET,
};

async function main() {
  // ── CHECKOUT ────────────────────────────────────────────────────────────
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    const result = await makeProvider(fetchImpl).createPaymentLink(LINK_INPUT);

    ok("returns the hosted payment page URL", result.paymentUrl === LINK_OK.Data.RedirectURL);
    ok(
      "returns NO provider id, because SUMIT issues none",
      result.providerRequestId === null
    );
    ok("exactly one HTTP call", calls.length === 1);
    ok(
      "posts to the documented beginredirect path",
      calls[0]!.url === `${BASE}/billing/payments/beginredirect/`
    );

    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    const creds = sent.Credentials as Record<string, unknown>;
    ok("credentials travel in the BODY, which is the only shape SUMIT accepts", creds.CompanyID === 1234567890);
    ok("the company id is sent as a NUMBER, not a string", typeof creds.CompanyID === "number");
    ok("the API key is present", creds.APIKey === "test-api-key");
    ok(
      "no credential appears in the URL",
      !calls[0]!.url.includes("test-api-key") && !calls[0]!.url.includes(COMPANY)
    );

    ok(
      "our correlation value is sent as ExternalIdentifier",
      sent.ExternalIdentifier === "dubiz-4242"
    );
    ok("the amount is a decimal NUMBER, not minor units", (sent.Items as Array<Record<string, unknown>>)[0]!.UnitPrice === 10);
    ok("the currency is sent per item", (sent.Items as Array<Record<string, unknown>>)[0]!.Currency === "ILS");

    // The field under test.
    ok(
      "IPNURL is sent, even though the published schema forbids unknown fields",
      typeof sent.IPNURL === "string"
    );
    ok(
      "the callback secret is the final PATH segment of IPNURL",
      String(sent.IPNURL).endsWith("/api/payments/webhook/sumit/" + SECRET)
    );
    ok(
      "the callback secret is never a query parameter",
      !String(sent.IPNURL).includes("?")
    );
    ok("a success redirect is registered", typeof sent.RedirectURL === "string");
    ok("a cancel redirect is registered", typeof sent.CancelRedirectURL === "string");
    ok(
      "no card data is ever sent",
      !/cardnumber|"cvv"|"pan"|card_number/i.test(calls[0]!.body)
    );
  }

  // Checkout refuses rather than creating something unattributable.
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    await assert.rejects(
      () => makeProvider(fetchImpl).createPaymentLink({ ...LINK_INPUT, callbackSecret: null }),
      /callback secret/i
    );
    ok("without a callback secret, checkout is refused", calls.length === 0);
  }
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    await assert.rejects(
      () => makeProvider(fetchImpl).createPaymentLink({ ...LINK_INPUT, merchantId: null }),
      /company id or API key/i
    );
    ok("without a company id, checkout is refused before any call", calls.length === 0);
  }
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    let message = "";
    try {
      await makeProvider(fetchImpl).createPaymentLink({
        ...LINK_INPUT,
        credential: "corrupt-not-json",
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    ok("an undecryptable credential is refused", message !== "");
    ok("and nothing reached SUMIT", calls.length === 0);
    ok("and the error repeats no credential material", !message.includes("corrupt-not-json"));
  }
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    await assert.rejects(
      () => makeProvider(fetchImpl).createPaymentLink({ ...LINK_INPUT, currency: "EUR" }),
      /cannot be charged in EUR/
    );
    ok("an unsupported currency is refused", calls.length === 0);
    ok(
      "supported currencies are the aggregator's real set",
      SUMIT_SUPPORTED_CURRENCIES.join(",") === "ILS,USD"
    );
  }
  {
    // SUMIT answers HTTP 200 for business errors and signals them in the
    // envelope. A caller checking only the HTTP status would read failure as
    // success — this is the single easiest way to get the integration wrong.
    const { fetchImpl } = recorder({ Status: 1, UserErrorMessage: "terminal not configured" });
    await assert.rejects(
      () => makeProvider(fetchImpl).createPaymentLink(LINK_INPUT),
      /terminal not configured/
    );
    ok("HTTP 200 with envelope Status 1 is a failure, not a success", true);
  }
  {
    const { fetchImpl } = recorder({ Status: 0, Data: {} });
    await assert.rejects(
      () => makeProvider(fetchImpl).createPaymentLink(LINK_INPUT),
      /did not return a payment page link/
    );
    ok("a response with no link is a hard failure", true);
  }

  // ── IPN PARSING ─────────────────────────────────────────────────────────
  //
  // The observed delivery: POST, Content-Type text/plain, body form-encoded.
  {
    const raw = "customerid=2362366786&documentid=2363103388&valid=true";
    const fields = extractSumitCallbackFields({ rawBody: raw });
    ok("a form-encoded body parses despite the text/plain content type", fields.documentId === "2363103388");
    ok("the customer id is read", fields.customerId === "2362366786");
    ok("the validity flag is read", fields.valid === "true");

    const parsed = makeProvider(recorder().fetchImpl).parseWebhook({ rawBody: raw });
    ok("the document id becomes the idempotency key", parsed.providerEventId === "2363103388");
    ok(
      "the outcome is PENDING — a callback may never assert PAID",
      parsed.outcome === "PENDING"
    );
    ok(
      "no provider request id is claimed, because SUMIT issues none",
      parsed.providerRequestId === null
    );
    ok(
      "the payload's own validity flag is NOT turned into an outcome",
      parsed.outcome !== "PAID" && parsed.outcome !== "FAILED"
    );
    ok("no amount is taken from the callback", parsed.amount === null);
    ok("no currency is taken from the callback", parsed.currency === null);
  }
  {
    // A future SUMIT change to an honest content type must not break it.
    const fields = extractSumitCallbackFields({
      rawBody: JSON.stringify({ customerid: 1, documentid: 2, valid: true }),
    });
    ok("a JSON body parses too", fields.documentId === "2" && fields.customerId === "1");
  }
  {
    const fields = extractSumitCallbackFields({
      rawBody: "CustomerID=5&DocumentID=6&Valid=true",
    });
    ok("field names are read case-insensitively", fields.documentId === "6");
  }
  {
    const provider = makeProvider(recorder().fetchImpl);
    for (const [label, raw] of [
      ["an empty body", ""],
      ["a non-form, non-JSON body", "!!!"],
      ["a JSON array", "[1,2,3]"],
    ] as [string, string][]) {
      const parsed = provider.parseWebhook({ rawBody: raw });
      ok(`${label} yields UNKNOWN and never throws`, parsed.outcome === "UNKNOWN");
      const verdict = await provider.verifyWebhook({ rawBody: raw, headers: {} });
      ok(`${label} fails the structural gate`, verdict.ok === false);
    }
    const good = await provider.verifyWebhook({
      rawBody: "customerid=1&documentid=2&valid=true",
      headers: {},
    });
    ok("a plausible callback passes the structural gate", good.ok === true);
  }

  // ── AUTHORITATIVE RECONCILIATION ────────────────────────────────────────
  {
    const { calls, fetchImpl } = recorder(ONE_CLEARING, PAID_PAYMENT);
    const status = await makeProvider(fetchImpl).getPaymentStatus!({
      providerRequestId: null,
      merchantId: COMPANY,
      credential: CREDENTIAL,
      correlationValue: "4242",
    });

    ok("two calls: find the clearing, then read the payment", calls.length === 2);
    ok(
      "the first call queries the clearings folder",
      calls[0]!.url === `${BASE}/crm/data/listentities/`
    );

    const query = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    ok("it names the credit-card clearings folder", query.Folder === "סליקות אשראי");
    const filters = query.Filters as Array<Record<string, unknown>>;
    ok(
      "it filters by the property NAME, which is the only form the live API accepts",
      filters[0]!.Property === "מזהה חיצוני"
    );
    ok(
      "it filters on OUR correlation value",
      filters[0]!.Value === "dubiz-4242"
    );

    const lookup = JSON.parse(calls[1]!.body) as Record<string, unknown>;
    ok(
      "the second call reads the payment by the id the query produced",
      calls[1]!.url === `${BASE}/billing/payments/get/` && lookup.PaymentID === 2363103378
    );

    ok("the outcome is PAID", status.outcome === "PAID");
    ok("and carries the provider payment id", status.providerTransactionId === "2363103378");
  }
  {
    // Zero rows: created but not paid. Not a failure.
    const { calls, fetchImpl } = recorder(NO_CLEARING);
    const status = await makeProvider(fetchImpl).getPaymentStatus!({
      providerRequestId: null,
      merchantId: COMPANY,
      credential: CREDENTIAL,
      correlationValue: "4242",
    });
    ok("no clearing yet yields UNKNOWN, never FAILED", status.outcome === "UNKNOWN");
    ok("and the payment lookup is not attempted", calls.length === 1);
  }
  {
    // More than one row: ambiguous. Choosing one could settle the wrong request.
    const { calls, fetchImpl } = recorder(TWO_CLEARINGS);
    await assert.rejects(
      () =>
        makeProvider(fetchImpl).getPaymentStatus!({
          providerRequestId: null,
          merchantId: COMPANY,
          credential: CREDENTIAL,
          correlationValue: "4242",
        }),
      /refusing to choose/
    );
    ok("two clearings for one correlation fail closed", calls.length === 1);
  }
  {
    const { fetchImpl } = recorder(ONE_CLEARING, PAID_PAYMENT);
    await assert.rejects(
      () =>
        makeProvider(fetchImpl).getPaymentStatus!({
          providerRequestId: null,
          merchantId: COMPANY,
          credential: CREDENTIAL,
          correlationValue: null,
        }),
      /correlation value/
    );
    ok("without a correlation value the query refuses rather than guessing", true);
  }

  // ── PAYMENT INTERPRETATION ──────────────────────────────────────────────
  {
    ok(
      "valid + status 000 is PAID",
      interpretSumitPayment(PAID_PAYMENT).outcome === "PAID"
    );
    ok(
      "ValidPayment false is FAILED",
      interpretSumitPayment({
        Data: { Payment: { ID: 1, ValidPayment: false, Status: "000" } },
      }).outcome === "FAILED"
    );
    ok(
      "a non-success status code is FAILED",
      interpretSumitPayment({
        Data: { Payment: { ID: 1, ValidPayment: true, Status: "033" } },
      }).outcome === "FAILED"
    );
    ok(
      "a payment that establishes nothing is UNKNOWN, never PAID",
      interpretSumitPayment({ Data: { Payment: { ID: 1 } } }).outcome === "UNKNOWN"
    );
    ok(
      "no payment object is UNKNOWN",
      interpretSumitPayment({ Data: {} }).outcome === "UNKNOWN"
    );
    ok("nonsense is UNKNOWN", interpretSumitPayment("nope").outcome === "UNKNOWN");

    ok("one entity resolves", interpretClearingMatches(ONE_CLEARING).outcome === "ONE");
    ok("zero entities resolve to NONE", interpretClearingMatches(NO_CLEARING).outcome === "NONE");
    ok(
      "two entities resolve to AMBIGUOUS with a count",
      interpretClearingMatches(TWO_CLEARINGS).outcome === "AMBIGUOUS" &&
        interpretClearingMatches(TWO_CLEARINGS).count === 2
    );
    ok(
      "a malformed result is NONE rather than a crash",
      interpretClearingMatches({}).outcome === "NONE"
    );
  }

  // ── CORRELATION VALUE ───────────────────────────────────────────────────
  {
    ok("the correlation value is derived from the request id", buildCorrelationValue(42) === "dubiz-42");
    ok("it is stable across calls", buildCorrelationValue(42) === buildCorrelationValue("42"));
    ok(
      "different requests never share one",
      buildCorrelationValue(1) !== buildCorrelationValue(2)
    );
    ok(
      "it is namespaced, so it cannot collide with another system's identifiers",
      buildCorrelationValue(1).startsWith("dubiz-")
    );
  }

  // ── REFUNDS ─────────────────────────────────────────────────────────────
  {
    const refundOk = {
      Status: 0,
      Data: { Payment: { ID: 999, ValidPayment: true, Status: "000", Amount: -4 } },
    };
    const { calls, fetchImpl } = recorder(refundOk);
    const res = await refundSumitPayment(
      { fetchImpl, baseUrl: BASE },
      {
        merchantId: COMPANY,
        credential: CREDENTIAL,
        customerId: 2362366786,
        amount: "4.00",
        currency: "ILS",
        description: "partial",
      }
    );

    ok("a partial refund settles", res.outcome === "PAID");
    ok("and returns the credit's payment id", res.refundPaymentId === "999");
    ok(
      "it posts to the charge endpoint, because SUMIT has no refund endpoint",
      calls[0]!.url === `${BASE}/billing/payments/charge/`
    );

    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    ok("the amount is NEGATIVE", (sent.Items as Array<Record<string, unknown>>)[0]!.UnitPrice === -4);
    ok("SupportCredit is set, which is what makes it a credit", sent.SupportCredit === true);
    ok("it bills the stored customer", (sent.Customer as Record<string, unknown>).ID === 2362366786);
    ok(
      "NO card number is sent",
      !/CardNumber|CreditCard_Number/i.test(calls[0]!.body)
    );
    ok("NO CVV is sent", !/CVV/i.test(calls[0]!.body));
    ok(
      "no PaymentMethod block is sent at all, so the stored method is used",
      !("PaymentMethod" in sent)
    );
  }
  {
    const { calls, fetchImpl } = recorder({ Status: 0, Data: {} });
    for (const [label, amount] of [
      ["zero", "0"],
      ["a negative amount", "-5"],
      ["a non-numeric amount", "abc"],
    ] as [string, string][]) {
      await assert.rejects(
        () =>
          refundSumitPayment(
            { fetchImpl, baseUrl: BASE },
            {
              merchantId: COMPANY,
              credential: CREDENTIAL,
              customerId: 1,
              amount,
              currency: "ILS",
            }
          ),
        /positive number/
      );
      ok(`refunding ${label} is refused`, true);
    }
    ok("and none of them reached SUMIT", calls.length === 0);
  }
  {
    const { fetchImpl } = recorder({ Status: 1, UserErrorMessage: "credit not permitted" });
    await assert.rejects(
      () =>
        refundSumitPayment(
          { fetchImpl, baseUrl: BASE },
          {
            merchantId: COMPANY,
            credential: CREDENTIAL,
            customerId: 1,
            amount: "4",
            currency: "ILS",
          }
        ),
      /credit not permitted/
    );
    ok("a refused refund is an error, not a silent success", true);
  }

  // ── REQUEST DEADLINE ────────────────────────────────────────────────────
  {
    const hang: SumitHttpClient = () => new Promise(() => {});
    const provider = makeProvider(hang, { requestTimeoutMs: 25 });

    const started = Date.now();
    await assert.rejects(
      () => provider.createPaymentLink(LINK_INPUT),
      (err: unknown) => err instanceof PaymentProviderError && err.code === "HTTP_ERROR"
    );
    ok("a hanging checkout is abandoned at the deadline", Date.now() - started < 2000);

    let status: unknown = "NOT_THROWN";
    try {
      await provider.getPaymentStatus!({
        providerRequestId: null,
        merchantId: COMPANY,
        credential: CREDENTIAL,
        correlationValue: "4242",
      });
    } catch (e) {
      status = e;
    }
    ok(
      "a hanging status query throws rather than inventing an outcome",
      status instanceof PaymentProviderError && status.code === "HTTP_ERROR"
    );
    ok(
      "and never resolves to PAID",
      !(typeof status === "object" && status !== null && (status as { outcome?: string }).outcome === "PAID")
    );
  }
  {
    let aborted = false;
    await assert.rejects(() =>
      withDeadline((signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      }, 20)
    );
    ok("reaching the deadline aborts the in-flight attempt", aborted);
  }
  {
    const { fetchImpl } = recorder(LINK_OK);
    const result = await makeProvider(fetchImpl, { requestTimeoutMs: 0 }).createPaymentLink(LINK_INPUT);
    ok(
      "a zero timeout falls back to the default rather than aborting every call",
      result.paymentUrl === LINK_OK.Data.RedirectURL
    );
    ok(
      "the default deadline is a real, finite bound",
      Number.isFinite(SUMIT_DEFAULT_TIMEOUT_MS) && SUMIT_DEFAULT_TIMEOUT_MS > 0
    );
  }

  // ── DESCRIPTOR ──────────────────────────────────────────────────────────
  {
    ok("the descriptor is keyed SUMIT", sumitDescriptor.key === "SUMIT");
    ok(
      "the merchant identifier is the company id",
      sumitDescriptor.merchantIdField.key === "companyId"
    );
    ok(
      "the API key is declared a secret",
      sumitDescriptor.credentialFields.every((f) => f.type === "secret")
    );
    ok(
      "refund is advertised, because it is implemented and proven",
      sumitDescriptor.capabilities.refund === true
    );
    ok(
      "tokens are NOT advertised, because nothing here creates one",
      sumitDescriptor.capabilities.tokens === false
    );
    ok(
      "the adapter declares that it authenticates callbacks by URL possession",
      createSumitProvider().usesCallbackSecret === true
    );
  }

  console.log(`\nsumit.provider: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
