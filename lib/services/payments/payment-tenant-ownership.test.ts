/**
 * Run: npx tsx lib/services/payments/payment-tenant-ownership.test.ts
 *
 * SEC-02 — a payment request may not reference another tenant's records.
 *
 * The defect: `createPaymentRequest` validated that `customerId` and
 * `billingDocumentId` were positive integers and nothing else. Neither was
 * resolved, so neither was known to belong to the business creating the
 * request. The foreign keys were no defence: PostgreSQL evaluates referential
 * integrity with row security bypassed, so the constraint would have accepted
 * another tenant's row without complaint.
 *
 * This file proves the APPLICATION layer. The DATABASE layer is proven
 * separately, against real PostgreSQL under FORCE RLS, in `.p7w4ea/battery.mjs`
 * — the two are deliberately not merged, because a guard that exists only in
 * the application is one refactor away from being gone, and one that exists
 * only in the database gives a caller no usable error.
 *
 * No DB, no network.
 */
import assert from "node:assert/strict";
import { createPaymentRequest } from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";

const BIZ_A = 1;
const BIZ_B = 2;

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

function deps(store: ReturnType<typeof createInMemoryPaymentStore>) {
  return {
    store,
    resolveProvider: () => createStubProvider({ supportedCurrencies: ["ILS"] }),
    decryptConnectionCredential: () => "credential",
  };
}

/** Two tenants, each connected, each owning one customer and one invoice. */
function twoTenants() {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: BIZ_A, provider: "CARDCOM", isActive: true });
  store.seedConnection({ businessId: BIZ_B, provider: "CARDCOM", isActive: true });
  store.seedCustomer({ id: 100, businessId: BIZ_A });
  store.seedCustomer({ id: 200, businessId: BIZ_B });
  store.seedDocument({
    id: 900,
    businessId: BIZ_A,
    totalAmount: "500.00",
    outstandingAmount: "500.00",
  });
  store.seedDocument({
    id: 901,
    businessId: BIZ_B,
    totalAmount: "500.00",
    outstandingAmount: "500.00",
  });
  return store;
}

async function main() {
  // ── the positive case: own references work ──────────────────────────────
  {
    const store = twoTenants();
    const res = await createPaymentRequest(
      {
        businessId: BIZ_A,
        amount: "100.00",
        customerId: 100,
        billingDocumentId: 900,
      },
      deps(store)
    );
    ok(
      "same-tenant customer + document are accepted",
      res.paymentRequest.customerId === 100 &&
        res.paymentRequest.billingDocumentId === 900
    );
  }

  // ── cross-tenant document ───────────────────────────────────────────────
  {
    const store = twoTenants();
    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: BIZ_A, amount: "100.00", billingDocumentId: 901 },
          deps(store)
        ),
      /Billing document not found/
    );
    ok("A cannot reference B's billing document", true);
    ok(
      "and no PaymentRequest row is created by the attempt",
      store.requests.length === 0
    );
  }

  // ── cross-tenant customer ───────────────────────────────────────────────
  {
    const store = twoTenants();
    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: BIZ_A, amount: "100.00", customerId: 200 },
          deps(store)
        ),
      /Customer not found/
    );
    ok("A cannot reference B's customer", true);
    ok("and no PaymentRequest row is created", store.requests.length === 0);
  }

  // ── mixed references: one valid, one foreign ────────────────────────────
  {
    const store = twoTenants();
    await assert.rejects(
      () =>
        createPaymentRequest(
          {
            businessId: BIZ_A,
            amount: "100.00",
            customerId: 100, // A's own
            billingDocumentId: 901, // B's
          },
          deps(store)
        ),
      /Billing document not found/
    );
    ok("a mixed pair is refused on the foreign half", true);
  }
  {
    const store = twoTenants();
    await assert.rejects(
      () =>
        createPaymentRequest(
          {
            businessId: BIZ_A,
            amount: "100.00",
            customerId: 200, // B's
            billingDocumentId: 900, // A's own
          },
          deps(store)
        ),
      /Customer not found/
    );
    ok("the mirrored mixed pair is refused too", true);
  }

  // ── existence is not disclosed ──────────────────────────────────────────
  //
  // A foreign id and an id that does not exist at all must be indistinguishable,
  // or the error message becomes an oracle for enumerating another tenant's
  // records.
  {
    const store = twoTenants();
    const foreign = await createPaymentRequest(
      { businessId: BIZ_A, amount: "100.00", billingDocumentId: 901 },
      deps(store)
    ).catch((e: Error) => e.message);
    const missing = await createPaymentRequest(
      { businessId: BIZ_A, amount: "100.00", billingDocumentId: 999999 },
      deps(store)
    ).catch((e: Error) => e.message);
    ok(
      "a foreign document and a missing one are reported identically",
      foreign === missing,
      `foreign=${String(foreign)} missing=${String(missing)}`
    );
  }
  {
    const store = twoTenants();
    const foreign = await createPaymentRequest(
      { businessId: BIZ_A, amount: "100.00", customerId: 200 },
      deps(store)
    ).catch((e: Error) => e.message);
    const missing = await createPaymentRequest(
      { businessId: BIZ_A, amount: "100.00", customerId: 999999 },
      deps(store)
    ).catch((e: Error) => e.message);
    ok(
      "a foreign customer and a missing one are reported identically",
      foreign === missing
    );
  }

  // ── the reverse direction is symmetric, not accidental ──────────────────
  {
    const store = twoTenants();
    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: BIZ_B, amount: "100.00", billingDocumentId: 900 },
          deps(store)
        ),
      /Billing document not found/
    );
    ok("B cannot reference A's document either", true);
  }

  // ── the store lookups are themselves tenant-scoped ──────────────────────
  {
    const store = twoTenants();
    ok(
      "findPayableDocument returns null across tenants",
      (await store.findPayableDocument(BIZ_A, 901)) === null &&
        (await store.findPayableDocument(BIZ_B, 900)) === null
    );
    ok(
      "findPayableDocument returns the row within its own tenant",
      (await store.findPayableDocument(BIZ_A, 900))?.id === 900
    );
    ok(
      "findCustomerRef returns null across tenants",
      (await store.findCustomerRef(BIZ_A, 200)) === null &&
        (await store.findCustomerRef(BIZ_B, 100)) === null
    );
    ok(
      "findCustomerRef returns the row within its own tenant",
      (await store.findCustomerRef(BIZ_A, 100))?.id === 100
    );
  }

  // ── the references are still optional ───────────────────────────────────
  {
    const store = twoTenants();
    const res = await createPaymentRequest(
      { businessId: BIZ_A, amount: "100.00" },
      deps(store)
    );
    ok(
      "a standalone charge needs neither reference",
      res.paymentRequest.customerId === null &&
        res.paymentRequest.billingDocumentId === null
    );
  }

  console.log(
    `\npayment-tenant-ownership: ${pass} passed, ${failures.length} failed`
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
