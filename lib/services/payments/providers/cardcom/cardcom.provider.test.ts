/**
 * Run: npx tsx lib/services/payments/providers/cardcom/cardcom.provider.test.ts
 *
 * CardCom provider (I3) with mocked HTTP — no real network, no real
 * credentials, no card data. Covers createPaymentLink, GetLpResult authority,
 * webhook parsing (signal only), credential safety, and the end-to-end rule
 * that a webhook alone can never produce PAID without verification.
 */
import assert from "node:assert/strict";
import {
  createCardComProvider,
  extractCardComWebhookFields,
  interpretGetLpResult,
  type CardComHttpClient,
} from "./cardcom.provider";
import { processPaymentWebhook, type ProcessWebhookDeps } from "../../payment-webhook.service";
import { createInMemoryPaymentStore } from "../../payment-store.memory";

const CRED = JSON.stringify({ apiName: "myapi", apiPassword: "secretpass" });
const SECRET = "secretpass";

type Responder = (url: string, body: Record<string, unknown> | null) =>
  | { status?: number; json?: unknown }
  | undefined;

function mockHttp(responder: Responder) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl: CardComHttpClient = async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const r = responder(url, body) ?? {};
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
    };
  };
  return { fetchImpl, calls };
}

function provider(fetchImpl: CardComHttpClient, withPublicBase = true) {
  return createCardComProvider({
    fetchImpl,
    baseUrl: "https://test.cardcom",
    ...(withPublicBase ? { publicBaseUrl: "https://app.example" } : {}),
  });
}

