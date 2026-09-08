/**
 * Run: npx tsx lib/services/payments/payment-document-authority.test.ts
 *
 * SEC-01 — when a payment request names a billing document, the SERVER decides
 * what may be collected against it.
 *
 * The defect: the invoice screen posted `amount: doc.totalAmount` from the
 * browser and the server accepted the number. A caller could name a real
 * 10,000 invoice and create a payment link for one shekel; nothing downstream
 * disagreed, because every later check compares against the stored request.
 *
 * The rule chosen, and WHY it is this rule: the authoritative figure is
 * Billing's own `computeOutstanding` — total less receipt allocations less
 * ISSUED credit notes, floored at zero — reused rather than restated. Partial
 * payment is ALLOWED (`0 < amount <= outstanding`) because Billing already
 * represents partial settlement, and demanding the full balance would delete a
 * capability the product has today.
 *
 * These tests also lock the two constants against the billing rules they mirror,
 * so a change to what counts as a debt cannot silently desynchronise the two.
 *
 * No DB, no network.
 */
import assert from "node:assert/strict";
import {
  assertAmountPayableAgainstDocument,
  toMinorUnits,
  PAYABLE_DOCUMENT_TYPE,
  PAYABLE_DOCUMENT_STATUS,
  type PayableDocumentRef,
} from "./payment-document-authority";
import {
  COLLECTIBLE_DOCUMENT_STATUS,
  COLLECTIBLE_DOCUMENT_TYPE,
} from "@/lib/services/billing/collection/awaiting-payment.rules";
import { createPaymentRequest } from "./payment-request.service";
import { createInMemoryPaymentStore } from "./payment-store.memory";
import { createStubProvider } from "./providers/stub/stub.provider";

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

function doc(over: Partial<PayableDocumentRef> = {}): PayableDocumentRef {
  return {
    id: 5,
    businessId: 1,
    documentType: "TAX_INVOICE",
    status: "ISSUED",
    currency: "ILS",
    totalAmount: "1000.00",
    outstandingAmount: "1000.00",
    ...over,
  };
}

function deps(store: ReturnType<typeof createInMemoryPaymentStore>) {
  return {
    store,
    resolveProvider: () => createStubProvider({ supportedCurrencies: ["ILS", "USD"] }),
    decryptConnectionCredential: () => "credential",
  };
}

function seeded() {
  const store = createInMemoryPaymentStore();
  store.seedConnection({ businessId: 1, provider: "CARDCOM", isActive: true });
  return store;
}

