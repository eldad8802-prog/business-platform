/**
 * Validation: run with
 *   npx tsx lib/services/billing/receipt/billing-receipt.validation.test.ts
 *
 * Covers the pure, regulation-critical logic of Receipt & Payment v1:
 * per-method payment validation + allocation/reconciliation rules.
 */
import assert from "node:assert/strict";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  PaymentMethod,
  Prisma,
} from "@prisma/client";
import { validateAndParsePaymentLine } from "../validation/billing-payment.validation";
import {
  assertAllocationPositive,
  assertAllocationWithinRemaining,
  assertInvoiceAllocatable,
  assertReceiptTotalsReconcile,
  assertSameBusiness,
  assertSameCurrency,
  computeRemainingAllocatable,
  sumAllocationAmounts,
  sumPaymentLineAmounts,
} from "./billing-receipt-allocation.rules";

const D = (v: string | number) => new Prisma.Decimal(v);

// ── Payment line validation ─────────────────────────────────────────────
// CASH: amount + date only; currency defaults to ILS.
const cash = validateAndParsePaymentLine(
  { method: "CASH", amount: "100.00", paymentDate: "2026-06-15" },
  1
);
assert.equal(cash.method, PaymentMethod.CASH);
assert.equal(cash.amount.equals(D("100")), true);
assert.equal(cash.currency, "ILS");
assert.ok(cash.paymentDate instanceof Date);

// amount must be a string, > 0, scale ≤ 2.
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CASH", amount: 100, paymentDate: "2026-06-15" }, 1)
);
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CASH", amount: "0", paymentDate: "2026-06-15" }, 1)
);
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CASH", amount: "1.234", paymentDate: "2026-06-15" }, 1)
);
// bad date / bad currency / bad method.
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CASH", amount: "10", paymentDate: "not-a-date" }, 1)
);
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CASH", amount: "10", paymentDate: "2026-06-15", currency: "us" }, 1)
);
assert.throws(() =>
  validateAndParsePaymentLine({ method: "FOO", amount: "10", paymentDate: "2026-06-15" }, 1)
);
// currency is normalized to uppercase.
assert.equal(
  validateAndParsePaymentLine({ method: "CASH", amount: "10", paymentDate: "2026-06-15", currency: "usd" }, 1).currency,
  "USD"
);

// BANK_TRANSFER: requires bank, branch, account.
assert.throws(() =>
  validateAndParsePaymentLine({ method: "BANK_TRANSFER", amount: "10", paymentDate: "2026-06-15", bankName: "Leumi" }, 1)
);
const transfer = validateAndParsePaymentLine(
  { method: "BANK_TRANSFER", amount: "10", paymentDate: "2026-06-15", bankName: "Leumi", bankBranch: "800", bankAccountNumber: "12345" },
  1
);
assert.equal(transfer.bankAccountNumber, "12345");

// CHECK: requires bank, branch, account, checkNumber, checkDueDate.
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CHECK", amount: "10", paymentDate: "2026-06-15", bankName: "Leumi", bankBranch: "800", bankAccountNumber: "1", checkNumber: "55" }, 1)
);
const check = validateAndParsePaymentLine(
  { method: "CHECK", amount: "10", paymentDate: "2026-06-15", bankName: "Leumi", bankBranch: "800", bankAccountNumber: "1", checkNumber: "55", checkDueDate: "2026-07-15" },
  1
);
assert.ok(check.checkDueDate instanceof Date);

// CREDIT_CARD: requires cardBrand + 4-digit cardLast4.
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CREDIT_CARD", amount: "10", paymentDate: "2026-06-15", cardLast4: "1234" }, 1)
);
assert.throws(() =>
  validateAndParsePaymentLine({ method: "CREDIT_CARD", amount: "10", paymentDate: "2026-06-15", cardBrand: "Visa", cardLast4: "12a4" }, 1)
);
const card = validateAndParsePaymentLine(
  { method: "CREDIT_CARD", amount: "10", paymentDate: "2026-06-15", cardBrand: "Visa", cardLast4: "1234" },
  1
);
assert.equal(card.cardLast4, "1234");

// BIT / PAYBOX / OTHER: require a reference.
for (const m of ["BIT", "PAYBOX", "OTHER"]) {
  assert.throws(() =>
    validateAndParsePaymentLine({ method: m, amount: "10", paymentDate: "2026-06-15" }, 1)
  );
  const ok = validateAndParsePaymentLine(
    { method: m, amount: "10", paymentDate: "2026-06-15", reference: "ref-1" },
    1
  );
  assert.equal(ok.reference, "ref-1");
}

// ── Allocation rules ────────────────────────────────────────────────────
// Allocatable only when TAX_INVOICE + ISSUED.
assert.doesNotThrow(() =>
  assertInvoiceAllocatable({ documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED })
);
assert.throws(() =>
  assertInvoiceAllocatable({ documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.DRAFT })
);
assert.throws(() =>
  assertInvoiceAllocatable({ documentType: BillingDocumentType.QUOTE, status: BillingDocumentStatus.ISSUED })
);

assert.throws(() => assertSameBusiness(1, 2));
assert.doesNotThrow(() => assertSameBusiness(7, 7));
assert.throws(() => assertSameCurrency("ILS", "USD"));
assert.doesNotThrow(() => assertSameCurrency("ILS", "ILS"));
assert.throws(() => assertAllocationPositive(D("0")));
assert.doesNotThrow(() => assertAllocationPositive(D("0.01")));

// Remaining + over-allocation.
assert.equal(computeRemainingAllocatable(D("100"), D("30")).equals(D("70")), true);
assert.throws(() => assertAllocationWithinRemaining(D("71"), D("70")));
assert.doesNotThrow(() => assertAllocationWithinRemaining(D("70"), D("70")));

// Sum helpers.
assert.equal(sumPaymentLineAmounts([{ amount: D("10") }, { amount: D("5.50") }]).equals(D("15.50")), true);
assert.equal(sumAllocationAmounts([{ allocatedAmount: D("3") }, { allocatedAmount: D("4") }]).equals(D("7")), true);

// Reconciliation.
assert.doesNotThrow(() =>
  assertReceiptTotalsReconcile({ documentType: BillingDocumentType.TAX_INVOICE_RECEIPT, documentTotal: D("117"), paymentsTotal: D("117") })
);
assert.throws(() =>
  assertReceiptTotalsReconcile({ documentType: BillingDocumentType.TAX_INVOICE_RECEIPT, documentTotal: D("117"), paymentsTotal: D("100") })
);
assert.doesNotThrow(() =>
  assertReceiptTotalsReconcile({ documentType: BillingDocumentType.RECEIPT, documentTotal: D("50"), paymentsTotal: D("50") })
);
assert.throws(() =>
  assertReceiptTotalsReconcile({ documentType: BillingDocumentType.RECEIPT, documentTotal: D("50"), paymentsTotal: D("49") })
);
assert.throws(() =>
  assertReceiptTotalsReconcile({ documentType: BillingDocumentType.TAX_INVOICE, documentTotal: D("1"), paymentsTotal: D("1") })
);

console.log("billing-receipt v1: all assertions passed");