async function main() {
  // --- 1. createPaymentLink: ReturnValue = id, returns url + lowProfileId, no card data ---
  {
    const { fetchImpl, calls } = mockHttp((url) =>
      url.includes("/Create")
        ? { json: { ResponseCode: 0, Url: "https://pay/11111111-2222-4333-8444-555555555555", LowProfileId: "11111111-2222-4333-8444-555555555555" } }
        : undefined
    );
    const p = provider(fetchImpl);
    const r = await p.createPaymentLink({
      businessId: 1,
      paymentRequestId: 42,
      amount: "100.00",
      currency: "ILS",
      description: "Invoice 5",
      merchantId: "1000",
      credential: CRED,
    });
    assert.equal(r.paymentUrl, "https://pay/11111111-2222-4333-8444-555555555555");
    assert.equal(r.providerRequestId, "11111111-2222-4333-8444-555555555555");

    const body = calls[0]!.body!;
    assert.equal(body.ReturnValue, "42"); // PaymentRequest.id round-trips
    assert.equal(body.Amount, 100);
    assert.equal(body.TerminalNumber, 1000);
    assert.equal(body.WebHookUrl, "https://app.example/api/payments/webhook/cardcom");
    // v11 hardening: explicit Operation + always-sent redirect URLs (defaults)
    assert.equal(body.Operation, "ChargeOnly");
    assert.equal(body.SuccessRedirectUrl, "https://app.example/?payment=success");
    assert.equal(body.FailedRedirectUrl, "https://app.example/?payment=failed");
    // never any card data
    const s = JSON.stringify(body);
    assert.ok(!/cardnumber|"cvv"|"pan"/i.test(s));
    assert.ok(!("CardNumber" in body));
    // no secret leaked into the request body or the returned object
    assert.ok(!s.includes("secretpass"));
    assert.ok(!JSON.stringify(r).includes("secretpass"));
  }

  // --- 1b. ProductName is truncated to the stricter 50-char limit ---
  {
    const { fetchImpl, calls } = mockHttp((url) =>
      url.includes("/Create")
        ? { json: { ResponseCode: 0, Url: "https://pay/lp-x", LowProfileId: "lp-x" } }
        : undefined
    );
    const longName = "x".repeat(300);
    await provider(fetchImpl).createPaymentLink({
      businessId: 1,
      paymentRequestId: 7,
      amount: "10.00",
      currency: "ILS",
      description: longName,
      merchantId: "1000",
      credential: CRED,
    });
    const productName = String(calls[0]!.body!.ProductName);
    assert.equal(productName.length, 50);
    assert.equal(productName, "x".repeat(50));
  }

  // --- 1c. redirect URLs: caller-supplied values override the safe defaults ---
  {
    const { fetchImpl, calls } = mockHttp((url) =>
      url.includes("/Create")
        ? { json: { ResponseCode: 0, Url: "https://pay/lp-o", LowProfileId: "lp-o" } }
        : undefined
    );
    await provider(fetchImpl).createPaymentLink({
      businessId: 1,
      paymentRequestId: 8,
      amount: "10.00",
      currency: "ILS",
      description: null,
      merchantId: "1000",
      credential: CRED,
      successUrl: "https://caller/ok",
      failureUrl: "https://caller/no",
    });
    const body = calls[0]!.body!;
    assert.equal(body.SuccessRedirectUrl, "https://caller/ok");
    assert.equal(body.FailedRedirectUrl, "https://caller/no");
    assert.equal(body.Operation, "ChargeOnly");
  }

  // --- 2. GetLpResult success => PAID ---
  {
    const { fetchImpl } = mockHttp((url) =>
      url.includes("/GetLpResult")
        ? { json: { ResponseCode: 0, TranzactionInfo: { ResponseCode: 0, TranzactionId: 9988 } } }
        : undefined
    );
    const status = await provider(fetchImpl).getPaymentStatus!({
      providerRequestId: "11111111-2222-4333-8444-555555555555",
      merchantId: "1000",
      credential: CRED,
    });
    assert.equal(status.outcome, "PAID");
    assert.equal(status.providerTransactionId, "9988");
  }

  // --- 3. GetLpResult failure => FAILED ---
  {
    const { fetchImpl } = mockHttp(() => ({
      json: { ResponseCode: 0, TranzactionInfo: { ResponseCode: 57, TranzactionId: 5 } },
    }));
    const status = await provider(fetchImpl).getPaymentStatus!({
      providerRequestId: "11111111-2222-4333-8444-555555555555",
      merchantId: "1000",
      credential: CRED,
    });
    assert.equal(status.outcome, "FAILED");
  }

  // --- 4. inconclusive => UNKNOWN ---
  {
    assert.equal(interpretGetLpResult({ ResponseCode: 0 }).outcome, "UNKNOWN"); // no transaction yet
    assert.equal(interpretGetLpResult({ ResponseCode: 1 }).outcome, "UNKNOWN"); // query-level error
    assert.equal(interpretGetLpResult({}).outcome, "UNKNOWN");
  }

  // --- 5. webhook parse extracts ReturnValue / LowProfileId / transaction id; never throws ---
  {
    const raw = JSON.stringify({
      LowProfileId: "11111111-2222-4333-8444-555555555555",
      ReturnValue: "42",
      TranzactionInfo: { TranzactionId: 9988 },
    });
    const fields = extractCardComWebhookFields({ rawBody: raw });
    assert.equal(fields.lowProfileId, "11111111-2222-4333-8444-555555555555");
    assert.equal(fields.returnValue, "42");
    assert.equal(fields.transactionId, "9988");

    const p = provider((async () => {
      throw new Error("must not be called in parse");
    }) as unknown as CardComHttpClient);
    const ev = p.parseWebhook({ rawBody: raw });
    assert.equal(ev.providerRequestId, "11111111-2222-4333-8444-555555555555");
    assert.equal(ev.providerTransactionId, "9988");
    assert.equal(ev.outcome, "PENDING"); // signal only, never PAID

    const garbage = p.parseWebhook({ rawBody: "not json at all" });
    assert.equal(garbage.outcome, "UNKNOWN"); // unusable => rejected upstream
    assert.equal(garbage.providerRequestId, null);
  }

  // --- 6. end-to-end: webhook alone cannot PAID; verification is authority ---
  async function runWebhookWithVerification(verifyJson: unknown) {
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, merchantId: "1000" });
    const created = await store.createPaymentRequest({
      businessId: 1,
      customerId: null,
      billingDocumentId: null,
      provider: "CARDCOM",
      amount: "100.00",
      currency: "ILS",
      description: null,
      status: "PENDING",
      expiresAt: null,
    });
    await store.updatePaymentRequest(created.id, { providerRequestId: "11111111-2222-4333-8444-555555555555" });

    const { fetchImpl } = mockHttp((url) =>
      url.includes("/GetLpResult") ? { json: verifyJson } : undefined
    );
    const deps: ProcessWebhookDeps = {
      store,
      resolveProvider: () => provider(fetchImpl),
      decryptConnectionCredential: () => CRED,
    };
    const webhookBody = JSON.stringify({
      LowProfileId: "11111111-2222-4333-8444-555555555555",
      ReturnValue: String(created.id),
      TranzactionInfo: { TranzactionId: 7 },
    });
    const res = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: webhookBody },
      deps
    );
    return { res, store };
  }

  // verification confirms success => PAID
  {
    const { res, store } = await runWebhookWithVerification({
      ResponseCode: 0,
      TranzactionInfo: { ResponseCode: 0, TranzactionId: 7, Amount: 100, CoinId: 1 },
    });
    assert.equal(res.verified, true);
    assert.equal(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "PAID");
  }

  // verification says failed => NOT PAID (webhook alone is only a signal)
  {
    const { res, store } = await runWebhookWithVerification({
      ResponseCode: 0,
      TranzactionInfo: { ResponseCode: 57, TranzactionId: 7 },
    });
    assert.notEqual(res.paymentRequestStatus, "PAID");
    assert.equal(store.requests[0]?.status, "FAILED");
  }

  // --- 7. missing/invalid credentials fail safely ---
  {
    const p = provider(mockHttp(() => ({ json: {} })).fetchImpl);
    await assert.rejects(
      () =>
        p.createPaymentLink({
          businessId: 1,
          paymentRequestId: 1,
          amount: "10.00",
          currency: "ILS",
          description: null,
          merchantId: "1000",
          credential: null, // missing
        }),
      /MISSING_CREDENTIALS|missing/i
    );
    await assert.rejects(
      () =>
        p.getPaymentStatus!({
          providerRequestId: "11111111-2222-4333-8444-555555555555",
          merchantId: "1000",
          credential: "not-json", // invalid
        }),
      /MISSING_CREDENTIALS|missing/i
    );
  }

  // --- 8. missing public base url fails clearly ---
  {
    const prev = process.env.PAYMENTS_PUBLIC_BASE_URL;
    delete process.env.PAYMENTS_PUBLIC_BASE_URL;
    try {
      const p = provider(mockHttp(() => ({ json: {} })).fetchImpl, /* withPublicBase */ false);
      await assert.rejects(
        () =>
          p.createPaymentLink({
            businessId: 1,
            paymentRequestId: 1,
            amount: "10.00",
            currency: "ILS",
            description: null,
            merchantId: "1000",
            credential: CRED,
          }),
        /MISSING_PUBLIC_BASE_URL|PAYMENTS_PUBLIC_BASE_URL/
      );
    } finally {
      if (prev !== undefined) process.env.PAYMENTS_PUBLIC_BASE_URL = prev;
    }
  }

  // --- 8. M1 / F5 — what GetLpResult may and may not establish ---
  {
    // The verified money comes from TranzactionInfo, in CardCom's own terms.
    const paid = interpretGetLpResult(
      { ResponseCode: 0, ReturnValue: "42", TerminalNumber: 1000, TranzactionInfo: { ResponseCode: 0, TranzactionId: 31, Amount: 5, CoinId: 1 } },
      { returnValue: "42", terminalNumber: "1000" }
    );
    assert.equal(paid.outcome, "PAID");
    assert.equal(paid.providerTransactionId, "31");
    assert.equal(paid.verifiedAmount, "5.00");
    assert.equal(paid.verifiedCurrency, "ILS");
    assert.equal(interpretGetLpResult({ ResponseCode: 0, TranzactionInfo: { ResponseCode: 0, TranzactionId: 1, Amount: 9.9, CoinId: 2 } }).verifiedCurrency, "USD");
    assert.equal(interpretGetLpResult({ ResponseCode: 0, TranzactionInfo: { ResponseCode: 0, TranzactionId: 1, Amount: 1, CoinId: 978 } }).verifiedCurrency, "EUR");
    // A coin this adapter cannot name can only ever be a mismatch.
    assert.equal(interpretGetLpResult({ ResponseCode: 0, TranzactionInfo: { ResponseCode: 0, TranzactionId: 1, Amount: 1, CoinId: 826 } }).verifiedCurrency, "COIN:826");
    // Finer precision than cents is kept verbatim, never rounded into agreement.
    assert.equal(interpretGetLpResult({ ResponseCode: 0, TranzactionInfo: { ResponseCode: 0, TranzactionId: 1, Amount: 5.004, CoinId: 1 } }).verifiedAmount, "5.004");

    // F5 — a null, empty or absent code is not CardCom's 0.
    for (const code of [null, "", undefined, false, "0x0", 0.0000001]) {
      const s = interpretGetLpResult({ ResponseCode: code, TranzactionInfo: { ResponseCode: code, TranzactionId: 7, Amount: 5, CoinId: 1 } });
      assert.notEqual(s.outcome, "PAID", `code ${JSON.stringify(code)} must not read as success`);
    }
    assert.equal(interpretGetLpResult({ ResponseCode: "0", TranzactionInfo: { ResponseCode: "0", TranzactionId: "7", Amount: "5", CoinId: "1" } }).outcome, "PAID");
    // No TranzactionInfo yet: not conclusive, and no transaction id is claimed.
    const early = interpretGetLpResult({ ResponseCode: 0, TranzactionInfo: null });
    assert.equal(early.outcome, "UNKNOWN");
    assert.equal(early.providerTransactionId, null);
    // A zero / negative transaction id is no id.
    assert.equal(interpretGetLpResult({ ResponseCode: 0, TranzactionInfo: { ResponseCode: 0, TranzactionId: 0, Amount: 5, CoinId: 1 } }).providerTransactionId, null);

    // An answer about a DIFFERENT payment or terminal is not evidence about this one.
    const foreign = interpretGetLpResult(
      { ResponseCode: 0, ReturnValue: "999", TranzactionInfo: { ResponseCode: 0, TranzactionId: 7, Amount: 5, CoinId: 1 } },
      { returnValue: "42" }
    );
    assert.equal(foreign.outcome, "UNKNOWN");
    assert.equal(foreign.detail, "return_value_mismatch");
    const otherTerminal = interpretGetLpResult(
      { ResponseCode: 0, TerminalNumber: 2000, TranzactionInfo: { ResponseCode: 0, TranzactionId: 7, Amount: 5, CoinId: 1 } },
      { terminalNumber: "1000" }
    );
    assert.equal(otherTerminal.outcome, "UNKNOWN");
    assert.equal(otherTerminal.detail, "terminal_mismatch");

    // getPaymentStatus asks about THIS request: ReturnValue and terminal are checked.
    const { fetchImpl } = mockHttp(() => ({
      json: { ResponseCode: 0, ReturnValue: "77", TerminalNumber: 1000, TranzactionInfo: { ResponseCode: 0, TranzactionId: 8, Amount: 5, CoinId: 1 } },
    }));
    const viaAdapter = await provider(fetchImpl).getPaymentStatus!({
      providerRequestId: "11111111-2222-4333-8444-555555555555",
      merchantId: "1000",
      credential: CRED,
      correlationValue: "78",
    });
    assert.equal(viaAdapter.outcome, "UNKNOWN", "a ReturnValue for another request is not evidence");
  }

  // --- 9. F5 — every CardCom call is bounded by a deadline ---
  {
    const hanging: CardComHttpClient = (_url, init) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const p = createCardComProvider({ fetchImpl: hanging, baseUrl: "https://test.cardcom", timeoutMs: 50 });
    const started = Date.now();
    await assert.rejects(
      () =>
        p.getPaymentStatus!({
          providerRequestId: "11111111-2222-4333-8444-555555555555",
          merchantId: "1000",
          credential: CRED,
        }),
      (e: unknown) => (e as { code?: string }).code === "TIMEOUT"
    );
    assert.ok(Date.now() - started < 5_000, "the deadline, not the platform, ends a hung call");
    // A body that never finishes is as silent as one that never started.
    const slowBody = createCardComProvider({
      fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => undefined) }),
      baseUrl: "https://test.cardcom",
      timeoutMs: 50,
    });
    await assert.rejects(
      () =>
        slowBody.getPaymentStatus!({
          providerRequestId: "11111111-2222-4333-8444-555555555555",
          merchantId: "1000",
          credential: CRED,
        }),
      (e: unknown) => (e as { code?: string }).code === "TIMEOUT"
    );
  }

  void SECRET;
  console.log("cardcom.provider tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
