/**
 * Phase B — engine surfacing QA (run manually, no DB):
 *   npx tsx lib/services/documents/persist-extracted-fields.qa.test.ts
 *
 * Verifies that runUnifiedDocumentIntelligence surfaces the already-detected
 * vendor tax id, VAT amount and subtotal amount for persistence (no new
 * detection; only plumbing). prisma.vendorLearning is stubbed so no DB is hit.
 */

import { prisma } from "@/lib/prisma";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";

let failed = 0;
function ok(name: string, condition: boolean, extra?: unknown) {
  if (!condition) {
    console.error("FAIL:", name, extra ?? "");
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

// Stub category learning lookup (only DB call in the path).
(prisma as unknown as Record<string, unknown>).vendorLearning = {
  findUnique: async () => null,
};

const INVOICE_TEXT = [
  "חשבונית מס / קבלה",
  'ספק בדיקה בע"מ',
  "ח.פ 514111111",
  "מספר חשבונית: 2024-7781",
  "תאריך: 05/06/2026",
  "פריט שירות",
  'סכום לפני מע"מ: ₪100.00',
  'מע"מ 17%: ₪17.00',
  'סה"כ לתשלום: ₪117.00',
  "שולם בכרטיס אשראי",
].join("\n");

async function main() {
  const result = await runUnifiedDocumentIntelligence({
    businessId: 9001,
    rawText: INVOICE_TEXT,
  });

  console.log("SURFACED:", {
    vendorTaxId: result.vendorTaxId,
    vatAmount: result.vatAmount,
    subtotalAmount: result.subtotalAmount,
    documentNumber: result.documentNumber,
  });

  ok("vendorTaxId surfaced", result.vendorTaxId === "514111111", result.vendorTaxId);
  ok("vatAmount surfaced", result.vatAmount === 17, result.vatAmount);
  ok("subtotalAmount surfaced", result.subtotalAmount === 100, result.subtotalAmount);
  ok("documentNumber surfaced", result.documentNumber === "2024-7781", result.documentNumber);

  // A document without any of these must surface null (no fabrication).
  const plainText = ["תזכורת לפגישה", "נתראה ביום שני בבוקר"].join("\n");
  const plain = await runUnifiedDocumentIntelligence({
    businessId: 9001,
    rawText: plainText,
  });
  ok("no tax id detected → null", plain.vendorTaxId === null, plain.vendorTaxId);
  ok("no vat detected → null", plain.vatAmount === null, plain.vatAmount);
  ok("no subtotal detected → null", plain.subtotalAmount === null, plain.subtotalAmount);
  ok("no document number detected → null", plain.documentNumber === null, plain.documentNumber);

  if (failed > 0) {
    console.error(`\n${failed} Phase B surfacing check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll Phase B surfacing checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
