/**
 * Unit tests for customer taxId freezing in issuedSnapshot (run manually):
 *   npx tsx lib/services/billing/billing-issue-snapshot.test.ts
 *
 * Pure: exercises buildIssuedSnapshot + hashIssuedSnapshot (no DB) and the
 * existing PDF doc-definition builder. Deterministic.
 */
import { BillingDocument, BillingDocumentLine, Prisma } from "@prisma/client";
import {
  buildIssuedSnapshot,
  hashIssuedSnapshot,
} from "@/lib/services/billing/billing-issue.service";
import { buildDocDefinition } from "@/lib/services/billing/pdf/billing-pdf-template";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const ISSUED_AT = new Date("2026-06-15T10:00:00.000Z");

function doc(): BillingDocument {
  return {
    id: 42,
    documentType: "TAX_INVOICE",
    status: "ISSUED",
    currency: "ILS",
    referenceDocumentId: null,
    customerNameSnapshot: "לקוח",
  } as unknown as BillingDocument;
}

function lines(): BillingDocumentLine[] {
  return [
    {
      lineIndex: 0,
      description: "שירות",
      quantity: new Prisma.Decimal("1"),
      unitPrice: new Prisma.Decimal("100"),
      vatRatePercent: new Prisma.Decimal("17"),
      lineSubtotal: new Prisma.Decimal("100"),
      vatAmount: new Prisma.Decimal("17"),
      lineTotal: new Prisma.Decimal("117"),
    } as unknown as BillingDocumentLine,
  ];
}

const business = {
  id: 3,
  name: "Dubiz",
  profile: {
    billingLegalName: "דוביז בע\"מ",
    billingBusinessKind: "LTD_COMPANY",
    billingTaxId: "515000123",
    billingVatNumber: "515000123",
    billingPhone: null,
    billingEmail: null,
    billingAddress: null,
    billingPaymentNote: null,
    billingFooterNote: null,
    billingLogoDataUrl: null,
    billingPdfTemplateStyle: null,
  },
};

const totals = {
  subtotalAmount: new Prisma.Decimal("100"),
  vatAmount: new Prisma.Decimal("17"),
  totalAmount: new Prisma.Decimal("117"),
};

function customer(taxId: string | null) {
  return { id: 7, name: "לקוח", phone: null, email: null, city: "תל אביב", taxId };
}

function buildArgs(cust: ReturnType<typeof customer> | null) {
  return {
    document: doc(),
    lines: lines(),
    business,
    customer: cust,
    documentNumber: 7,
    documentNumberFormatted: "000007",
    issuedAt: ISSUED_AT,
    actorUserId: 1,
    totals,
  };
}

// ---- 1. customer WITH taxId ----
{
  const snap = buildIssuedSnapshot(buildArgs(customer("514000000")));
  ok("taxId frozen into snapshot", snap.customer.taxId === "514000000");
  const docDef = buildDocDefinition(snap as unknown as BillingIssuedSnapshotV1);
  const json = JSON.stringify(docDef);
  ok("PDF shows customer ע.מ./ת.ז. row + value", json.includes("ע.מ./ת.ז.") && json.includes("514000000"));
}

// ---- 2. customer WITHOUT taxId ----
{
  const snap = buildIssuedSnapshot(buildArgs(customer(null)));
  ok("null taxId → snapshot null", snap.customer.taxId === null);
  const json = JSON.stringify(buildDocDefinition(snap as unknown as BillingIssuedSnapshotV1));
  // Issuer row uses "ע.מ./ח.פ." — the customer-specific label must be absent.
  ok("PDF omits customer ע.מ./ת.ז. row when null", !json.includes("ע.מ./ת.ז."));
}

// ---- 3. no customer at all ----
{
  const snap = buildIssuedSnapshot(buildArgs(null));
  ok("no customer → taxId null (no regression)", snap.customer.taxId === null && snap.customer.id === null);
}

// ---- 4. hash includes taxId + determinism ----
{
  const withTax = buildIssuedSnapshot(buildArgs(customer("514000000")));
  const withTax2 = buildIssuedSnapshot(buildArgs(customer("514000000")));
  const nullTax = buildIssuedSnapshot(buildArgs(customer(null)));
  const otherTax = buildIssuedSnapshot(buildArgs(customer("514999999")));
  ok("hash deterministic (same input → same hash)", hashIssuedSnapshot(withTax) === hashIssuedSnapshot(withTax2));
  ok("hash differs when taxId present vs null", hashIssuedSnapshot(withTax) !== hashIssuedSnapshot(nullTax));
  ok("hash differs when taxId value changes", hashIssuedSnapshot(withTax) !== hashIssuedSnapshot(otherTax));
}

// ---- 5. snapshot value is reflected as-is (no normalize/parse) ----
{
  const raw = "  514000000  ";
  const snap = buildIssuedSnapshot(buildArgs(customer(raw)));
  ok("taxId stored as-is (no normalize/parse)", snap.customer.taxId === raw);
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll billing-issue snapshot taxId tests passed.");
