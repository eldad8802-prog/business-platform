/**
 * Unit tests for the ITA allocation payload builder (run manually):
 *   npx tsx lib/services/billing/authority/billing-authority-approval-payload.test.ts
 *
 * Pure: no network, no DB, no env. Deterministic fixtures only.
 */
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import type {
  InvoiceApprovalSuccessResponse,
} from "@/lib/services/billing/authority/billing-authority-approval.types";
import {
  buildInvoiceApprovalPayload,
  APPROVAL_DOCUMENT_TYPE_CODE,
  type ApprovalPayloadErrorCode,
  type BuildInvoiceApprovalPayloadInput,
} from "@/lib/services/billing/authority/billing-authority-approval-payload";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

// A local, clearly-named test value. NOT a tax-authority-approved number.
const TEST_ACCOUNTING_SOFTWARE_NUMBER = 12345678;

function line(over: Partial<BillingIssuedSnapshotV1["lines"][number]> = {}) {
  return {
    lineIndex: 0,
    description: "שירות",
    quantity: "1.0000",
    unitPrice: "100.0000",
    vatRatePercent: "17.00",
    lineSubtotal: "100.00",
    vatAmount: "17.00",
    lineTotal: "117.00",
    ...over,
  };
}

function snapshot(over: {
  type?: string;
  numberFormatted?: string | null;
  issuerTaxId?: string | null;
  issuedAt?: string;
  lines?: BillingIssuedSnapshotV1["lines"];
  totals?: BillingIssuedSnapshotV1["totals"];
  customerName?: string;
  footerNote?: string;
  id?: number;
} = {}): BillingIssuedSnapshotV1 {
  const lines = over.lines ?? [line()];
  return {
    schemaVersion: 1,
    issuedAt: over.issuedAt ?? "2026-06-15T10:00:00.000Z",
    document: {
      id: over.id ?? 42,
      type: over.type ?? "TAX_INVOICE",
      status: "ISSUED",
      number: 7,
      numberFormatted: over.numberFormatted === undefined ? "000007" : over.numberFormatted,
      currency: "ILS",
      allocationNumber: null,
      referenceDocumentId: null,
    },
    issuer: {
      id: 3,
      name: "דוביז",
      legalName: "דוביז בע\"מ",
      taxId: over.issuerTaxId === undefined ? "515000123" : over.issuerTaxId,
      vatRegistration: "515000123",
      address: null,
      phone: null,
      email: null,
      logoUrl: null,
      bankDetails: null,
    },
    customer: {
      id: 7,
      name: over.customerName ?? "לקוח",
      legalName: null,
      taxId: null,
      phone: null,
      email: null,
      city: "תל אביב",
      address: null,
    },
    lines,
    totals: over.totals ?? { subtotal: "100.00", vat: "17.00", total: "117.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    pdfTemplateStyle: "CLASSIC",
    extensions: over.footerNote ? { billingFooterNote: over.footerNote } : {},
  };
}

function input(over: Partial<BuildInvoiceApprovalPayloadInput> = {}): BuildInvoiceApprovalPayloadInput {
  return {
    snapshot: over.snapshot ?? snapshot(),
    customerTaxId: over.customerTaxId === undefined ? "514000000" : over.customerTaxId,
    accountingSoftwareNumber:
      over.accountingSoftwareNumber === undefined
        ? TEST_ACCOUNTING_SOFTWARE_NUMBER
        : over.accountingSoftwareNumber,
  };
}

function errorCodes(r: ReturnType<typeof buildInvoiceApprovalPayload>): ApprovalPayloadErrorCode[] {
  return r.ok ? [] : r.errors.map((e) => e.code);
}

// ---------------------------------------------------------------------------
// Document-type mapping (dedicated allocation map, not the uniform map)
// ---------------------------------------------------------------------------
ok("map TAX_INVOICE → 305", APPROVAL_DOCUMENT_TYPE_CODE.TAX_INVOICE === 305);
ok("map TAX_INVOICE_RECEIPT → 320", APPROVAL_DOCUMENT_TYPE_CODE.TAX_INVOICE_RECEIPT === 320);
ok("map CREDIT_NOTE → 330", APPROVAL_DOCUMENT_TYPE_CODE.CREDIT_NOTE === 330);
ok("map has no QUOTE / RECEIPT", APPROVAL_DOCUMENT_TYPE_CODE.QUOTE === undefined && APPROVAL_DOCUMENT_TYPE_CODE.RECEIPT === undefined);

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------
{
  const r = buildInvoiceApprovalPayload(input());
  ok("TAX_INVOICE builds ok", r.ok, errorCodes(r));
  if (r.ok) {
    const p = r.payload;
    ok("invoice_type 305", p.invoice_type === 305);
    ok("invoice_id = String(document.id)", p.invoice_id === "42");
    ok("invoice_reference_number = numberFormatted", p.invoice_reference_number === "000007");
    ok("vat_number issuer parsed", p.vat_number === 515000123);
    ok("customer_vat_number parsed", p.customer_vat_number === 514000000);
    ok("accounting_software_number passthrough", p.accounting_software_number === TEST_ACCOUNTING_SOFTWARE_NUMBER);
    ok("amount_before_discount = subtotal", p.amount_before_discount === 100);
    ok("discount = 0 (no domain discount)", p.discount === 0);
    ok("payment_amount = subtotal", p.payment_amount === 100);
    ok("vat_amount", p.vat_amount === 17);
    ok("payment_amount_including_vat = total", p.payment_amount_including_vat === 117);
    ok("relation: before - discount = payment", p.amount_before_discount - p.discount === p.payment_amount);
    ok("relation: payment + vat = incl_vat", p.payment_amount + p.vat_amount === p.payment_amount_including_vat);
    ok("items present with one line", p.items?.length === 1);
    ok("item discount = 0", p.items?.[0].discount === 0);
    ok("item price_per_unit excl VAT", p.items?.[0].price_per_unit === 100);
    ok("item total_amount before VAT", p.items?.[0].total_amount === 100);
    ok("customer_name sent", p.customer_name === "לקוח");
    ok("invoice_note omitted when no footer", p.invoice_note === undefined);
  }
}

{
  const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ type: "TAX_INVOICE_RECEIPT" }) }));
  ok("TAX_INVOICE_RECEIPT → 320", r.ok && r.payload.invoice_type === 320, errorCodes(r));
}

