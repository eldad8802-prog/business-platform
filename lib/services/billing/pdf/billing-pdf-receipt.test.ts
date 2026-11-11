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

const inv = text(buildBillingInvoiceHtml(invoice, "data:,"));
ok("a tax invoice is unchanged: 'חשבונית מס', 'סה\"כ לתשלום', bank details", inv.includes("חשבונית מס") && inv.includes('סה"כ לתשלום') && inv.includes("פרטי תשלום"));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
