/**
 * Phase C — Document Number detector unit test (run manually, no DB):
 *   npx tsx lib/services/documents/entities/document-number-entity.qa.test.ts
 */

import { extractDocumentNumber } from "@/lib/services/documents/entities/document-number-entity.service";

let failed = 0;
function eq(name: string, got: string | null, want: string | null) {
  if (got !== want) {
    console.error(`FAIL: ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

// --- positive: labeled document numbers ---
eq("מספר חשבונית", extractDocumentNumber("מספר חשבונית: 1023"), "1023");
eq("חשבונית מס'", extractDocumentNumber("חשבונית מס' 2024/0012"), "2024/0012");
eq("חשבונית מספר", extractDocumentNumber("חשבונית מספר 778899"), "778899");
eq("מס' חשבונית", extractDocumentNumber("מס׳ חשבונית 4501"), "4501");
eq("קבלה מס'", extractDocumentNumber("קבלה מס' 5567"), "5567");
eq("מספר קבלה", extractDocumentNumber("מספר קבלה 88"), "88");
eq("מספר מסמך", extractDocumentNumber("מספר מסמך 9001"), "9001");
eq("אסמכתא", extractDocumentNumber("אסמכתא 0036-2024"), "0036-2024");

// --- label on its own line, number wraps to next line ---
eq(
  "label then next line",
  extractDocumentNumber("מספר חשבונית\n200345\nתאריך 05/06/2026"),
  "200345"
);

// --- negatives: must NOT be captured ---
eq("tax id alone → null", extractDocumentNumber("ח.פ 514999999"), null);
eq("authorized dealer alone → null", extractDocumentNumber("עוסק מורשה 987654321"), null);
eq("date alone → null", extractDocumentNumber("תאריך: 05/06/2026"), null);
eq("amount alone → null", extractDocumentNumber('סה"כ לתשלום: 117.00'), null);
eq("phone alone → null", extractDocumentNumber("טלפון: 03-1234567"), null);
eq("no label → null", extractDocumentNumber("ספק בדיקה בעמ\nפריט שירות\n100"), null);

// --- disambiguation: pick the invoice number, not the tax id on the same line ---
eq(
  "tax id + invoice on same line → invoice",
  extractDocumentNumber("ח.פ 514999999 מספר חשבונית 1023"),
  "1023"
);

// --- realistic multi-line invoice ---
const INVOICE = [
  "חשבונית מס / קבלה",
  'ספק בדיקה בע"מ',
  "ח.פ 514111111",
  "מספר חשבונית: 2024-7781",
  "תאריך: 05/06/2026",
  'סה"כ לתשלום: ₪117.00',
].join("\n");
eq("realistic invoice → 2024-7781", extractDocumentNumber(INVOICE), "2024-7781");

if (failed > 0) {
  console.error(`\n${failed} detector check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll document-number detector checks passed.");