// CREDIT_NOTE: mapping is mechanical (330). Sign/semantics are UNVERIFIED and
// intentionally not asserted here (flagged as a discovered blocker).
{
  const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ type: "CREDIT_NOTE" }) }));
  ok("CREDIT_NOTE resolves to 330 structurally (sign NOT asserted)", r.ok && r.payload.invoice_type === 330, errorCodes(r));
}

// Multiple VAT rates across lines.
{
  const snap = snapshot({
    lines: [
      line({ lineIndex: 0, unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" }),
      line({ lineIndex: 1, description: "פטור", unitPrice: "50.0000", vatRatePercent: "0.00", lineSubtotal: "50.00", vatAmount: "0.00", lineTotal: "50.00" }),
    ],
    totals: { subtotal: "150.00", vat: "17.00", total: "167.00" },
  });
  const r = buildInvoiceApprovalPayload(input({ snapshot: snap }));
  ok("multiple VAT rates build ok", r.ok, errorCodes(r));
  if (r.ok) {
    ok("two items", r.payload.items?.length === 2);
    ok("line 0 vat_rate 17", r.payload.items?.[0].vat_rate === 17);
    ok("line 1 vat_rate 0", r.payload.items?.[1].vat_rate === 0);
    ok("relation holds with mixed VAT", r.payload.payment_amount + r.payload.vat_amount === r.payload.payment_amount_including_vat);
  }
}

// invoice_note mapped from extensions.billingFooterNote when present.
{
  const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ footerNote: "תודה" }) }));
  ok("invoice_note from footer", r.ok && r.payload.invoice_note === "תודה", errorCodes(r));
}

