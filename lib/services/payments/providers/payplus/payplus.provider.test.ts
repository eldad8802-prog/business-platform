/**
 * Run: npx tsx lib/services/payments/providers/payplus/payplus.provider.test.ts
 *
 * PayPlus adapter — baseline capabilities only.
 *
 * Everything here runs against an injected HTTP client. No network, no
 * credentials, no PayPlus account. What it proves is that the adapter builds
 * the documented requests, reads the documented responses, refuses what it
 * cannot express, and never sends card data.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { PaymentProviderError } from "../payment-provider.types";
import {
  PAYPLUS_DEFAULT_TIMEOUT_MS,
  PAYPLUS_SUPPORTED_CURRENCIES,
  createPayPlusProvider,
  withDeadline,
  interpretPayPlusTransaction,
  payPlusDescriptor,
  resolvePayPlusBaseUrl,
  verifyPayPlusSignature,
  type PayPlusHttpClient,
} from "./payplus.provider";

const SANDBOX = "https://restapidev.payplus.co.il/api/v1.0";
const PRODUCTION = "https://restapi.payplus.co.il/api/v1.0";
const CREDENTIAL = JSON.stringify({ apiKey: "ak", secretKey: "sk" });

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

function recorder(json: unknown): { calls: Call[]; fetchImpl: PayPlusHttpClient } {
  const calls: Call[] = [];
  const fetchImpl: PayPlusHttpClient = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200, json: async () => json };
  };
  return { calls, fetchImpl };
}

const LINK_OK = {
  results: { status: "success" },
  data: {
    page_request_uid: "6b3f0a1e-1111-2222-3333-444455556666",
    payment_page_link: "https://payplus.example/pay/abc",
  },
};

async function main() {
  // ── BASE URL: fail-safe, never silently live ────────────────────────────
  //
  // This is the defect found in the CardCom adapter, deliberately not repeated:
  // a missing override there meant the LIVE host.
  ok(
    "no override, no production markers -> SANDBOX",
    resolvePayPlusBaseUrl({}) === SANDBOX
  );
  ok(
    "no override, VERCEL_ENV=preview -> SANDBOX",
    resolvePayPlusBaseUrl({ VERCEL_ENV: "preview" }) === SANDBOX
  );
  ok(
    "no override, VERCEL_ENV=development -> SANDBOX",
    resolvePayPlusBaseUrl({ VERCEL_ENV: "development" }) === SANDBOX
  );
  ok(
    "no override, NODE_ENV=production but VERCEL_ENV=preview -> SANDBOX",
    resolvePayPlusBaseUrl({ VERCEL_ENV: "preview", NODE_ENV: "production" }) ===
      SANDBOX
  );
  ok(
    "no override, genuine production -> PRODUCTION",
    resolvePayPlusBaseUrl({ VERCEL_ENV: "production" }) === PRODUCTION
  );
  ok(
    "explicit sandbox override is honoured",
    resolvePayPlusBaseUrl({ PAYPLUS_BASE_URL: SANDBOX }) === SANDBOX
  );
  ok(
    "explicit production override is honoured",
    resolvePayPlusBaseUrl({
      PAYPLUS_BASE_URL: PRODUCTION,
      VERCEL_ENV: "preview",
    }) === PRODUCTION
  );
  assert.throws(
    () => resolvePayPlusBaseUrl({ PAYPLUS_BASE_URL: "https://evil.example" }),
    /documented PayPlus sandbox or production host/
  );
  ok("an arbitrary host is refused rather than trusted", true);

  // ── CREATE PAYMENT LINK ─────────────────────────────────────────────────
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    const provider = createPayPlusProvider({
      fetchImpl,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
    });
    const result = await provider.createPaymentLink({
      businessId: 7,
      paymentRequestId: 4242,
      amount: "150.00",
      currency: "ILS",
      description: "Invoice #12",
      merchantId: "page-uid",
      credential: CREDENTIAL,
    });

    ok(
      "returns the hosted link and the provider session id",
      result.paymentUrl === "https://payplus.example/pay/abc" &&
        result.providerRequestId === "6b3f0a1e-1111-2222-3333-444455556666"
    );
    ok("exactly one HTTP call", calls.length === 1);
    ok(
      "posts to the documented generateLink path on the SANDBOX host",
      calls[0]!.url === `${SANDBOX}/PaymentPages/generateLink`
    );

    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    ok("merchant id is sent as payment_page_uid", sent.payment_page_uid === "page-uid");
    ok("amount is a decimal NUMBER, not minor units", sent.amount === 150);
    ok("currency is sent as currency_code", sent.currency_code === "ILS");
    ok(
      "our PaymentRequest id round-trips via more_info",
      sent.more_info === "4242"
    );
    ok(
      "the callback URL points at the generic webhook route",
      sent.refURL_callback === "https://app.example/api/payments/webhook/payplus"
    );
    ok(
      "credentials travel in headers, never in the body",
      calls[0]!.headers["api-key"] === "ak" &&
        calls[0]!.headers["secret-key"] === "sk" &&
        !calls[0]!.body.includes("secretKey")
    );
    ok(
      "no card data is ever sent",
      !/cardnumber|"cvv"|"pan"|card_number/i.test(calls[0]!.body)
    );
  }

  // Missing credentials fail before any call.
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    const provider = createPayPlusProvider({
      fetchImpl,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
    });
    await assert.rejects(
      () =>
        provider.createPaymentLink({
          businessId: 1,
          paymentRequestId: 1,
          amount: "10.00",
          currency: "ILS",
          description: null,
          merchantId: null,
          credential: CREDENTIAL,
        }),
      /missing its payment page id or API credentials/
    );
    ok("a connection without a payment page id is refused", calls.length === 0);
  }

  // A response missing the link is a failure, not a silent success.
  {
    const { fetchImpl } = recorder({ results: { status: "error" }, data: {} });
    const provider = createPayPlusProvider({
      fetchImpl,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
    });
    await assert.rejects(
      () =>
        provider.createPaymentLink({
          businessId: 1,
          paymentRequestId: 1,
          amount: "10.00",
          currency: "ILS",
          description: null,
          merchantId: "page",
          credential: CREDENTIAL,
        }),
      /did not return a payment page link/
    );
    ok("a response with no link is a hard failure", true);
  }

  // ── CURRENCY ────────────────────────────────────────────────────────────
  {
    const { calls, fetchImpl } = recorder(LINK_OK);
    const provider = createPayPlusProvider({
      fetchImpl,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
    });
    await assert.rejects(
      () =>
        provider.createPaymentLink({
          businessId: 1,
          paymentRequestId: 1,
          amount: "10.00",
          currency: "XYZ",
          description: null,
          merchantId: "page",
          credential: CREDENTIAL,
        }),
      /cannot be charged in XYZ/
    );
    ok("an undocumented currency is refused", true);
    ok("and no request reached PayPlus", calls.length === 0);
    ok(
      "the declared list is the documented one, and includes ILS",
      PAYPLUS_SUPPORTED_CURRENCIES.includes("ILS") &&
        PAYPLUS_SUPPORTED_CURRENCIES.includes("USD") &&
        !PAYPLUS_SUPPORTED_CURRENCIES.includes("XYZ")
    );
    ok(
      "descriptor and adapter agree on currency support",
      payPlusDescriptor.supportedCurrencies === PAYPLUS_SUPPORTED_CURRENCIES
    );
  }

  // ── SIGNATURE VERIFICATION ──────────────────────────────────────────────
  {
    const body = '{"transaction":{"uid":"t1","status_code":"000"}}';
    const good = createHmac("sha256", "sk").update(body, "utf8").digest("base64");

    ok(
      "a correct signature over the RAW body passes",
      verifyPayPlusSignature({
        rawBody: body,
        headers: { "user-agent": "PayPlus", hash: good },
        secretKey: "sk",
      }).ok === true
    );

    const wrongKey = verifyPayPlusSignature({
      rawBody: body,
      headers: { "user-agent": "PayPlus", hash: good },
      secretKey: "other",
    });
    ok(
      "a different key fails",
      wrongKey.ok === false && wrongKey.reason === "signature_mismatch"
    );

    const tampered = verifyPayPlusSignature({
      rawBody: body.replace("000", "999"),
      headers: { "user-agent": "PayPlus", hash: good },
      secretKey: "sk",
    });
    ok("a tampered body fails", tampered.ok === false);

    ok(
      "a missing hash header fails",
      verifyPayPlusSignature({
        rawBody: body,
        headers: { "user-agent": "PayPlus" },
        secretKey: "sk",
      }).ok === false
    );
    ok(
      "a wrong user-agent fails",
      verifyPayPlusSignature({
        rawBody: body,
        headers: { "user-agent": "nope", hash: good },
        secretKey: "sk",
      }).ok === false
    );
    ok(
      "a signature of the wrong length fails without throwing",
      verifyPayPlusSignature({
        rawBody: body,
        headers: { "user-agent": "PayPlus", hash: "short" },
        secretKey: "sk",
      }).ok === false
    );

    // The documented sample signs a RE-SERIALISED body. Both readings are
    // accepted because the specification does not say which is authoritative,
    // and each still requires the secret. See the note on the function.
    const spaced = '{ "transaction" : { "uid" : "t1" } }';
    const canonical = JSON.stringify(JSON.parse(spaced));
    const canonicalSig = createHmac("sha256", "sk")
      .update(canonical, "utf8")
      .digest("base64");
    ok(
      "a signature over the re-serialised body is also accepted (documented sample form)",
      verifyPayPlusSignature({
        rawBody: spaced,
        headers: { "user-agent": "PayPlus", hash: canonicalSig },
        secretKey: "sk",
      }).ok === true
    );
    ok(
      "but a signature over neither form still fails",
      verifyPayPlusSignature({
        rawBody: spaced,
        headers: { "user-agent": "PayPlus", hash: "AAAA" },
        secretKey: "sk",
      }).ok === false
    );
  }

  // ── PARSE: signal only, never authority ─────────────────────────────────
  {
    const provider = createPayPlusProvider({ baseUrl: SANDBOX });
    const parsed = provider.parseWebhook({
      rawBody: JSON.stringify({
        transaction: {
          uid: "TXN-9",
          payment_request_uid: "PRQ-9",
          status_code: "000",
          amount: "50.00",
          currency: "ILS",
          more_info: "77",
        },
      }),
    });
    ok(
      "the session id becomes providerRequestId",
      parsed.providerRequestId === "PRQ-9"
    );
    ok(
      "the transaction id becomes providerTransactionId and the event id",
      parsed.providerTransactionId === "TXN-9" && parsed.providerEventId === "TXN-9"
    );
    ok("more_info becomes the correlation value", parsed.correlationValue === "77");
    ok(
      "the outcome is PENDING — a callback may never assert PAID",
      parsed.outcome === "PENDING"
    );

    const junk = provider.parseWebhook({ rawBody: "not json" });
    ok("an unparseable body yields UNKNOWN and never throws", junk.outcome === "UNKNOWN");
  }

  // ── AUTHORITATIVE STATUS (and Gap B) ────────────────────────────────────
  {
    const paid = {
      results: { status: "success" },
      data: [{ uid: "TXN-1", status_code: "000", transaction_is_cancelled: false }],
    };
    const { calls, fetchImpl } = recorder(paid);
    const provider = createPayPlusProvider({ fetchImpl, baseUrl: SANDBOX });

    const byTx = await provider.getPaymentStatus!({
      providerRequestId: "PRQ-1",
      merchantId: "page",
      credential: CREDENTIAL,
      providerTransactionId: "TXN-1",
      correlationValue: "42",
    });
    ok("a successful transaction is PAID", byTx.outcome === "PAID");
    ok("and carries the provider transaction id", byTx.providerTransactionId === "TXN-1");
    ok(
      "the query goes to the documented Transactions/View path",
      calls[0]!.url === `${SANDBOX}/Transactions/View`
    );
    ok(
      "when a transaction id is known it is used as the key",
      JSON.parse(calls[0]!.body).transaction_uid === "TXN-1"
    );
  }
  {
    // GAP B: no transaction id yet, so the lookup must fall back to our own
    // correlation value. PayPlus does not accept page_request_uid here, so
    // without this the authority question could not be asked at all.
    const paid = {
      results: { status: "success" },
      data: [{ uid: "TXN-2", status_code: "000" }],
    };
    const { calls, fetchImpl } = recorder(paid);
    const provider = createPayPlusProvider({ fetchImpl, baseUrl: SANDBOX });
    const res = await provider.getPaymentStatus!({
      providerRequestId: "PRQ-2",
      merchantId: "page",
      credential: CREDENTIAL,
      correlationValue: "4242",
    });
    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    ok("without a transaction id the lookup uses more_info", sent.more_info === "4242");
    ok(
      "and the session id is NEVER smuggled in as a transaction id",
      sent.transaction_uid === undefined && !calls[0]!.body.includes("PRQ-2")
    );
    ok("the outcome still resolves", res.outcome === "PAID");
  }
  {
    const { fetchImpl } = recorder({});
    const provider = createPayPlusProvider({ fetchImpl, baseUrl: SANDBOX });
    await assert.rejects(
      () =>
        provider.getPaymentStatus!({
          providerRequestId: "PRQ-3",
          merchantId: "page",
          credential: CREDENTIAL,
        }),
      /needs a transaction id or a correlation value/
    );
    ok("with no usable key the query refuses rather than guessing", true);
  }

  // ── STATUS INTERPRETATION ───────────────────────────────────────────────
  ok(
    "a non-success status code is FAILED",
    interpretPayPlusTransaction({
      results: { status: "success" },
      data: [{ uid: "T", status_code: "005" }],
    }).outcome === "FAILED"
  );
  ok(
    "a cancelled transaction is CANCELLED",
    interpretPayPlusTransaction({
      data: [{ uid: "T", status_code: "000", transaction_is_cancelled: true }],
    }).outcome === "CANCELLED"
  );
  ok(
    "no transaction yet is UNKNOWN, never PAID and never FAILED",
    interpretPayPlusTransaction({ results: { status: "success" }, data: [] })
      .outcome === "UNKNOWN"
  );
  ok(
    "an unrecognisable response is UNKNOWN",
    interpretPayPlusTransaction({ nonsense: true }).outcome === "UNKNOWN"
  );
  ok(
    "a single object response is read as well as a list",
    interpretPayPlusTransaction({
      data: { uid: "T", status_code: "000" },
    }).outcome === "PAID"
  );

  // --- unusable credential --------------------------------------------------
  //
  // Decryption can fail for reasons that have nothing to do with the caller: a
  // rotated `PAYMENTS_ENCRYPTION_KEY`, a row written under a different key id, a
  // corrupted blob. The store then hands the adapter `null` or a string that
  // will not parse, and every one of those must be a REFUSAL. The hazard is
  // specifically an accept-by-default: a callback that cannot be checked against
  // a key must never be treated as though it had been.
  {
    const provider = createPayPlusProvider({
      fetchImpl: recorder(LINK_OK).fetchImpl,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
    });
    const rawBody = JSON.stringify({ page_request_uid: "PRQ-1", more_info: "1" });
    const headers = { "user-agent": "PayPlus", hash: "irrelevant" };

    for (const [label, credential] of [
      ["a credential that could not be decrypted at all", null],
      ["a credential that is not JSON", "<<not-json>>"],
      ["a JSON credential missing the secret key", JSON.stringify({ apiKey: "ak" })],
      ["a JSON credential missing the API key", JSON.stringify({ secretKey: "sk" })],
      [
        "a JSON credential whose keys are empty strings",
        JSON.stringify({ apiKey: "", secretKey: "" }),
      ],
      ["a credential that decrypted to an empty string", ""],
    ] as [string, string | null][]) {
      const res = await provider.authenticateWebhook!({
        rawBody,
        headers,
        credential,
        merchantId: "page-uid",
      });
      ok(
        `${label} is refused, never accepted by default`,
        res.ok === false && res.reason === "merchant_credential_unavailable"
      );
    }
  }
  {
    // The same on the outbound path. An unusable credential must stop the
    // request before it leaves the process, so a half-configured merchant
    // cannot create a live payment page that nothing can later settle.
    const { calls, fetchImpl } = recorder(LINK_OK);
    const provider = createPayPlusProvider({
      fetchImpl,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
    });
    let message = "";
    try {
      await provider.createPaymentLink({
        businessId: 7,
        paymentRequestId: 4242,
        amount: "10.00",
        currency: "ILS",
        description: null,
        merchantId: "page-uid",
        credential: "corrupt-blob-not-json",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    ok("an unusable credential refuses the payment link", message !== "");
    ok("and nothing reached PayPlus", calls.length === 0);
    ok(
      "and the error repeats no credential material",
      !message.includes("corrupt-blob-not-json")
    );
  }

  // --- request deadline ----------------------------------------------------
  //
  // A provider that accepts the connection and then never answers is the worst
  // shape of failure on a money path: it holds the caller — and its tenant
  // transaction — open indefinitely. What follows proves the wait is bounded,
  // and that reaching the bound is a FAILURE rather than a settlement.
  {
    // Never resolves, and ignores the abort signal entirely — the pessimistic
    // case, and the reason the deadline cannot rely on the signal alone.
    const hang: PayPlusHttpClient = () => new Promise(() => {});
    const provider = createPayPlusProvider({
      fetchImpl: hang,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
      requestTimeoutMs: 25,
    });

    const started = Date.now();
    await assert.rejects(
      () =>
        provider.createPaymentLink({
          businessId: 7,
          paymentRequestId: 4242,
          amount: "150.00",
          currency: "ILS",
          description: null,
          merchantId: "page-uid",
          credential: CREDENTIAL,
        }),
      (err: unknown) =>
        err instanceof PaymentProviderError && err.code === "HTTP_ERROR"
    );
    ok(
      "a hanging generateLink is abandoned at the deadline, not awaited forever",
      Date.now() - started < 2000
    );

    // The same guarantee on the authority path. This one matters most: a
    // timeout here must never be read as "the provider said it was paid".
    let status: unknown = "NOT_THROWN";
    try {
      await provider.getPaymentStatus!({
        providerRequestId: "PRQ-9",
        merchantId: "page",
        credential: CREDENTIAL,
        correlationValue: "4242",
      });
    } catch (err) {
      status = err;
    }
    ok(
      "a hanging status query throws rather than inventing an outcome",
      status instanceof PaymentProviderError && status.code === "HTTP_ERROR"
    );
    ok(
      "and it never resolves to PAID",
      !(
        typeof status === "object" &&
        status !== null &&
        (status as { outcome?: string }).outcome === "PAID"
      )
    );
  }
  {
    // The signal is offered to the transport, so a well-behaved client can
    // release the socket rather than leak it until the process exits.
    let seen: AbortSignal | undefined;
    const capture: PayPlusHttpClient = async (_url, init) => {
      seen = init.signal;
      return { ok: true, status: 200, json: async () => LINK_OK };
    };
    const provider = createPayPlusProvider({
      fetchImpl: capture,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
    });
    await provider.createPaymentLink({
      businessId: 7,
      paymentRequestId: 4242,
      amount: "1.00",
      currency: "ILS",
      description: null,
      merchantId: "page-uid",
      credential: CREDENTIAL,
    });
    ok("the transport is handed an abort signal", seen instanceof AbortSignal);
    ok("which is not already aborted on a healthy call", seen?.aborted === false);
  }
  {
    // The deadline aborts the signal it handed out, so a transport that DOES
    // honour it learns the attempt was abandoned.
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
    // Fail-closed on configuration: "no timeout" is not an option this provider
    // offers, so a nonsense value falls back to the default rather than either
    // disabling the deadline or firing it instantly.
    const { fetchImpl } = recorder(LINK_OK);
    const provider = createPayPlusProvider({
      fetchImpl,
      baseUrl: SANDBOX,
      publicBaseUrl: "https://app.example",
      requestTimeoutMs: 0,
    });
    const result = await provider.createPaymentLink({
      businessId: 7,
      paymentRequestId: 4242,
      amount: "1.00",
      currency: "ILS",
      description: null,
      merchantId: "page-uid",
      credential: CREDENTIAL,
    });
    ok(
      "a zero timeout falls back to the default instead of aborting every call",
      result.paymentUrl === "https://payplus.example/pay/abc"
    );
    ok(
      "the default deadline is a real, finite bound",
      Number.isFinite(PAYPLUS_DEFAULT_TIMEOUT_MS) &&
        PAYPLUS_DEFAULT_TIMEOUT_MS > 0
    );
  }

  console.log(`\npayplus.provider: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
