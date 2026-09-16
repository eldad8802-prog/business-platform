/**
 * Run: npx tsx lib/services/payments/payment-optional-provider-id.test.ts
 *
 * The two generic capability changes, tested at the ORCHESTRATION level rather
 * than inside any adapter:
 *
 *   1. a provider may return no session id at checkout, and
 *   2. a callback may be authenticated by an opaque per-request URL secret
 *      instead of by a signature.
 *
 * The point of testing them here is that both are claims about the payments
 * domain, not about SUMIT. The adapters below are synthetic; a real provider
 * appears only where the test is specifically about not regressing one.
 */
import { readFileSync } from "node:fs";
import {
  processPaymentWebhook,
  type ProcessWebhookDeps,
} from "./payment-webhook.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import {
  generateCallbackSecret,
  hashCallbackSecret,
} from "./payment-callback-secret";
import { resolvePaymentProvider } from "./providers/provider-registry";
import type {
  PaymentProviderAdapter,
  ProviderPaymentStatus,
} from "./providers/payment-provider.types";

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

/**
 * A provider in the SUMIT shape: no session id, no signature, and an
 * authoritative lookup keyed on our own correlation value.
 */
function idlessProvider(
  status: ProviderPaymentStatus,
  opts: { eventId?: string } = {}
): PaymentProviderAdapter & { seen: { correlationValue?: string | null }[] } {
  const seen: { correlationValue?: string | null }[] = [];
  const adapter: PaymentProviderAdapter = {
    provider: "SUMIT",
    supportedCurrencies: ["ILS"],
    usesCallbackSecret: true,
    async createPaymentLink(input) {
      return {
        paymentUrl: `https://pay.example/${input.callbackSecret ? "ok" : "no-secret"}`,
        providerRequestId: null,
      };
    },
    async verifyWebhook() {
      return { ok: true };
    },
    parseWebhook: () => ({
      providerEventId: opts.eventId ?? "doc-1",
      eventType: "sumit_ipn",
      providerRequestId: null,
      providerTransactionId: null,
      outcome: "PENDING",
      amount: null,
      currency: null,
    }),
    async getPaymentStatus(input) {
      seen.push({ correlationValue: input.correlationValue });
      return status;
    },
  };
  return Object.assign(adapter, { seen });
}

async function seed(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  opts: { businessId?: number; secret?: string | null } = {}
) {
  const businessId = opts.businessId ?? 1;
  store.seedConnection({ businessId, provider: "SUMIT", isActive: true, merchantId: "m1" });
  const created = await store.createPaymentRequest({
    businessId,
    customerId: null,
    billingDocumentId: null,
    provider: "SUMIT",
    amount: "100.00",
    currency: "ILS",
    description: null,
    status: "PENDING",
    expiresAt: null,
  });
  // A provider that issues no id stores none — the whole point of change 1.
  await store.updatePaymentRequest(created.id, { providerRequestId: null });
  if (opts.secret !== null) {
    await store.upsertProviderRouting({
      provider: "SUMIT",
      providerRequestId: null,
      callbackSecretHash: hashCallbackSecret(opts.secret ?? generateCallbackSecret()),
      paymentRequestId: created.id,
      businessId,
    });
  }
  return created;
}

function deps(
  store: ReturnType<typeof createInMemoryPaymentStore>,
  adapter: PaymentProviderAdapter
): ProcessWebhookDeps {
  return {
    store,
    resolveProvider: () => adapter,
    decryptConnectionCredential: () => JSON.stringify({ apiKey: "k" }),
  };
}