// ---------------------------------------------------------------------------
// Dates — Asia/Jerusalem, DST-aware; must NOT day-shift like UTC slicing
// ---------------------------------------------------------------------------
{
  const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ issuedAt: "2026-06-15T10:00:00.000Z" }) }));
  ok("summer regular date", r.ok && r.payload.invoice_date === "2026-06-15" && r.payload.invoice_issuance_date === "2026-06-15");
}
{
  // Summer near-midnight: UTC slice would give 2026-06-14; Jerusalem (+3) → 2026-06-15.
  const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ issuedAt: "2026-06-14T21:30:00.000Z" }) }));
  ok("summer near-midnight → Jerusalem next day", r.ok && r.payload.invoice_date === "2026-06-15", r.ok ? r.payload.invoice_date : errorCodes(r));
}
{
  // Winter near-midnight: UTC slice would give 2026-01-14; Jerusalem (+2) → 2026-01-15.
  const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ issuedAt: "2026-01-14T22:30:00.000Z" }) }));
  ok("winter near-midnight → Jerusalem next day", r.ok && r.payload.invoice_date === "2026-01-15", r.ok ? r.payload.invoice_date : errorCodes(r));
}
{
  const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ issuedAt: "not-a-date" }) }));
  ok("invalid date rejected", !r.ok && errorCodes(r).includes("INVALID_DOCUMENT_DATE"));
}

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------
ok("unsupported type (QUOTE)", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ type: "QUOTE" }) })); return !r.ok && errorCodes(r).includes("UNSUPPORTED_DOCUMENT_TYPE"); })());
ok("unsupported type (RECEIPT)", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ type: "RECEIPT" }) })); return !r.ok && errorCodes(r).includes("UNSUPPORTED_DOCUMENT_TYPE"); })());
ok("missing document number", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ numberFormatted: null }) })); return !r.ok && errorCodes(r).includes("MISSING_DOCUMENT_NUMBER"); })());
ok("document number too long", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ numberFormatted: "1".repeat(21) }) })); return !r.ok && errorCodes(r).includes("DOCUMENT_NUMBER_TOO_LONG"); })());
ok("missing issuer VAT", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ issuerTaxId: null }) })); return !r.ok && errorCodes(r).includes("INVALID_ISSUER_VAT_NUMBER"); })());
ok("missing customer VAT", (() => { const r = buildInvoiceApprovalPayload(input({ customerTaxId: null })); return !r.ok && errorCodes(r).includes("MISSING_CUSTOMER_VAT_NUMBER"); })());
ok("invalid customer VAT (123abc)", (() => { const r = buildInvoiceApprovalPayload(input({ customerTaxId: "123abc" })); return !r.ok && errorCodes(r).includes("INVALID_CUSTOMER_VAT_NUMBER"); })());
ok("missing software number", (() => { const r = buildInvoiceApprovalPayload(input({ accountingSoftwareNumber: null })); return !r.ok && errorCodes(r).includes("MISSING_ACCOUNTING_SOFTWARE_NUMBER"); })());
ok("invalid software number (12ab not auto-valid)", (() => { const r = buildInvoiceApprovalPayload(input({ accountingSoftwareNumber: "12ab" })); return !r.ok && errorCodes(r).includes("INVALID_ACCOUNTING_SOFTWARE_NUMBER"); })());
ok("software number 0 rejected", (() => { const r = buildInvoiceApprovalPayload(input({ accountingSoftwareNumber: 0 })); return !r.ok && errorCodes(r).includes("INVALID_ACCOUNTING_SOFTWARE_NUMBER"); })());
ok("description too long (>30)", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ lines: [line({ description: "א".repeat(31) })] }) })); return !r.ok && errorCodes(r).includes("DESCRIPTION_TOO_LONG"); })());
ok("invalid amount relation", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ totals: { subtotal: "100.00", vat: "17.00", total: "999.00" } }) })); return !r.ok && errorCodes(r).includes("INVALID_AMOUNT_RELATION"); })());
ok("amount out of safe range", (() => { const r = buildInvoiceApprovalPayload(input({ snapshot: snapshot({ totals: { subtotal: "99999999999999.00", vat: "0.00", total: "99999999999999.00" } }) })); return !r.ok && errorCodes(r).includes("INVALID_AMOUNT_VALUE"); })());

// NOTE (documented, intentionally NOT tested): "negative value in a field that
// disallows negatives" — the builder deliberately imposes NO sign rule, to
// avoid inventing a credit-note sign convention. This is a flagged blocker.
// NOTE (documented, not constructible): "invoice_id > 50" — invoice_id is
// String(BillingDocument.id); a numeric id cannot yield a >50-char string.

// ---------------------------------------------------------------------------
// Determinism & no side effects
// ---------------------------------------------------------------------------
{
  const a = input();
  const before = JSON.stringify(a);
  const r1 = buildInvoiceApprovalPayload(a);
  const r2 = buildInvoiceApprovalPayload(input());
  ok("deterministic (identical input → identical payload)", JSON.stringify(r1) === JSON.stringify(r2));
  ok("no input mutation", JSON.stringify(a) === before);
}

// ---------------------------------------------------------------------------
// Response type: confirmation_number is nullable string, allows 26 digits
// ---------------------------------------------------------------------------
{
  const success: InvoiceApprovalSuccessResponse = { status: 200, message: "Invoice approved", confirmation_number: "20240718181618323199093572", approved: true };
  ok("confirmation_number holds 26-digit string", success.confirmation_number !== null && success.confirmation_number.length === 26);
  const nullConf: InvoiceApprovalSuccessResponse = { status: 200, message: "pending", confirmation_number: null, approved: false };
  ok("confirmation_number nullable", nullConf.confirmation_number === null);
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll approval payload builder tests passed.");
