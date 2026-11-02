/**
 * Extraction findings from the business-9 Production pilot (2026-11-02) — and their neighbours.
 * Run: npx tsx lib/services/documents/extraction-pilot-findings.verify.test.ts
 *
 * Pure: no database, no OCR provider. The texts are written the way an OCR reads such pages (several
 * layouts per document), and most cases are NOT the pilot file, so the fixes cannot be fitted to it:
 *   1. amounts with thousands separators survive the text cleaner (an invoice of 1,180.00 was read as 180,
 *      the VAT line, with high confidence);
 *   2. a total the document's own summary contradicts is never confident;
 *   3. a form field label is not part of the vendor name;
 *   4. "מע״מ" / "חשבונית מס" on a document do not make its category "tax";
 *   5. the Z / settlement question speaks of the direction the owner chose.
 */
import assert from "node:assert/strict";
import { cleanOCRText } from "./text-cleaner.service";
import { extractAmountEntity, readSummaryLines, summaryContradiction } from "./entities/amount-entity.service";
import { extractVendorEntity, stripVendorFieldLabel } from "./entities/vendor-entity.service";
import { matchCategoryKeyword } from "./category-decision.service";
import { revenueReportQuestionText } from "./revenue-report-guard";
import { applyAmountStrategy, brokenThousandsFragments } from "./amount-strategy.service";
import { applyVendorStrategy, isDocumentNumberFragment } from "./vendor-strategy.service";
import { parseDocumentStructure } from "./document-structure.service";
import { amountCheckMessage } from "./amount-check";

/** The amount the way the engine computes it: cleaned text → amount entity → strategy layer. */
const engineAmountOf = (raw: string) => {
  const c = cleanOCRText(raw);
  return applyAmountStrategy(c, extractAmountEntity(c));
};
/** The vendor the way the engine computes it: entity → strategy layer (no business ids). */
const engineVendorOf = (raw: string) => {
  const c = cleanOCRText(raw);
  const st = parseDocumentStructure(c);
  return applyVendorStrategy(st, [], extractVendorEntity(c, st, [])).name;
};

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
const lines = (...l: string[]) => l.join("\n");
const amountOf = (raw: string) => extractAmountEntity(cleanOCRText(raw));

console.log("\n1. the text cleaner keeps a whole amount together");
for (const [raw, kept] of [
  ["סה״כ לתשלום ₪ 1,180.00", "1,180.00"],
  ["סה״כ 12,345.60 ₪", "12,345.60"],
  ["לתשלום 1,234,567.89", "1,234,567.89"],
  ["סה״כ 236.00", "236.00"],
] as const) {
  check(`${kept} stays one line`, () => {
    const out = cleanOCRText(raw).split("\n");
    assert.ok(out.includes(kept), JSON.stringify(out));
  });
}

console.log("\n2. totals with thousands — several layouts, several documents");
const pilotInvoice = {
  textLayer: lines(
    "2026-0042 חשבונית מס", "ספק: ספק פיקטיבי לבדיקות בע״מ", "14/10/2026 תאריך:",
    "תיאור\tכמות\tסכום", "שירותי בדיקה פיקטיביים\t1\t₪ 1,000.00",
    "סה״כ לפני מע״מ\t₪ 1,000.00", "18% מע״מ\t₪ 180.00", "סה״כ לתשלום\t₪ 1,180.00"
  ),
  columns: lines(
    "חשבונית מס 2026-0042", "ספק: ספק פיקטיבי לבדיקות בע״מ", "תיאור", "שירותי בדיקה פיקטיביים",
    "סה״כ לפני מע״מ", "מע״מ 18%", "סה״כ לתשלום", "סכום", "1,000.00 ₪", "1,000.00 ₪", "180.00 ₪", "1,180.00 ₪"
  ),
  ltrRows: lines(
    "חשבונית מס 2026-0042", "1,000.00 ₪ 1 שירותי בדיקה פיקטיביים", "1,000.00 ₪ סה״כ לפני מע״מ",
    "180.00 ₪ מע״מ 18%", "1,180.00 ₪ סה״כ לתשלום"
  ),
};
for (const [layout, text] of Object.entries(pilotInvoice)) {
  check(`pilot invoice (${layout}) → 1,180.00, confident`, () => {
    const a = amountOf(text);
    assert.equal(a.value, 1180);
    assert.ok(a.confidence >= 0.85, String(a.confidence));
  });
}
check("another invoice: 10,462.37 + 1,883.23 = 12,345.60", () => {
  const a = amountOf(lines(
    "חשבונית מס 7781", "אלקטרו-טק שירותים בע״מ", "התקנת מערכת מיזוג",
    "סה״כ לפני מע״מ ₪10,462.37", "מע״מ 18% ₪1,883.23", "סה״כ כולל מע״מ ₪12,345.60"
  ));
  assert.equal(a.value, 12345.6);
  assert.ok(a.confidence >= 0.85, String(a.confidence));
});
check("a six-figure invoice: 104,624.39 + 18,832.39 = 123,456.78", () => {
  const a = amountOf(lines(
    "חשבונית מס/קבלה 12", "בנייה ופיתוח בע״מ",
    "סה״כ לפני מע״מ 104,624.39 ש״ח", "מע״מ 18,832.39 ש״ח", "סה״כ לתשלום 123,456.78 ש״ח"
  ));
  assert.equal(a.value, 123456.78);
  assert.ok(a.confidence >= 0.85, String(a.confidence));
});
check("summary lines are read from the cleaned text (labels and amounts on separate lines)", () => {
  const s = readSummaryLines(cleanOCRText(lines("סה״כ לפני מע״מ ₪ 1,000.00", "מע״מ 18% ₪ 180.00", "סה״כ לתשלום ₪ 1,180.00")));
  assert.deepEqual(s, { subtotal: 1000, vat: 180, total: 1180 });
});
check("columns read one after the other cannot be paired — nothing is invented", () => {
  const s = readSummaryLines(cleanOCRText(lines("סה״כ לפני מע״מ", "מע״מ 18%", "סה״כ לתשלום", "1,000.00 ₪", "180.00 ₪", "1,180.00 ₪")));
  assert.equal(summaryContradiction(1180, s), null);
});
check("a receipt under 1,000 is unchanged (236.00)", () => {
  const a = amountOf(lines("קבלה 2026-0007", "בית קפה פיקטיבי לבדיקות", "200.00 ₪", "מע״מ 18%", "36.00 ₪", "סה״כ שולם", "236.00 ₪"));
  assert.equal(a.value, 236);
});

