/**
 * Revenue report guard — what is asked about, and (just as important) what is not.
 * Run: npx tsx lib/services/documents/revenue-report-guard.verify.test.ts
 *
 * The texts are phrase fixtures, not vendor formats: they stand for what an OCR of such a page contains.
 * Compatibility with a real register's Z or a real acquirer's report is NOT claimed here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectRevenueReport, revenueReportQuestion } from "./revenue-report-guard";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
}

console.log("\n1. Z phrases are recognised in their common spellings");
for (const t of [
  "דוח Z מספר 1234\nסה\"כ מכירות 5,230.00",
  "דו\"ח Z\nקופה 2",
  "דו״ח Z יומי",
  "דו''ח סגירה Z",
  "Z REPORT  #0042",
  "Z-Report",
  "מס' Z: 311",
  "סגירת קופה 01/11/2026",
  "סגירה יומית — קופה ראשית",
  "דוח סוף היום",
]) {
  check(JSON.stringify(t.slice(0, 24)), () => assert.equal(detectRevenueReport(t)?.kind, "z_report"));
}

console.log("\n2. settlement phrases");
for (const t of [
  "דוח סליקה לתקופה 10/2026",
  "דו\"ח זיכויים לבית העסק",
  "פירוט הזיכויים לחשבונך",
  "פירוט עסקאות בכרטיסי אשראי",
  "דוח תקבולים",
  "Settlement report — October",
]) {
  check(JSON.stringify(t.slice(0, 24)), () => assert.equal(detectRevenueReport(t)?.kind, "settlement_report"));
}

console.log("\n3. ordinary documents are NOT questioned");
for (const t of [
  "חשבונית מס 1042\nעוסק מורשה 512345678\nסה\"כ לתשלום 1,170.00",
  "קבלה מס' 88\nתקבול במזומן",
  "חשבונית מס / קבלה — דמי סליקה לחודש אוקטובר", // acquirer fee invoice
  "חשבונית זיכוי 17 — זיכוי על החזרת סחורה", // credit note
  "הזמנת רכש 5512 — מוצר ZX-200",
  "Invoice WNCUOY1C-0001 — Zoom Video Communications",
  "קבלה — תשלום בכרטיס אשראי",
  "",
]) {
  check(JSON.stringify(t.slice(0, 28)), () => assert.equal(detectRevenueReport(t), null));
}
check("null text", () => assert.equal(detectRevenueReport(null), null));

console.log("\n4. when to ask");
check("Z as income → ask", () =>
  assert.equal(revenueReportQuestion({ ocrText: "דוח Z", direction: "income", confirmed: false })?.kind, "z_report"));
check("Z as expense → ask too (a Z is never an expense)", () =>
  assert.equal(revenueReportQuestion({ ocrText: "דוח Z", direction: "expense", confirmed: false })?.kind, "z_report"));
check("settlement as income → ask", () =>
  assert.equal(revenueReportQuestion({ ocrText: "דוח סליקה", direction: "income", confirmed: false })?.kind, "settlement_report"));
check("settlement as expense (the acquirer's fees) → no question", () =>
  assert.equal(revenueReportQuestion({ ocrText: "דוח סליקה", direction: "expense", confirmed: false }), null));
check("the owner's answer ends the question", () =>
  assert.equal(revenueReportQuestion({ ocrText: "דוח Z", direction: "income", confirmed: true }), null));
check("no text (OCR failed) → no question", () =>
  assert.equal(revenueReportQuestion({ ocrText: null, direction: "income", confirmed: false }), null));

console.log("\n5. wiring");
const route = fs.readFileSync(path.join(process.cwd(), "app/api/documents/[id]/approve/route.ts"), "utf8");
check("the approve route asks before any write", () => {
  const ask = route.indexOf("revenueReportQuestion(");
  const firstWrite = route.indexOf("withTenantTransaction(async");
  assert.ok(ask > 0, "revenueReportQuestion is called");
  assert.ok(firstWrite < 0 || ask < firstWrite, "the question comes before the first write transaction");
});
check("the question is a 409 with its own code, the owner's answer is an explicit flag", () => {
  assert.ok(route.includes("REVENUE_REPORT_SUSPECTED"));
  assert.ok(route.includes("body.confirmedNotRevenueReport === true"));
});
check("the file name plays no part", () => {
  const guard = fs.readFileSync(path.join(process.cwd(), "lib/services/documents/revenue-report-guard.ts"), "utf8");
  assert.ok(!/originalFilename|fileName|filename/.test(guard.replace(/\/\*[\s\S]*?\*\//g, "")));
});

console.log(`\n[revenue-report-guard] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
