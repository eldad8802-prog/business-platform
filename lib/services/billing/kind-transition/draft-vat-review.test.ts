/**
 * 4a T3 — the review fingerprint and the owner's wording (pure). The database rule (scope, origin, events, gates,
 * concurrency) is proven by .billing-4a/t3-draft-vat-review.battery.mts.
 *
 * Run: npx tsx lib/services/billing/kind-transition/draft-vat-review.test.ts
 */
import { BILLING_AUDIT_EVENT_TYPES } from "@/lib/services/billing/billing-audit.service";
import {
  DRAFT_VAT_REVIEW_BUTTON,
  DRAFT_VAT_REVIEW_EVENT,
  DRAFT_VAT_REVIEW_MESSAGE,
  VAT_REVIEW_TYPES,
  vatReviewFingerprint,
} from "@/lib/services/billing/kind-transition/draft-vat-review";
import { billingEn } from "@/lib/i18n/messages/areas/billing.en";
import { billingHe } from "@/lib/i18n/messages/areas/billing";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  - ${name}`);
  else { failed += 1; console.error(`FAIL  - ${name}`); }
}

const base = {
  id: 7, documentType: "TAX_INVOICE", currency: "ILS", customerId: 3, referenceDocumentId: null,
  lines: [
    { lineIndex: 1, description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" },
    { lineIndex: 2, description: "שירות לחו״ל", quantity: "1", unitPrice: "300", vatRatePercent: "0" },
  ],
};
const fp = vatReviewFingerprint(base);
ok("F1 64 hex", /^[0-9a-f]{64}$/.test(fp));
ok("F2 stable: same content in another line order / decimal spelling → same fingerprint",
  vatReviewFingerprint({ ...base, lines: [{ ...base.lines[1], vatRatePercent: "0.00", unitPrice: "300.0000" }, { ...base.lines[0], quantity: "1.0000", vatRatePercent: "18.00" }] }) === fp);
const changed = (patch: Partial<typeof base>) => vatReviewFingerprint({ ...base, ...patch }) !== fp;
const lineChanged = (i: number, patch: Record<string, string>) =>
  vatReviewFingerprint({ ...base, lines: base.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }) !== fp;
ok("F3 a VAT-rate change invalidates", lineChanged(1, { vatRatePercent: "18" }));
ok("F3 a price change invalidates", lineChanged(0, { unitPrice: "520" }));
ok("F3 a quantity change invalidates", lineChanged(1, { quantity: "2" }));
ok("F3 a description change invalidates", lineChanged(1, { description: "שירות מקומי" }));
ok("F3 an added line invalidates", vatReviewFingerprint({ ...base, lines: [...base.lines, { lineIndex: 3, description: "x", quantity: "1", unitPrice: "1", vatRatePercent: "0" }] }) !== fp);
ok("F3 another type / currency / customer / credited document invalidates",
  changed({ documentType: "QUOTE" }) && changed({ currency: "USD" }) && changed({ customerId: 4 }) && changed({ referenceDocumentId: 9 as never }));
ok("F3 another document with identical content has another fingerprint (bound to the document)", changed({ id: 8 }));

ok("W1 the owner's wording (D8), message and button", DRAFT_VAT_REVIEW_MESSAGE === "המסמך נוצר לפני המעבר שלך לעוסק מורשה. לפני הפקת המסמך, יש לבדוק ולעדכן את שיעורי המע״מ בהתאם לסוג העסקה."
  && DRAFT_VAT_REVIEW_BUTTON === "בדיקת מע״מ במסמך");
ok("W2 the screen texts match the service's (he)", billingHe.vatReview.message === DRAFT_VAT_REVIEW_MESSAGE && billingHe.vatReview.button === DRAFT_VAT_REVIEW_BUTTON);
ok("W3 English has every key", Object.keys(billingHe.vatReview).every((k) => typeof (billingEn.vatReview as Record<string, string>)[k] === "string"));
ok("E1 the event type is an allowed billing audit event", (BILLING_AUDIT_EVENT_TYPES as readonly string[]).includes(DRAFT_VAT_REVIEW_EVENT));
ok("S1 scope: tax invoice, tax invoice/receipt, quote, credit note — never a receipt",
  JSON.stringify([...VAT_REVIEW_TYPES]) === JSON.stringify(["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "QUOTE", "CREDIT_NOTE"]));

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