console.log("\n3. a contradicted total is a question, never a confident answer");
const roles = (subtotal: number | null, vat: number | null, total: number | null) => ({ subtotal, vat, total });
check("the VAT line's value is not a total", () => assert.match(String(summaryContradiction(180, roles(1000, 180, 1180))), /VAT/));
check("subtotal + VAT must add up", () => assert.match(String(summaryContradiction(1200, roles(1000, 180, null))), /add up/));
check("a larger stated total contradicts", () => assert.match(String(summaryContradiction(1000, roles(null, null, 1180))), /larger/));
check("a consistent summary is no contradiction", () => assert.equal(summaryContradiction(1180, roles(1000, 180, 1180)), null));
check("no summary read → nothing invented", () => assert.equal(summaryContradiction(236, roles(null, null, null)), null));
check("end to end: 1,000 + 180 printed, total printed 1,200 → needs review", () => {
  const a = amountOf(lines("חשבונית מס 55", "ספק כלשהו בע״מ", "סה״כ לפני מע״מ ₪ 1,000.00", "מע״מ 18% ₪ 180.00", "סה״כ לתשלום ₪ 1,200.00"));
  assert.ok(a.confidence < 0.85, `confidence ${a.confidence}`);
  assert.equal(a.needsReview, true);
});

console.log("\n4. a field label is not the vendor's name");
for (const [raw, name] of [
  ["ספק: ספק פיקטיבי לבדיקות בע״מ", "ספק פיקטיבי לבדיקות בע״מ"],
  ["שם הספק: אלקטרו-טק שירותים בע״מ", "אלקטרו-טק שירותים בע״מ"],
  ["הספק : מאפיית השחר", "מאפיית השחר"],
  ["Supplier: Acme Ltd", "Acme Ltd"],
  ["Vendor name: Zoom Video Communications", "Zoom Video Communications"],
  ["ספקי הגליל בע״מ", "ספקי הגליל בע״מ"], // a real name that starts with the word — kept
  ["ספק ציוד משרדי בע״מ", "ספק ציוד משרדי בע״מ"], // no colon — not a label
  ["ספק:", "ספק:"], // nothing after the label — never an empty name
] as const) {
  check(`${raw} → ${name}`, () => assert.equal(stripVendorFieldLabel(raw), name));
}

console.log("\n5. category: the document's vocabulary is not its subject");
check("a café receipt with מע״מ is not tax", () =>
  assert.notEqual(matchCategoryKeyword("קבלה בית קפה פיקטיבי לבדיקות ארוחת צוות מע״מ 18% סה״כ שולם"), "tax"));
check("a tax invoice for a repair is services, not tax", () =>
  assert.equal(matchCategoryKeyword("חשבונית מס 1042 תיקון מזגן מע\"מ 17%"), "services"));
check("a plain חשבונית מס קבלה with no subject is not tax", () =>
  assert.notEqual(matchCategoryKeyword("חשבונית מס קבלה 88 סה\"כ 590.00"), "tax"));
