/**
 * Receipt PDF (HTML renderer): titled "קבלה", the money RECEIVED (never "סה"כ לתשלום"), the payment lines instead of
 * the issuer's bank details, and an exempt dealer presented as "עוסק פטור" — never "עוסק מורשה". Other document types
 * are unchanged (the A0 golden proves it).
 *
 *   npx tsx lib/services/billing/pdf/billing-pdf-receipt.test.ts
 */
import { buildCases } from "../../../../.billing-a0/fixtures";
import { buildBillingInvoiceHtml, type PdfReceiptPayment } from "@/lib/services/billing/pdf/billing-pdf-html-template";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";

let failed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) { console.error("FAIL:", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : ""); failed += 1; return; }
  console.log("OK:", name);
}
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const cases = buildCases();
const receipt = cases.find((c) => c.key === "RECEIPT.classic")!.snapshot as unknown as BillingIssuedSnapshotV1;
const invoice = cases.find((c) => c.key === "TAX_INVOICE.classic")!.snapshot as unknown as BillingIssuedSnapshotV1;
const exemptReceipt: BillingIssuedSnapshotV1 = {
  ...receipt,
  issuer: { ...receipt.issuer, vatRegistration: null },
  extensions: { ...(receipt.extensions ?? {}), billingBusinessKind: "EXEMPT_DEALER" },
};
const payments: PdfReceiptPayment[] = [
  { method: "BANK_TRANSFER", amount: "600.00", currency: "ILS", paymentDate: "2026-07-15T08:00:00.000Z", bankName: "12", bankBranch: "345",
    bankAccountNumber: "678901", checkNumber: null, checkDueDate: null, cardBrand: null, cardLast4: null, reference: "TR-55" },
  { method: "CHECK", amount: "400.00", currency: "ILS", paymentDate: "2026-07-15T08:00:00.000Z", bankName: "10", bankBranch: "800",
    bankAccountNumber: "112233", checkNumber: "5001", checkDueDate: "2026-08-15T00:00:00.000Z", cardBrand: null, cardLast4: null, reference: null },
];

const ex = text(buildBillingInvoiceHtml(exemptReceipt, "data:,", payments));
ok("title is 'קבלה', not the raw key 'RECEIPT'", ex.includes("קבלה") && !/\bRECEIPT\b/.test(ex));
ok("the total is 'סה\"כ התקבל' — never 'סה\"כ לתשלום'", ex.includes('סה"כ התקבל') && !ex.includes('סה"כ לתשלום'));
ok("no 'before VAT' / VAT rows on a receipt", !ex.includes('סה"כ לפני מע"מ'));
ok("the payment lines are printed: method, details, amounts",
  ex.includes("העברה בנקאית") && ex.includes("חשבון 678901") && ex.includes("אסמכתה TR-55") && ex.includes("שיק") && ex.includes("שיק 5001") && ex.includes("600.00") && ex.includes("400.00"), ex);
ok("no 'לא הוגדרו פרטי תשלום' placeholder and no issuer bank details on a receipt", !ex.includes("לא הוגדרו פרטי תשלום") && !ex.includes("פרטי תשלום"));
ok("an exempt dealer is stated as 'עוסק פטור'", ex.includes("עוסק פטור"));
ok("an exempt dealer is never presented as 'עוסק מורשה'", !ex.includes("עוסק מורשה"));

const noPay = text(buildBillingInvoiceHtml(exemptReceipt, "data:,", []));
ok("a receipt without stored payment lines says so (no invented method)", noPay.includes("אמצעי התשלום לא נשמרו במסמך"));

