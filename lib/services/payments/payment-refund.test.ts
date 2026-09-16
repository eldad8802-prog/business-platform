/**
 * Run: npx tsx lib/services/payments/payment-refund.test.ts
 *
 * The reversal seam (M5), tested at the DOMAIN level. Almost every adapter here
 * is synthetic, because what is under test is a claim about the payments domain
 * rather than about any provider. SUMIT appears only where the point is that a
 * real adapter's mechanism reaches the seam unchanged.
 *
 * The adversarial cases carry the weight. A refund path that works is easy; a
 * refund path that cannot be made to pay twice, cannot be pointed at another
 * business's money, and cannot report success it did not establish is the
 * actual deliverable.
 */
import {
  PaymentRefundInFlightError,
  PaymentRefundUnsupportedError,
  getRefundableBalance,
  refundPaymentRequest,
  type RefundPaymentRequestDeps,
} from "./payment-refund.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createSumitProvider } from "./providers/sumit/sumit.provider";
import type {
  PaymentProviderAdapter,
  RefundPaymentInput,
  RefundPaymentResult,
} from "./providers/payment-provider.types";
import type { InMemoryPaymentStore } from "./payment-store.memory";

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

async function throws(
  name: string,
  fn: () => Promise<unknown>,
  match?: RegExp | (new (...args: never[]) => Error)
): Promise<unknown> {
  try {
    await fn();
    ok(name, false, "it resolved instead of throwing");
    return null;
  } catch (error) {
    if (!match) {
      ok(name, true);
      return error;
    }
    if (typeof match === "function") {
      ok(name, error instanceof match, String(error));
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    ok(name, match.test(message), message);
    return error;
  }
}

/** A provider that reverses whatever it is asked to, and records the asking. */
function refundingProvider(
  outcome: RefundPaymentResult["outcome"] = "REFUNDED"
): PaymentProviderAdapter & { seen: RefundPaymentInput[]; calls: number } {
  const seen: RefundPaymentInput[] = [];
  const adapter = {
    provider: "CARDCOM" as const,
    supportedCurrencies: ["ILS"],
    async createPaymentLink() {
      return { paymentUrl: "https://pay.example/x", providerRequestId: "x" };
    },
    async verifyWebhook() {
      return { ok: true as const };
    },
    parseWebhook() {
      return {
        providerEventId: null,
        eventType: null,
        providerRequestId: null,
        providerTransactionId: null,
        outcome: "UNKNOWN" as const,
        amount: null,
        currency: null,
      };
    },
    async getPaymentStatus() {
      return { outcome: "PAID" as const, providerTransactionId: "t-1" };
    },
    async refundPayment(input: RefundPaymentInput) {
      seen.push(input);
      adapter.calls++;
      return {
        providerRefundId: `refund-${seen.length}`,
        outcome,
      };
    },
    seen,
    calls: 0,
  };
  return adapter;
}

/** A provider with no reversal capability at all. */
function nonRefundingProvider(): PaymentProviderAdapter {
  const base = refundingProvider();
  const { refundPayment: _omitted, ...rest } = base;
  void _omitted;
  return rest as PaymentProviderAdapter;
}

function deps(
  store: InMemoryPaymentStore,
  adapter: PaymentProviderAdapter
): RefundPaymentRequestDeps {
  return {
    store,
    resolveProvider: () => adapter,
    decryptConnectionCredential: () => JSON.stringify({ apiKey: "k" }),
  };
}

/** A business with one CardCom payment, settled for `amount`. */
async function settledPayment(
  store: InMemoryPaymentStore,
  options: {
    businessId?: number;
    amount?: string;
    status?: "PAID" | "PENDING";
    settle?: boolean;
    rawPayload?: unknown;
  } = {}
) {
  const businessId = options.businessId ?? 1;
  const amount = options.amount ?? "100.00";

  store.seedConnection({
    businessId,
    provider: "CARDCOM",
    isActive: true,
    merchantId: "m-1",
  });

  const request = await store.createPaymentRequest({
    businessId,
    customerId: null,
    billingDocumentId: null,
    provider: "CARDCOM",
    amount,
    currency: "ILS",
    description: "Test charge",
    status: options.status ?? "PAID",
    expiresAt: null,
  });

  if (options.settle !== false) {
    await store.createTransaction({
      paymentRequestId: request.id,
      provider: "CARDCOM",
      providerTransactionId: `settle-${request.id}`,
      amount,
      currency: "ILS",
      status: "PAID",
      rawPayload: options.rawPayload ?? { settled: true },
    });
  }

  return request;
}

async function main() {
  // ── a partial refund settles and leaves a remainder ────────────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store);

    const res = await refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "40.00" },
      deps(store, adapter)
    );

    ok("a partial refund settles", res.outcome === "REFUNDED");
    ok("the refund row carries a NEGATIVE amount", res.refund.amount === "-40.00");
    ok("and the provider's own id for the reversal", res.refund.providerTransactionId === "refund-1");
    ok("and is recorded as settled", res.refund.status === "PAID");
    ok("the refunded total is reported", res.refundedTotal === "40.00");
    ok("and so is what remains", res.refundableRemaining === "60.00");
    ok("the provider was asked exactly once", adapter.calls === 1);
    ok(
      "the provider received the amount as a POSITIVE decimal",
      adapter.seen[0]!.amount === "40.00"
    );
    ok(
      "and the settlement Dubiz stored, not anything the caller sent",
      adapter.seen[0]!.settlement.providerTransactionId === `settle-${request.id}`
    );
    ok(
      "the settlement body reaches the adapter untouched",
      JSON.stringify(adapter.seen[0]!.settlement.rawPayload) ===
        JSON.stringify({ settled: true })
    );

    const audit = await store.listAuditEvents(1, { paymentRequestId: request.id });
    const types = audit.map((a) => a.eventType);
    ok(
      "the instruction is audited BEFORE the provider is called",
      types.indexOf("PAYMENT_REFUND_REQUESTED") <
        types.indexOf("PAYMENT_REFUND_SETTLED")
    );
    ok("and the settlement is audited too", types.includes("PAYMENT_REFUND_SETTLED"));

    // The request itself is untouched: the money did arrive, and that fact is
    // not rewritten by what happened afterwards.
    const after = await store.findPaymentRequestById(request.id);
    ok("the payment request stays PAID", after!.status === "PAID");
  }

  // ── the remaining balance can then be refunded in full ──────────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store);

    await refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "40.00" },
      deps(store, adapter)
    );
    const rest = await refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "60.00" },
      deps(store, adapter)
    );

    ok("the remaining balance refunds in full", rest.outcome === "REFUNDED");
    ok("the cumulative total is the whole settlement", rest.refundedTotal === "100.00");
    ok("and nothing is left", rest.refundableRemaining === "0.00");

    await throws(
      "a third refund on a fully refunded payment is refused",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "0.01" },
          deps(store, adapter)
        ),
      /already been fully refunded/i
    );
    ok("and it never reached the provider", adapter.calls === 2);
  }

  // ── amount validation ──────────────────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store);
    const d = deps(store, adapter);

    await throws(
      "a zero refund is refused",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "0" },
          d
        ),
      /greater than zero/i
    );
    await throws(
      "a negative refund is refused",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "-5.00" },
          d
        ),
      /greater than zero/i
    );
    await throws(
      "a non-numeric refund is refused",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "ten" },
          d
        ),
      /decimal amount/i
    );
    await throws(
      "sub-cent precision is refused rather than silently rounded",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "1.005" },
          d
        ),
      /decimal places/i
    );
    ok("none of them reached the provider", adapter.calls === 0);

    const rows = await store.listTransactionsByRequest(request.id);
    ok(
      "and none of them left a reservation behind",
      rows.filter((t) => Number(t.amount) < 0).length === 0
    );
  }

  // ── over-refund, in one go and cumulatively ────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store, { amount: "50.00" });
    const d = deps(store, adapter);

    await throws(
      "a refund larger than the settlement is refused",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "50.01" },
          d
        ),
      /exceeds the refundable balance/i
    );
    ok("it never reached the provider", adapter.calls === 0);

    await refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "30.00" },
      d
    );
    await throws(
      "and refunds that only exceed it CUMULATIVELY are refused too",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "30.00" },
          d
        ),
      /exceeds the refundable balance/i
    );
    ok("the provider was asked only for the one that fit", adapter.calls === 1);

    const balance = await getRefundableBalance(store, {
      businessId: 1,
      requestId: request.id,
    });
    ok("the readable balance agrees with the guard", balance.refundableRemaining === "20.00");
    ok("and reports what was settled", balance.settledAmount === "50.00");
  }

  // ── tenant isolation ───────────────────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store, { businessId: 1 });

    await throws(
      "another business cannot refund this payment",
      () =>
        refundPaymentRequest(
          { businessId: 2, actorUserId: 9, requestId: request.id, amount: "10.00" },
          deps(store, adapter)
        ),
      /not found/i
    );
    ok("and the provider was never called on its behalf", adapter.calls === 0);

    await throws(
      "nor can it read the refundable balance",
      () => getRefundableBalance(store, { businessId: 2, requestId: request.id }),
      /not found/i
    );

    // The refusal must be indistinguishable from a request that does not exist,
    // or the endpoint becomes an oracle for other businesses' payment ids.
    const foreign = await throws(
      "a non-existent request refuses identically",
      () =>
        refundPaymentRequest(
          { businessId: 2, actorUserId: 9, requestId: 999999, amount: "10.00" },
          deps(store, adapter)
        ),
      /not found/i
    );
    ok(
      "so a caller cannot tell a foreign id from a missing one",
      foreign instanceof Error && /not found/i.test(foreign.message)
    );
  }

  // ── an unpaid payment has nothing to reverse ───────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store, {
      status: "PENDING",
      settle: false,
    });

    await throws(
      "an unsettled payment cannot be refunded",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "10.00" },
          deps(store, adapter)
        ),
      /only a settled payment/i
    );
    ok("and the provider was never called", adapter.calls === 0);
  }
  {
    // PAID on the request but no settlement row: the ledger, not the status
    // field, is what a refund is computed against.
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store, { settle: false });

    await throws(
      "a request marked PAID with no settled transaction is refused",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "10.00" },
          deps(store, adapter)
        ),
      /no settled transaction/i
    );
  }

  // ── a provider without the capability fails closed ─────────────────────
  {
    const store = createInMemoryPaymentStore();
    const request = await settledPayment(store);

    await throws(
      "a provider with no refund capability is refused, not emulated",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "10.00" },
          deps(store, nonRefundingProvider())
        ),
      PaymentRefundUnsupportedError
    );

    const rows = await store.listTransactionsByRequest(request.id);
    ok(
      "and nothing was written that would imply a reversal",
      rows.filter((t) => Number(t.amount) < 0).length === 0
    );
  }

  // ── a disabled provider cannot be refunded through ─────────────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    store.seedConnection({
      businessId: 1,
      provider: "SUMIT",
      isActive: true,
      merchantId: "m-1",
    });
    const request = await store.createPaymentRequest({
      businessId: 1,
      customerId: null,
      billingDocumentId: null,
      provider: "SUMIT",
      amount: "100.00",
      currency: "ILS",
      description: null,
      status: "PAID",
      expiresAt: null,
    });
    await store.createTransaction({
      paymentRequestId: request.id,
      provider: "SUMIT",
      providerTransactionId: "s-1",
      amount: "100.00",
      currency: "ILS",
      status: "PAID",
      rawPayload: "customerid=1&documentid=2&valid=true",
    });

    await throws(
      "a provider the platform has withdrawn cannot be refunded through",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "10.00" },
          deps(store, adapter)
        ),
      /not available/i
    );
    ok("and the provider was never called", adapter.calls === 0);
  }

  // ── provider failure never reads as success ────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const request = await settledPayment(store);
    const exploding: PaymentProviderAdapter = {
      ...refundingProvider(),
      async refundPayment() {
        throw new Error("provider said no");
      },
    };

    await throws(
      "a provider refusal surfaces as a failure",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "40.00" },
          deps(store, exploding)
        ),
      /provider said no/i
    );

    const rows = await store.listTransactionsByRequest(request.id);
    const reversals = rows.filter((t) => Number(t.amount) < 0);
    ok("the reservation is left behind as FAILED, not PAID", reversals.length === 1);
    ok("and it is marked FAILED", reversals[0]!.status === "FAILED");

    // A definite refusal releases the money, so the full amount is refundable
    // again — otherwise one provider error would strand a customer's refund.
    const balance = await getRefundableBalance(store, {
      businessId: 1,
      requestId: request.id,
    });
    ok("a definite refusal releases the reserved amount", balance.refundableRemaining === "100.00");
    ok("and nothing counts as refunded", balance.refundedTotal === "0.00");

    const audit = await store.listAuditEvents(1, { paymentRequestId: request.id });
    ok(
      "the failure is on the audit record",
      audit.some((a) => a.eventType === "PAYMENT_REFUND_FAILED")
    );
  }

  // ── an indeterminate outcome stays open and blocks a retry ─────────────
  {
    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider("UNKNOWN");
    const request = await settledPayment(store);

    const res = await refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "40.00" },
      deps(store, adapter)
    );

    ok("an unestablished refund is reported as UNKNOWN", res.outcome === "UNKNOWN");
    ok("it is NOT reported as settled", res.refund.status !== "PAID");
    ok("the row stays PENDING", res.refund.status === "PENDING");
    ok("and its amount stays committed", res.refundedTotal === "40.00");

    const balance = await getRefundableBalance(store, {
      businessId: 1,
      requestId: request.id,
    });
    ok("the balance reflects the open reversal", balance.refundableRemaining === "60.00");
    ok("and says so explicitly", balance.hasUnresolvedRefund === true);

    // THE POINT OF ALL OF IT. A retry after an unestablished refund is the one
    // way this design can spend money twice, so it is refused outright.
    await throws(
      "a retry after an unestablished refund is refused",
      () =>
        refundPaymentRequest(
          { businessId: 1, actorUserId: 7, requestId: request.id, amount: "40.00" },
          deps(store, adapter)
        ),
      PaymentRefundInFlightError
    );
    ok("the provider was asked exactly once, not twice", adapter.calls === 1);

    const audit = await store.listAuditEvents(1, { paymentRequestId: request.id });
    ok(
      "the open state is on the audit record",
      audit.some((a) => a.eventType === "PAYMENT_REFUND_INDETERMINATE")
    );
  }

  // ── two refunds racing on one payment ──────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const request = await settledPayment(store, { amount: "100.00" });

    // Both callers read the ledger before either writes, which is exactly the
    // interleaving the refundable check alone cannot survive.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const slow: PaymentProviderAdapter = {
      ...refundingProvider(),
      async refundPayment() {
        entered++;
        await gate;
        return { providerRefundId: `refund-race-${entered}`, outcome: "REFUNDED" };
      },
    };

    const first = refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "100.00" },
      deps(store, slow)
    );
    const second = refundPaymentRequest(
      { businessId: 1, actorUserId: 7, requestId: request.id, amount: "100.00" },
      deps(store, slow)
    );

    release();
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    ok("exactly one of two racing refunds succeeds", fulfilled.length === 1, String(fulfilled.length));
    ok("and the other is refused", rejected.length === 1);

    const rows = await store.listTransactionsByRequest(request.id);
    const settledReversals = rows.filter(
      (t) => Number(t.amount) < 0 && t.status === "PAID"
    );
    const total = settledReversals.reduce((s, t) => s + Math.abs(Number(t.amount)), 0);
    ok("only one reversal settled", settledReversals.length === 1);
    ok("so the payment was never over-refunded", total === 100);
  }

  // ── the SUMIT adapter reaches the seam unchanged ───────────────────────
  {
    // The one place a real provider appears. What is being checked is that the
    // already-proven SUMIT mechanism is what the generic seam drives — not a
    // second implementation written for the domain's convenience.
    const calls: { url: string; body: unknown }[] = [];
    const sumit = createSumitProvider({
      baseUrl: "https://sumit.test",
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            Status: 0,
            Data: { Payment: { ID: 987, ValidPayment: true, Status: "000" } },
          }),
        };
      },
    });

    ok("the SUMIT adapter declares the refund capability", typeof sumit.refundPayment === "function");

    const res = await sumit.refundPayment!({
      merchantId: "4242",
      credential: JSON.stringify({ apiKey: "key" }),
      amount: "12.50",
      currency: "ILS",
      description: "partial",
      paymentRequestId: 55,
      settlement: {
        providerTransactionId: "77",
        amount: "50.00",
        currency: "ILS",
        // The real shape: the form-encoded IPN body, stored verbatim.
        rawPayload: "customerid=31415&documentid=99&valid=true",
      },
    });

    ok("it settles", res.outcome === "REFUNDED");
    ok("and returns the credit's own id", res.providerRefundId === "987");

    const body = calls[0]!.body as Record<string, unknown>;
    const items = body.Items as { UnitPrice: number }[];
    ok("it posts to the charge endpoint, because SUMIT has no refund endpoint", calls[0]!.url.endsWith("/billing/payments/charge/"));
    ok("the amount is negative", items[0]!.UnitPrice === -12.5);
    ok("SupportCredit is set", body.SupportCredit === true);
    ok(
      "and the customer is the one from the STORED settlement body",
      JSON.stringify(body.Customer) === JSON.stringify({ ID: 31415 })
    );
    ok("no PaymentMethod block is sent", body.PaymentMethod === undefined);

    // Without a recoverable customer id there is nothing to credit, and the
    // adapter must say so rather than guess or default.
    await throws(
      "a settlement with no recoverable customer id is refused",
      () =>
        sumit.refundPayment!({
          merchantId: "4242",
          credential: JSON.stringify({ apiKey: "key" }),
          amount: "1.00",
          currency: "ILS",
          paymentRequestId: 55,
          settlement: {
            providerTransactionId: "77",
            amount: "50.00",
            currency: "ILS",
            rawPayload: "documentid=99&valid=true",
          },
        }),
      /no customer id/i
    );
    ok("and it never reached SUMIT", calls.length === 1);
  }

  // ── other providers are untouched ──────────────────────────────────────
  {
    const { resolvePaymentProvider } = await import("./providers/provider-registry");
    const cardcom = resolvePaymentProvider("CARDCOM");
    ok(
      "CardCom still declares no refund capability, so nothing changed for it",
      typeof cardcom.refundPayment !== "function"
    );

    const store = createInMemoryPaymentStore();
    const adapter = refundingProvider();
    const request = await settledPayment(store);

    // A normal charge flow on the same store is unaffected by the new columns
    // of behaviour: the settlement reads back exactly as it was written.
    const rows = await store.listTransactionsByRequest(request.id);
    ok("an ordinary settlement is unchanged", rows.length === 1 && rows[0]!.amount === "100.00");
    ok("and still carries its provider id", rows[0]!.providerTransactionId === `settle-${request.id}`);
    void adapter;
  }

  console.log(`\npayment-refund: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