check("an actual income-tax advance payment is tax", () =>
  assert.equal(matchCategoryKeyword("שובר תשלום מקדמות מס הכנסה לחודש 10/2026"), "tax"));
check("a VAT payment to the authority is tax", () =>
  assert.equal(matchCategoryKeyword("אישור תשלום מע״מ לתקופה 09-10/2026 רשות המסים"), "tax"));

console.log("\n6. the Z question speaks of the chosen direction");
check("income → כהכנסה", () => assert.match(revenueReportQuestionText("z_report", "income"), /כהכנסה/));
check("expense → כהוצאה, never כהכנסה", () => {
  const t = revenueReportQuestionText("z_report", "expense");
  assert.match(t, /כהוצאה/);
  assert.doesNotMatch(t, /כהכנסה/);
});

console.log("\n7. no total is invented — the pilot's Z page (doc 198) was given 1,500, an amount nowhere on it");
const zPage = {
  inline: lines("דוח Z מספר 1", "סגירת קופה · קופה 1 · 30/10/2026", "סה״כ מכירות 500.00", "מזומן 200.00", "אשראי 300.00", "מספר עסקאות 7"),
  split: lines("דוח Z מספר 1", "סגירת קופה · קופה 1 · 30/10/2026", "סה״כ מכירות", "500.00", "מזומן", "200.00", "אשראי", "300.00", "מספר עסקאות", "7"),
  columns: lines("דוח Z מספר 1", "סגירת קופה · קופה 1 · 30/10/2026", "סה״כ מכירות", "מזומן", "אשראי", "מספר עסקאות", "500.00", "200.00", "300.00", "7"),
};
for (const [layout, text] of Object.entries(zPage)) {
  check(`Z page (${layout}): never 1,500, never confident`, () => {
    const a = engineAmountOf(text);
    assert.notEqual(a.value, 1500);
    assert.ok(a.confidence < 0.85, String(a.confidence));
  });
}
check("a page with three amounts and no cut number offers nothing to rebuild", () =>
  assert.deepEqual(brokenThousandsFragments(cleanOCRText(zPage.inline)), []));
check("an amount the OCR really cut is still rebuilt — from the thousands it shows — and goes to review", () => {
  const text = lines("חשבונית מס 300", "חברת דוגמה בע״מ", "סה״כ לפני מע״מ ₪ 1,", "250.00", "מע״מ 18% ₪ 225.00", "סה״כ לתשלום ₪ 1,", "475.00");
  assert.deepEqual(brokenThousandsFragments(cleanOCRText(text)), [1000]);
  const a = engineAmountOf(text);
  assert.equal(a.value, 1475);
  assert.ok(a.confidence < 0.85, String(a.confidence));
});

console.log("\n8. a fragment of the document's title or number is never the vendor");
for (const [s, frag] of [
  ["מס 55", true], ["מספר 1042", true], ["קבלה 7", true], ["2026-0042", true], ["חשבונית מס 300", true],
  ["ספק כלשהו בע״מ", false], ["7 כוכבים בע״מ", false], ["מס הכנסה", false], ["דוח Z מספר 1", false],
] as const) {
  check(`${s} → ${frag ? "fragment" : "a name"}`, () => assert.equal(isDocumentNumberFragment(s), frag));
}
check("'מס 55' no longer steals the anchor of the vendor line under it", () =>
  assert.equal(engineVendorOf(lines("חשבונית מס 55", "ספק כלשהו בע״מ", "סה״כ לתשלום ₪ 1,180.00")), "ספק כלשהו בע״מ"));
check("the pilot invoice's vendor through the whole engine path", () =>
  assert.equal(stripVendorFieldLabel(engineVendorOf(pilotInvoice.textLayer) ?? ""), "ספק פיקטיבי לבדיקות בע״מ"));

console.log("\n9. the review screen is told WHY an amount is in doubt");
check("1,000 + 180 printed, 1,200 read → the sentence names the lines", () => {
  const m = amountCheckMessage(lines("סה״כ לפני מע״מ ₪ 1,000.00", "מע״מ 18% ₪ 180.00", "סה״כ לתשלום ₪ 1,200.00"), 1200);
  assert.ok(m && m.includes("1,000.00") && m.includes("180.00") && m.includes("1,200.00"), String(m));
});
check("the VAT line read as the amount → said so", () => {
  const m = amountCheckMessage(pilotInvoice.ltrRows, 180);
  assert.ok(m && m.includes("מע״מ"), String(m));
});
check("a consistent document → no message", () => assert.equal(amountCheckMessage(pilotInvoice.ltrRows, 1180), null));
check("no OCR text → no message", () => assert.equal(amountCheckMessage(null, 1180), null));

console.log(`\n[extraction-pilot-findings] PASS=${pass} FAIL=${fail}`);
if (fail > 0) process.exit(1);
