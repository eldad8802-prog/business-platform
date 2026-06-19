/**
 * Receipt & Payment v1 — Stage 3 PDF template verify.
 *   npx tsx lib/services/billing/pdf/billing-receipt-pdf.verify.test.ts
 *
 * Pure template/builder test (no Chromium, no DB). Proves the PDF is built
 * ONLY from the issued snapshot, that RECEIPT/TAX_INVOICE_RECEIPT render
 * correctly, and that the snapshot guard accepts receipts.
 */
import assert from "node:assert/strict";
import {
  assertSnapshotV1,
  buildDocDefinition,
  type BillingIssuedSnapshotV1,
} from "./billing-pdf-template";
import { buildBillingInvoiceHtml } from "./billing-pdf-html-template";

const FONT = "data:font/truetype;base64,AAAA";

function baseSnapshot(
  over: Partial<BillingIssuedSnapshotV1>
): BillingIssuedSnapshotV1 {
  return {
    schemaVersion: 1,
    issuedAt: "2026-06-15T00:00:00.000Z",
    document: {
      id: 1,
      type: "TAX_INVOICE",
      status: "ISSUED",
      number: 1,
      numberFormatted: "000001",
      currency: "ILS",
      allocationNumber: null,
      referenceDocumentId: null,
    },
    issuer: {
      id: 1,
      name: "עוסק בדיקה",
      legalName: null,
      taxId: "123456789",
      vatRegistration: null,
      address: null,
      phone: null,
      email: null,
      logoUrl: null,
      bankDetails: null,
    },
    customer: {
      id: 2,
      name: "לקוח בדיקה",
      legalName: null,
      taxId: null,
      phone: null,
      email: null,
      city: null,
      address: null,
    },
    lines: [],
    totals: { subtotal: "0.00", vat: "0.00", total: "0.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    extensions: {},
    ...over,
  };
}

const receiptSnap = baseSnapshot({
  document: { ...baseSnapshot({}).document, type: "RECEIPT", numberFormatted: "000005" },
  lines: [],
  payments: [
    {
      lineIndex: 1,
      method: "BANK_TRANSFER",
      amount: "100.00",
      currency: "ILS",
      paymentDate: "2026-06-15T00:00:00.000Z",
      bankName: "לאומי",
      bankBranch: "800",
      bankAccountNumber: "12345",
      checkNumber: null,
      checkDueDate: null,
      cardBrand: null,
      cardLast4: null,
      reference: null,
    },
  ],
  allocations: [{ invoiceDocumentId: 99, allocatedAmount: "100.00", currency: "ILS" }],
  totals: { subtotal: "0.00", vat: "0.00", total: "100.00" },
});

const tirSnap = baseSnapshot({
  document: { ...baseSnapshot({}).document, type: "TAX_INVOICE_RECEIPT", numberFormatted: "000007" },
  lines: [
    {
      lineIndex: 1,
      description: "שירות",
      quantity: "1",
      unitPrice: "100.00",
      vatRatePercent: "17.00",
      lineSubtotal: "100.00",
      vatAmount: "17.00",
      lineTotal: "117.00",
    },
  ],
  payments: [
    {
      lineIndex: 1,
      method: "CASH",
      amount: "117.00",
      currency: "ILS",
      paymentDate: "2026-06-15T00:00:00.000Z",
      bankName: null,
      bankBranch: null,
      bankAccountNumber: null,
      checkNumber: null,
      checkDueDate: null,
      cardBrand: null,
      cardLast4: null,
      reference: null,
    },
  ],
  totals: { subtotal: "100.00", vat: "17.00", total: "117.00" },
});

// --- Snapshot guard (assertSnapshotV1) ----------------------------------
assert.doesNotThrow(() => assertSnapshotV1(receiptSnap), "RECEIPT (empty lines + payments) is valid");
assert.doesNotThrow(() => assertSnapshotV1(tirSnap), "TAX_INVOICE_RECEIPT is valid");
// Receipt without payments is rejected.
assert.throws(() => assertSnapshotV1(baseSnapshot({ document: { ...baseSnapshot({}).document, type: "RECEIPT" }, lines: [] })));
// Existing rule preserved: a TAX_INVOICE still requires non-empty lines.
assert.throws(() => assertSnapshotV1(baseSnapshot({ lines: [] })));

// --- HTML template (production renderer source) -------------------------
const receiptHtml = buildBillingInvoiceHtml(receiptSnap, FONT);
// Source-of-truth proof: payment data from snapshot.payments appears.
assert.ok(receiptHtml.includes("12345"), "receipt HTML shows bank account from snapshot");
assert.ok(receiptHtml.includes("100.00"), "receipt HTML shows the payment amount");
// Payments section present; goods section absent for a pure RECEIPT.
assert.ok(receiptHtml.includes('aria-label="פירוט תקבול"'), "receipt shows payments section");
assert.ok(!receiptHtml.includes('aria-label="פירוט פריטים"'), "pure receipt hides goods section");

const tirHtml = buildBillingInvoiceHtml(tirSnap, FONT);
// Tax-invoice-receipt shows BOTH goods and payments.
assert.ok(tirHtml.includes('aria-label="פירוט פריטים"'), "TIR shows goods section");
assert.ok(tirHtml.includes('aria-label="פירוט תקבול"'), "TIR shows payments section");
assert.ok(tirHtml.includes("117.00"), "TIR shows the total/payment amount");

// --- pdfmake builder (dev/fallback path) does not throw on receipts -----
const receiptDoc = buildDocDefinition(receiptSnap) as { content?: unknown };
assert.ok(Array.isArray(receiptDoc.content), "pdfmake receipt docDefinition has content");
const tirDoc = buildDocDefinition(tirSnap) as { content?: unknown };
assert.ok(Array.isArray(tirDoc.content), "pdfmake TIR docDefinition has content");

console.log("billing-receipt PDF template: all assertions passed");