// Every supported track, with a recorded payment: title, money RECEIVED, the method, no "not set" placeholder.
const cashPayment: PdfReceiptPayment[] = [
  { method: "CASH", amount: "1000.00", currency: "ILS", paymentDate: "2026-07-15T08:00:00.000Z", bankName: null, bankBranch: null,
    bankAccountNumber: null, checkNumber: null, checkDueDate: null, cardBrand: null, cardLast4: null, reference: null },
];
const tracks: { kind: string; vat: string | null; exempt: boolean }[] = [
  { kind: "EXEMPT_DEALER", vat: null, exempt: true },
  { kind: "AUTHORIZED_DEALER", vat: "999999998", exempt: false },
  { kind: "LTD_COMPANY", vat: "999999998", exempt: false },
];
for (const tr of tracks) {
  const snap: BillingIssuedSnapshotV1 = {
    ...receipt,
    issuer: { ...receipt.issuer, vatRegistration: tr.vat },
    extensions: { ...(receipt.extensions ?? {}), billingBusinessKind: tr.kind },
  };
  const t = text(buildBillingInvoiceHtml(snap, "data:,", cashPayment));
  ok(`${tr.kind}: title 'קבלה', not 'RECEIPT'`, t.includes("קבלה") && !/\bRECEIPT\b/.test(t));
  ok(`${tr.kind}: the money is 'סה"כ התקבל', never 'סה"כ לתשלום'`, t.includes('סה"כ התקבל') && !t.includes('סה"כ לתשלום'));
  ok(`${tr.kind}: the payment method is printed (מזומן, 1,000.00)`, t.includes("אמצעי תשלום") && t.includes("מזומן") && t.includes("1,000.00"), t);
  ok(`${tr.kind}: no 'לא הוגדרו פרטי תשלום' placeholder when a payment is recorded`, !t.includes("לא הוגדרו פרטי תשלום"));
  ok(`${tr.kind}: 'עוסק פטור' ${tr.exempt ? "stated" : "absent"}`, t.includes("עוסק פטור") === tr.exempt);
  ok(`${tr.kind}: 'עוסק מורשה' ${tr.exempt ? "absent" : "stated (VAT number)"}`, t.includes("עוסק מורשה") === !tr.exempt);
}

// An OLD receipt: its issued snapshot froze no classification and its payment rows were never stored. It renders, it
// invents nothing (no method, no status line), and it does not fall back to the issuer's bank details.
{
  const { billingBusinessKind: _dropped, ...extNoKind } = (receipt.extensions ?? {}) as Record<string, unknown>;
  void _dropped;
  const oldNoKind: BillingIssuedSnapshotV1 = { ...receipt, extensions: extNoKind };
  const oldNoExt = { ...receipt } as Partial<BillingIssuedSnapshotV1>;
  delete oldNoExt.extensions;
  for (const [label, snap] of [["no frozen kind", oldNoKind], ["no extensions at all", oldNoExt as BillingIssuedSnapshotV1]] as const) {
    let html = "";
    let threw: unknown = null;
    try { html = buildBillingInvoiceHtml(snap, "data:,", []); } catch (e) { threw = e; }
    ok(`old receipt (${label}): renders without throwing`, threw === null && html.length > 0, String(threw));
    const t = text(html);
    ok(`old receipt (${label}): says the payment methods were not stored`, t.includes("אמצעי התשלום לא נשמרו במסמך"));
    ok(`old receipt (${label}): no invented payment method`,
      !["מזומן", "העברה בנקאית", "שיק", "כרטיס אשראי", "ביט", "פייבוקס", "הוראת קבע"].some((m) => t.includes(m)), t);
    ok(`old receipt (${label}): no 'עוסק פטור' inferred`, !t.includes("עוסק פטור"));
    ok(`old receipt (${label}): no issuer bank details / 'not set' placeholder`, !t.includes("פרטי תשלום") && !t.includes("לא הוגדרו"));
    ok(`old receipt (${label}): title 'קבלה' and money received`, t.includes("קבלה") && t.includes('סה"כ התקבל'));
  }
}

const inv = text(buildBillingInvoiceHtml(invoice, "data:,"));
ok("a tax invoice is unchanged: 'חשבונית מס', 'סה\"כ לתשלום', bank details", inv.includes("חשבונית מס") && inv.includes('סה"כ לתשלום') && inv.includes("פרטי תשלום"));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