async function main() {
  // ── constants stay tied to the billing rules they mirror ────────────────
  ok(
    "the payable document type is the billing collectible type",
    PAYABLE_DOCUMENT_TYPE === COLLECTIBLE_DOCUMENT_TYPE
  );
  ok(
    "the payable document status is the billing collectible status",
    PAYABLE_DOCUMENT_STATUS === COLLECTIBLE_DOCUMENT_STATUS
  );

  // ── minor-unit conversion is exact, and refuses nonsense ────────────────
  ok("2 decimals convert exactly", toMinorUnits("1000.00") === 100000);
  ok("a fractional shekel converts exactly", toMinorUnits("0.07") === 7);
  ok("an amount notorious for float error is exact", toMinorUnits("1.15") === 115);
  ok("garbage yields null", toMinorUnits("abc") === null);
  ok("empty yields null", toMinorUnits("") === null);
  ok("Infinity yields null", toMinorUnits("Infinity") === null);

  // ── the pure rule ───────────────────────────────────────────────────────
  {
    const r = assertAmountPayableAgainstDocument(doc(), {
      amount: "1000.00",
      currency: "ILS",
    });
    ok("the exact outstanding balance is payable", r.outstandingAmount === "1000.00");
  }

  assert.doesNotThrow(() =>
    assertAmountPayableAgainstDocument(doc(), { amount: "400.00", currency: "ILS" })
  );
  ok("a PARTIAL payment is allowed — billing already models partial settlement", true);

  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc(), {
        amount: "1000.01",
        currency: "ILS",
      }),
    /exceeds the document's outstanding balance/
  );
  ok("one agora over the balance is refused", true);

  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc(), { amount: "0.00", currency: "ILS" }),
    /amount must be a positive number/
  );
  ok("zero is refused", true);

  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc(), { amount: "-5.00", currency: "ILS" }),
    /amount must be a positive number/
  );
  ok("a negative amount is refused", true);

  // The balance, not the total, is the ceiling. A partly-settled invoice must
  // not be chargeable for its original face value again.
  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(
        doc({ totalAmount: "1000.00", outstandingAmount: "250.00" }),
        { amount: "1000.00", currency: "ILS" }
      ),
    /outstanding balance of 250.00/
  );
  ok("the OUTSTANDING balance is the ceiling, not the document total", true);

  assert.doesNotThrow(() =>
    assertAmountPayableAgainstDocument(
      doc({ outstandingAmount: "250.00" }),
      { amount: "250.00", currency: "ILS" }
    )
  );
  ok("the remaining balance of a partly-settled invoice is payable in full", true);

  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc({ outstandingAmount: "0.00" }), {
        amount: "1.00",
        currency: "ILS",
      }),
    /no outstanding balance/
  );
  ok("a fully settled or fully credited document has nothing to collect", true);

  // Document state gates.
  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc({ status: "DRAFT" }), {
        amount: "10.00",
        currency: "ILS",
      }),
    /can only be collected against an ISSUED document/
  );
  ok("a DRAFT document is not payable — it has no legal amount", true);

  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc({ documentType: "TAX_INVOICE_RECEIPT" }), {
        amount: "10.00",
        currency: "ILS",
      }),
    /can only be collected against a TAX_INVOICE/
  );
  ok("a TAX_INVOICE_RECEIPT is not payable — it was paid at issuance", true);

  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc({ documentType: "QUOTE" }), {
        amount: "10.00",
        currency: "ILS",
      }),
    /can only be collected against a TAX_INVOICE/
  );
  ok("a QUOTE is not payable", true);

  assert.throws(
    () =>
      assertAmountPayableAgainstDocument(doc(), { amount: "10.00", currency: "USD" }),
    /Currency mismatch/
  );
  ok("a currency that disagrees with the document is refused", true);

  // ── end to end through the service ──────────────────────────────────────

  // THE DELIBERATE BOUNDARY OF SEC-01, stated rather than glossed over.
  //
  // A LOWER amount against a real document is NOT refused, and must not be: it
  // is a part payment, which Billing already models. The guarantee this closure
  // provides is one-sided — an amount can never exceed what is owed, the
  // document must be real and this tenant's, and the amount that reaches the
  // provider is the amount that gets recorded.
  //
  // The danger a lower amount would represent — an invoice marked settled in
  // full by an underpayment — is not reachable today, because a verified
  // payment closes no debt at all. When payment-to-invoice settlement is built,
  // it must allocate the amount actually received rather than treat any
  // successful payment as full settlement. That is the property to test there.
  {
    const store = seeded();
    store.seedDocument({
      id: 42,
      businessId: 1,
      totalAmount: "10000.00",
      outstandingAmount: "10000.00",
    });
    const res = await createPaymentRequest(
      { businessId: 1, amount: "1.00", billingDocumentId: 42 },
      deps(store)
    );
    ok(
      "a lower amount is a PART PAYMENT and is allowed — partial settlement exists in billing",
      res.paymentRequest.amount === "1.00"
    );
    ok(
      "and it is recorded as the amount actually requested, never as the document total",
      store.requests[0]?.amount === "1.00" &&
        store.requests[0]?.billingDocumentId === 42
    );
  }

  // ... and the same body without a document is still a legitimate standalone
  // charge, so the gate has not leaked into the standalone flow.
  {
    const store = seeded();
    const res = await createPaymentRequest(
      { businessId: 1, amount: "1.00" },
      deps(store)
    );
    ok(
      "a standalone charge of any amount is untouched by the document gate",
      res.paymentRequest.amount === "1.00" &&
        res.paymentRequest.billingDocumentId === null
    );
  }

  // An inflated amount is refused too — the ceiling binds in both directions.
  {
    const store = seeded();
    store.seedDocument({
      id: 43,
      businessId: 1,
      totalAmount: "100.00",
      outstandingAmount: "100.00",
    });
    await assert.rejects(
      () =>
        createPaymentRequest(
          { businessId: 1, amount: "500.00", billingDocumentId: 43 },
          deps(store)
        ),
      /exceeds the document's outstanding balance/
    );
    ok("an inflated amount against a real document is refused", true);
  }

  // A valid partial payment goes through and is persisted as asked.
  {
    const store = seeded();
    store.seedDocument({
      id: 44,
      businessId: 1,
      totalAmount: "900.00",
      outstandingAmount: "900.00",
    });
    const res = await createPaymentRequest(
      { businessId: 1, amount: "300.00", billingDocumentId: 44 },
      deps(store)
    );
    ok(
      "a valid partial payment against a document is created",
      res.paymentRequest.amount === "300.00" &&
        res.paymentRequest.billingDocumentId === 44
    );
  }

  // Validation writes nothing back to billing. This closure does not close debts.
  {
    const store = seeded();
    const seededDoc = store.seedDocument({
      id: 45,
      businessId: 1,
      totalAmount: "500.00",
      outstandingAmount: "500.00",
    });
    await createPaymentRequest(
      { businessId: 1, amount: "500.00", billingDocumentId: 45 },
      deps(store)
    );
    const after = await store.findPayableDocument(1, 45);
    ok(
      "creating a payment request settles nothing — the balance is unchanged",
      after?.outstandingAmount === seededDoc.outstandingAmount
    );
  }

  console.log(
    `\npayment-document-authority: ${pass} passed, ${failures.length} failed`
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
