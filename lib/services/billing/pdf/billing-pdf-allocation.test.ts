/**
 * Verifies the ACTUAL PDF output carries the authority allocation number when
 * present (and omits it when absent). Run manually:
 *   npx tsx lib/services/billing/pdf/billing-pdf-allocation.test.ts
 * Pure — renders the HTML template string, no browser / DB.
 */
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { buildBillingInvoiceHtml } from "@/lib/services/billing/pdf/billing-pdf-html-template";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

function snapshot(allocationNumber: string | null): BillingIssuedSnapshotV1 {
  return {
    schemaVersion: 1,
    issuedAt: "2026-06-15T10:00:00.000Z",
    document: { id: 42, type: "TAX_INVOICE", status: "ISSUED", number: 7, numberFormatted: "000007", currency: "ILS", allocationNumber, referenceDocumentId: null },
    issuer: { id: 3, name: "דוביז", legalName: "דוביז", taxId: "515000123", vatRegistration: "515000123", address: null, phone: null, email: null, logoUrl: null, bankDetails: null },
    customer: { id: 7, name: "לקוח", legalName: null, taxId: null, phone: null, email: null, city: "תל אביב", address: null },
    lines: [{ lineIndex: 0, description: "שירות", quantity: "1.0000", unitPrice: "100.0000", vatRatePercent: "17.00", lineSubtotal: "100.00", vatAmount: "17.00", lineTotal: "117.00" }],
    totals: { subtotal: "100.00", vat: "17.00", total: "117.00" },
    tax: { currency: "ILS", defaultVatRate: null, vatMode: "EXCLUSIVE" },
    metadata: { locale: "he-IL", timezone: "Asia/Jerusalem", actorUserId: 1, source: "manual" },
    pdfTemplateStyle: "CLASSIC",
    extensions: {},
  } as unknown as BillingIssuedSnapshotV1;
}

// With allocation number → output includes the "מספר הקצאה" row + the value.
{
  const html = buildBillingInvoiceHtml(snapshot("20240718181618323199093572"), "");
  ok("PDF output includes allocation label", html.includes("מספר הקצאה"));
  ok("PDF output includes the allocation number", html.includes("20240718181618323199093572"));
}

// Without allocation number → the row is omitted (no false/empty allocation).
{
  const html = buildBillingInvoiceHtml(snapshot(null), "");
  ok("PDF output omits allocation row when absent", !html.includes("מספר הקצאה"));
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll billing PDF allocation-number tests passed.");