async function main() {
  // ── 1. A PROVIDER WITH NO SESSION ID CAN STILL SETTLE ───────────────────
  {
    const store = createInMemoryPaymentStore();
    const secret = generateCallbackSecret();
    const request = await seed(store, { secret });
    const adapter = idlessProvider({ outcome: "PAID", providerTransactionId: "t-1" });

    const res = await processPaymentWebhook(
      { provider: "SUMIT", rawBody: "documentid=1&valid=true", callbackSecret: secret },
      deps(store, adapter)
    );

    ok("a callback with no provider id settles via the URL secret", res.ok === true);
    ok("and reaches PAID", res.paymentRequestStatus === "PAID");
    ok("and is marked provider-verified", res.verified === true);
    ok("and names the right request", res.paymentRequestId === request.id);
    ok(
      "the authority call received OUR correlation value, not a provider id",
      adapter.seen[0]?.correlationValue === String(request.id)
    );
    ok("exactly one settlement transaction", store.transactions.length === 1);
  }

  // ── 2. THE SECRET IS THE AUTHENTICATION DECISION ────────────────────────
  {
    const cases: [string, (s: string) => string | null][] = [
      ["a wrong secret", () => generateCallbackSecret()],
      ["a one-character-different secret", (s) => s.slice(0, -1) + "X"],
      ["a truncated secret", (s) => s.slice(0, 16)],
      ["an empty secret", () => ""],
      ["a missing secret", () => null],
    ];

    for (const [label, mutate] of cases) {
      const store = createInMemoryPaymentStore();
      const secret = generateCallbackSecret();
      await seed(store, { secret });
      const adapter = idlessProvider({ outcome: "PAID", providerTransactionId: "t-1" });

      const res = await processPaymentWebhook(
        {
          provider: "SUMIT",
          rawBody: "documentid=1&valid=true",
          callbackSecret: mutate(secret),
        },
        deps(store, adapter)
      );

      ok(`${label} does not settle`, res.ok === false);
      ok(`${label} leaves no transaction`, store.transactions.length === 0);
      ok(`${label} leaves the request PENDING`, res.paymentRequestStatus !== "PAID");
      ok(
        `${label} never reaches the provider`,
        adapter.seen.length === 0
      );
    }
  }

  // ── 3. A SECRET CANNOT CROSS TENANTS ────────────────────────────────────
  //
  // Two businesses, each with its own request and secret. Presenting one
  // business's secret must resolve that business's request and no other.
  {
    const store = createInMemoryPaymentStore();
    const secretA = generateCallbackSecret();
    const secretB = generateCallbackSecret();
    const reqA = await seed(store, { businessId: 1, secret: secretA });
    const reqB = await seed(store, { businessId: 2, secret: secretB });
    const adapter = idlessProvider({ outcome: "PAID", providerTransactionId: "t-1" });

    const res = await processPaymentWebhook(
      { provider: "SUMIT", rawBody: "documentid=1&valid=true", callbackSecret: secretB },
      deps(store, adapter)
    );

    ok("B's secret settles B's request", res.paymentRequestId === reqB.id);
    ok("and never A's", res.paymentRequestId !== reqA.id);
    ok(
      "the settlement is recorded against B only",
      store.transactions.length === 1 &&
        store.transactions[0]!.paymentRequestId === reqB.id
    );
  }

  // ── 4. IDEMPOTENCY ──────────────────────────────────────────────────────
  {
    const store = createInMemoryPaymentStore();
    const secret = generateCallbackSecret();
    await seed(store, { secret });
    const adapter = idlessProvider({ outcome: "PAID", providerTransactionId: "t-1" });
    const input = {
      provider: "SUMIT" as const,
      rawBody: "documentid=1&valid=true",
      callbackSecret: secret,
    };

    const first = await processPaymentWebhook(input, deps(store, adapter));
    const second = await processPaymentWebhook(input, deps(store, adapter));

    ok("the first delivery settles", first.ok === true);
    ok("a replayed delivery is recognised as a duplicate", second.duplicate === true);
    ok("and settles only once", store.transactions.length === 1);
  }

  // ── 5. NO ROUTING ROW MEANS NO SETTLEMENT ───────────────────────────────
  //
  // A request created without either route in cannot be reached by a callback.
  // That is the correct outcome, not an omission.
  {
    const store = createInMemoryPaymentStore();
    await seed(store, { secret: null });
    const adapter = idlessProvider({ outcome: "PAID", providerTransactionId: "t-1" });

    const res = await processPaymentWebhook(
      {
        provider: "SUMIT",
        rawBody: "documentid=1&valid=true",
        callbackSecret: generateCallbackSecret(),
      },
      deps(store, adapter)
    );
    ok("with no routing row, no callback can settle", res.ok === false);
    ok("and nothing is written", store.transactions.length === 0);
  }

  // ── 6. THE PAYLOAD IS STILL NOT AUTHORITY ───────────────────────────────
  //
  // The secret proves WHICH request. It must not prove WHAT happened.
  {
    const store = createInMemoryPaymentStore();
    const secret = generateCallbackSecret();
    await seed(store, { secret });
    // The provider's authoritative answer says the payment did NOT succeed,
    // while the callback body cheerfully claims valid=true.
    const adapter = idlessProvider({ outcome: "FAILED", providerTransactionId: "t-1" });

    const res = await processPaymentWebhook(
      { provider: "SUMIT", rawBody: "documentid=1&valid=true", callbackSecret: secret },
      deps(store, adapter)
    );
    ok(
      "a correctly authenticated callback still cannot assert PAID",
      res.paymentRequestStatus !== "PAID"
    );
    ok("the provider's answer wins", res.paymentRequestStatus === "FAILED");
  }
  {
    const store = createInMemoryPaymentStore();
    const secret = generateCallbackSecret();
    await seed(store, { secret });
    const adapter = idlessProvider({ outcome: "UNKNOWN", providerTransactionId: null });

    const res = await processPaymentWebhook(
      { provider: "SUMIT", rawBody: "documentid=1&valid=true", callbackSecret: secret },
      deps(store, adapter)
    );
    ok(
      "an UNKNOWN provider answer settles nothing",
      res.paymentRequestStatus !== "PAID" && res.paymentRequestStatus !== "FAILED"
    );
  }

  // ── 7. EXISTING PROVIDERS ARE UNTOUCHED ─────────────────────────────────
  {
    const cardcom = resolvePaymentProvider("CARDCOM");
    ok(
      "CardCom does not declare the callback-secret capability",
      cardcom.usesCallbackSecret !== true
    );
    const paypal = resolvePaymentProvider("PAYPAL");
    ok(
      "PayPal does not declare it either",
      paypal.usesCallbackSecret !== true
    );
    const tranzila = resolvePaymentProvider("TRANZILA");
    ok(
      "Tranzila does not declare it either",
      tranzila.usesCallbackSecret !== true
    );
    ok(
      "SUMIT is the only provider that does",
      resolvePaymentProvider("SUMIT").usesCallbackSecret === true
    );
  }
  {
    // The providerRequestId route in must still work exactly as before.
    const store = createInMemoryPaymentStore();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, merchantId: "m1" });
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
    await store.updatePaymentRequest(created.id, { providerRequestId: "lp-1" });
    await store.upsertProviderRouting({
      provider: "CARDCOM",
      providerRequestId: "lp-1",
      paymentRequestId: created.id,
      businessId: 1,
    });

    const adapter: PaymentProviderAdapter = {
      provider: "CARDCOM",
      supportedCurrencies: null,
      async createPaymentLink() {
        throw new Error("unused");
      },
      async verifyWebhook() {
        return { ok: true };
      },
      parseWebhook: () => ({
        providerEventId: "evt-1",
        eventType: "payment",
        providerRequestId: "lp-1",
        providerTransactionId: null,
        outcome: "PENDING",
        amount: "100.00",
        currency: "ILS",
      }),
      async getPaymentStatus() {
        return { outcome: "PAID", providerTransactionId: "t-9" };
      },
    };

    const res = await processPaymentWebhook(
      { provider: "CARDCOM", rawBody: "{}" },
      deps(store, adapter)
    );
    ok("a session-id provider still correlates and settles", res.ok === true);
    ok("and reaches PAID", res.paymentRequestStatus === "PAID");
    ok("with no callback secret involved anywhere", store.transactions.length === 1);
  }
  {
    // And a secret must not be usable as a substitute for a missing id on a
    // provider that does not declare the capability.
    const store = createInMemoryPaymentStore();
    const secret = generateCallbackSecret();
    store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true, merchantId: "m1" });
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
    await store.upsertProviderRouting({
      provider: "SUMIT",
      providerRequestId: null,
      callbackSecretHash: hashCallbackSecret(secret),
      paymentRequestId: created.id,
      businessId: 1,
    });

    const found = await store.findPaymentRequestByCallbackSecretHash(
      "CARDCOM",
      hashCallbackSecret(secret)!
    );
    ok(
      "a secret minted under one provider cannot resolve another provider's callback",
      found === null
    );
  }

  {
    // THE PERSISTENCE GAP THIS CLOSES.
    //
    // Every test above runs against the in-memory store, which persists a
    // routing row by spreading it whole. The Prisma store names its columns one
    // by one, so a field added to the row type and computed by the creation
    // flow can be dropped there while NOTHING fails: the row is written, the
    // checkout succeeds, and only a later callback is refused — in production,
    // for a provider whose callback has no other way to name its request.
    //
    // So the assertion is about the class, not the instance: whatever
    // UpsertProviderRoutingRow declares, the Prisma upsert has to write.
    const types = readFileSync(
      new URL("./payments.types.ts", import.meta.url),
      "utf8"
    );
    const storeSource = readFileSync(
      new URL("./payment-store.prisma.ts", import.meta.url),
      "utf8"
    );

    const iface =
      types.split("export interface UpsertProviderRoutingRow {")[1] ?? "";
    const declared = iface
      .split(/\r?\n\}/)[0]
      .split(/\r?\n/)
      .map((line) => /^ {2}([A-Za-z][A-Za-z0-9]*)\??:/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));

    ok("the routing row type still declares fields", declared.length >= 4);

    const body = (
      storeSource.split("async upsertProviderRouting(row) {")[1] ?? ""
    ).split(/\r?\n {4}\},/)[0];
    const createBranch = (body.split("create: {")[1] ?? "").split("},")[0];
    const updateBranch = (body.split("update: {")[1] ?? "").split("},")[0];

    ok("the Prisma routing upsert was located", body.length > 0);

    // Nothing may be missing from the row as first written.
    const missingOnCreate = declared.filter(
      (name) => !createBranch.includes(name + ":")
    );
    ok(
      "the Prisma store writes every declared routing field on create",
      missingOnCreate.length === 0,
      missingOnCreate.join(", ")
    );

    // Re-issuing a link re-mints whatever names the request, so the update
    // branch has to carry it too. The exceptions are the row's own identity —
    // its where key — and its tenant, neither of which may ever change.
    const IMMUTABLE_ROUTING_FIELDS = new Set(["paymentRequestId", "businessId"]);
    const missingOnUpdate = declared.filter(
      (name) =>
        !IMMUTABLE_ROUTING_FIELDS.has(name) && !updateBranch.includes(name + ":")
    );
    ok(
      "and re-writes every mutable one, so a re-issued link leaves no stale route",
      missingOnUpdate.length === 0,
      missingOnUpdate.join(", ")
    );

    ok(
      "the tenant is never re-written by a later call",
      !updateBranch.includes("businessId:")
    );
  }

  console.log(
    `\npayment-optional-provider-id: ${pass} passed, ${failures.length} failed`
  );
  if (failures.length > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
