/**
 * Run: npx tsx lib/services/service-desk/quote-core.test.ts
 *
 * Service Desk 1.3c — the pure quote rules (quote.core.ts), no database / network / clock:
 *   H  the canonical content and its docHash: the exact documented "sdq1" array, deterministic, independent of line order
 *      and of the decimal text's scale, sensitive to every content field (a line text, a quantity, a price, a total, the
 *      customer, validUntil), insensitive to non-content (document number, status, id);
 *   A  exact agorot from decimal text — never through a float; malformed / too precise / too large refused;
 *   D  the billing document check: another business, not a QUOTE, not ILS, another customer, no lines, converted, issued;
 *   M  the owner's decision mapping: APPROVE / REJECT by PHONE / IN_PERSON; LINK refused as the customer's channel; the core
 *      action names the row's exact version / total / docHash; a SUPERSEDED / WITHDRAWN / decided row is named by its state;
 *      the approval's charge is the approved total, and a ₪0 approval records none;
 *   K  the frozen-copy key: biz/{b}/service/cases/{c}/quotes/{sha}.pdf, under the ServiceQuote_content prefix;
 *   C  the mapping fits the unchanged case core (approve → IN_REPAIR with the bound approval; reject → READY / QUOTE_REJECTED).
 */
import { createHash } from "node:crypto";

import type { ServiceCaseContext } from "./contracts";
import {
  MAX_QUOTE_AGOROT,
  canonicalQuoteContent,
  chargeForApproval,
  checkQuoteDocument,
  decimalToAgorot,
  decisionAction,
  looksLikePdf,
  normalizeDecimal,
  quoteRowRefusal,
  readQuoteDecision,
  type BillingQuoteDocument,
  type BillingQuoteLine,
} from "./quote.core";
import { evaluateTransition } from "./service-case.core";
import { isServiceKeyOfBusiness, quoteSentPdfFolder, quoteSentPdfKey } from "./storage/service-storage-keys";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

const doc = (o: Partial<BillingQuoteDocument> = {}): BillingQuoteDocument => ({
  id: 41, businessId: 7, documentType: "QUOTE", status: "DRAFT", currency: "ILS", customerId: 12, customerNameSnapshot: "דנה כהן",
  validUntil: "2026-12-01", subtotalAmount: "500.00", vatAmount: "90.00", totalAmount: "590.00", convertedToInvoiceId: null, ...o,
});
const line = (o: Partial<BillingQuoteLine> = {}): BillingQuoteLine => ({
  lineIndex: 0, description: "החלפת מסך", quantity: "1.0000", unitPrice: "400.0000", vatRatePercent: "18.00",
  lineSubtotal: "400.00", vatAmount: "72.00", lineTotal: "472.00", ...o,
});
const LINES = [line(), line({ lineIndex: 1, description: "עבודה", unitPrice: "100.0000", lineSubtotal: "100.00", vatAmount: "18.00", lineTotal: "118.00" })];
const hashOf = (d: BillingQuoteDocument, l: BillingQuoteLine[]) => { const c = canonicalQuoteContent(d, l); return c.ok ? c.docHash : `ERR:${c.violation}`; };
const base = hashOf(doc(), LINES);

console.log("H — canonical content");
{
  const c = canonicalQuoteContent(doc(), LINES);
  const expected = JSON.stringify(["sdq1", "QUOTE", "ILS", 12, "דנה כהן", "2026-12-01", 50000, 9000, 59000, [
    [0, "החלפת מסך", "1.0000", "400.0000", "18.00", 40000, 7200, 47200],
    [1, "עבודה", "1.0000", "100.0000", "18.00", 10000, 1800, 11800],
  ]]);
  ok("H1 the canonical text is exactly the documented sdq1 array", c.ok && c.text === expected, c.ok ? c.text : c.violation);
  ok("H2 docHash = sha256(UTF-8 canonical text), 64 lowercase hex", c.ok && c.docHash === createHash("sha256").update(expected, "utf8").digest("hex") && /^[0-9a-f]{64}$/.test(c.docHash));
  ok("H3 total in exact agorot", c.ok && c.totalAgorot === 59000);
  ok("H4 deterministic and line-order independent (sorted by lineIndex)", hashOf(doc(), [...LINES].reverse()) === base && hashOf(doc(), LINES) === base);
  ok("H5 the decimal text's scale does not matter (\"1\" = \"1.0000\", \"590\" = \"590.00\")",
    hashOf(doc({ totalAmount: "590", subtotalAmount: "500.0", vatAmount: "90" }), [line({ quantity: "1", unitPrice: "400" }), LINES[1]]) === base);
  const changed: [string, string][] = [
    ["a line text", hashOf(doc(), [line({ description: "החלפת מסך " }), LINES[1]])],
    ["a quantity", hashOf(doc(), [line({ quantity: "2.0000" }), LINES[1]])],
    ["a unit price", hashOf(doc(), [line({ unitPrice: "400.0100" }), LINES[1]])],
    ["a VAT rate", hashOf(doc(), [line({ vatRatePercent: "17.00" }), LINES[1]])],
    ["a line total", hashOf(doc(), [line({ lineTotal: "472.01" }), LINES[1]])],
    ["the total", hashOf(doc({ totalAmount: "590.01" }), LINES)],
    ["the customer", hashOf(doc({ customerId: 13 }), LINES)],
    ["the customer name", hashOf(doc({ customerNameSnapshot: "דנה" }), LINES)],
    ["validUntil", hashOf(doc({ validUntil: null }), LINES)],
    ["a line removed", hashOf(doc(), [LINES[0]])],
  ];
  ok("H6 every content field changes the hash", changed.every(([, h]) => h !== base && !h.startsWith("ERR")), changed.filter(([, h]) => h === base).map(([n]) => n).join(", "));
  ok("H7 non-content (document id, status, conversion id) does not change the hash",
    hashOf(doc({ id: 999, status: "PENDING_REVIEW" }), LINES) === base);
  ok("H8 a malformed amount refuses (never hashed)", hashOf(doc({ totalAmount: "5,90" }), LINES) === "ERR:QUOTE_DOCUMENT_AMOUNT_INVALID"
    && hashOf(doc(), [line({ quantity: "1.00001" })]) === "ERR:QUOTE_DOCUMENT_AMOUNT_INVALID");
  ok("H9 the input is not mutated", (() => { const l = [...LINES].reverse(); const snap = JSON.stringify(l); canonicalQuoteContent(doc(), l); return JSON.stringify(l) === snap; })());
}

console.log("A — agorot");
ok("A1 exact: 590.00 → 59000, 0.01 → 1, 12.5 → 1250, 0 → 0, -3.10 → -310",
  decimalToAgorot("590.00") === 59000 && decimalToAgorot("0.01") === 1 && decimalToAgorot("12.5") === 1250 && decimalToAgorot("0") === 0 && decimalToAgorot("-3.10") === -310);
ok("A2 never a float: 0.29 → 29 and 1234567.89 → 123456789 exactly", decimalToAgorot("0.29") === 29 && decimalToAgorot("1234567.89") === 123456789);
ok("A3 too precise / malformed / empty → null", decimalToAgorot("1.005") === null && decimalToAgorot("1e3") === null && decimalToAgorot("") === null && decimalToAgorot("abc") === null);
ok("A4 above the INTEGER column → null", decimalToAgorot(String(MAX_QUOTE_AGOROT / 100 + 1)) === null && decimalToAgorot("21474836.47") === MAX_QUOTE_AGOROT);
ok("A5 normalizeDecimal: fixed scale, no leading zeros, no negative zero", normalizeDecimal("007.5", 4) === "7.5000" && normalizeDecimal("-0.00", 2) === "0.00" && normalizeDecimal("3", 0) === "3");
ok("A6 trailing zeros beyond the scale are not precision (1.50000 at 2 → 1.50)", normalizeDecimal("1.50000", 2) === "1.50");

console.log("D — the billing document check");
const chk = (d: BillingQuoteDocument | null, l: BillingQuoteLine[] = LINES) => { const r = checkQuoteDocument(d, l, { businessId: 7, customerId: 12 }); return r.ok ? "OK" : r.violations.join(","); };
ok("D1 a QUOTE of the business and the case's customer, in ILS, with lines → OK", chk(doc()) === "OK");
ok("D2 not found / another business → QUOTE_DOCUMENT_NOT_FOUND (one answer, nothing leaks)", chk(null) === "QUOTE_DOCUMENT_NOT_FOUND" && chk(doc({ businessId: 8 })) === "QUOTE_DOCUMENT_NOT_FOUND");
ok("D3 a tax invoice → QUOTE_DOCUMENT_NOT_QUOTE", chk(doc({ documentType: "TAX_INVOICE" })) === "QUOTE_DOCUMENT_NOT_QUOTE");
ok("D4 USD → QUOTE_DOCUMENT_CURRENCY", chk(doc({ currency: "USD" })) === "QUOTE_DOCUMENT_CURRENCY");
ok("D5 another customer / no customer → QUOTE_DOCUMENT_CUSTOMER_MISMATCH", chk(doc({ customerId: 13 })) === "QUOTE_DOCUMENT_CUSTOMER_MISMATCH" && chk(doc({ customerId: null })) === "QUOTE_DOCUMENT_CUSTOMER_MISMATCH");
ok("D6 no lines → QUOTE_DOCUMENT_NO_LINES", chk(doc(), []) === "QUOTE_DOCUMENT_NO_LINES");
ok("D7 converted to an invoice → QUOTE_DOCUMENT_CONVERTED; an issued quote (never, fail closed) → QUOTE_DOCUMENT_ISSUED",
  chk(doc({ convertedToInvoiceId: 5 })) === "QUOTE_DOCUMENT_CONVERTED" && chk(doc({ status: "ISSUED" })) === "QUOTE_DOCUMENT_ISSUED");
ok("D8 a negative total → QUOTE_DOCUMENT_AMOUNT_INVALID", chk(doc({ totalAmount: "-1.00" })) === "QUOTE_DOCUMENT_AMOUNT_INVALID");
ok("D9 every violation is reported together", chk(doc({ documentType: "RECEIPT", currency: "EUR", customerId: 1 })) === "QUOTE_DOCUMENT_NOT_QUOTE,QUOTE_DOCUMENT_CURRENCY,QUOTE_DOCUMENT_CUSTOMER_MISMATCH");

console.log("M — the owner's decision");
const ap = readQuoteDecision({ decision: "APPROVE", method: "PHONE" });
const rj = readQuoteDecision({ decision: "REJECT", method: "IN_PERSON" });
ok("M1 APPROVE by PHONE and REJECT in person are read", ap.ok && ap.decision === "APPROVE" && ap.method === "PHONE" && rj.ok && rj.decision === "REJECT");
const link = readQuoteDecision({ decision: "APPROVE", method: "LINK" });
ok("M2 LINK is the customer's channel — refused here (contract only)", !link.ok && link.field === "method" && link.linkRefused === true);
ok("M3 anything else → the field", (() => { const a = readQuoteDecision({ decision: "MAYBE", method: "PHONE" }); const b = readQuoteDecision({ decision: "APPROVE" }); return !a.ok && a.field === "decision" && !b.ok && b.field === "method" && !b.linkRefused; })());
const row = { version: 2, totalAgorot: 59000, docHash: base };
ok("M4 the approval names the row's exact version, total and docHash, with the method", ap.ok && JSON.stringify(decisionAction(row, ap)) === JSON.stringify({ type: "APPROVE_QUOTE", approval: { version: 2, totalAgorot: 59000, docHash: base, method: "PHONE" } }));
ok("M5 a rejection names the version", rj.ok && JSON.stringify(decisionAction(row, rj)) === JSON.stringify({ type: "REJECT_QUOTE", version: 2 }));
ok("M6 a SUPERSEDED / WITHDRAWN / decided row is refused by its own state; SENT is decidable",
  quoteRowRefusal("SUPERSEDED") === "QUOTE_SUPERSEDED" && quoteRowRefusal("WITHDRAWN") === "QUOTE_WITHDRAWN"
    && quoteRowRefusal("APPROVED") === "QUOTE_NOT_AWAITING_DECISION" && quoteRowRefusal("REJECTED") === "QUOTE_NOT_AWAITING_DECISION" && quoteRowRefusal("SENT") === null);
ok("M7 the approval's charge: CHARGEABLE, exactly the approved total, APPROVED_QUOTE, that version",
  JSON.stringify(chargeForApproval({ version: 2, totalAgorot: 59000 })) === JSON.stringify({ mode: "CHARGEABLE", amountAgorot: 59000, source: "APPROVED_QUOTE", quoteVersion: 2 }));
ok("M8 a ₪0 approval records no charge (free of charge is the owner's NO_CHARGE decision)", chargeForApproval({ version: 1, totalAgorot: 0 }) === null);

console.log("K — the frozen copy's key");
const SHA = "a".repeat(64);
ok("K1 biz/{b}/service/cases/{c}/quotes/{sha}.pdf, a service key of that business only",
  quoteSentPdfKey({ businessId: 7, caseId: 3, sha256: SHA }) === `biz/7/service/cases/3/quotes/${SHA}.pdf`
    && isServiceKeyOfBusiness(quoteSentPdfKey({ businessId: 7, caseId: 3, sha256: SHA }), 7) && !isServiceKeyOfBusiness(quoteSentPdfKey({ businessId: 7, caseId: 3, sha256: SHA }), 70)
    && quoteSentPdfKey({ businessId: 7, caseId: 3, sha256: SHA }).startsWith(quoteSentPdfFolder({ businessId: 7, caseId: 3 })));
ok("K2 a bad hash or id is refused", (() => { try { quoteSentPdfKey({ businessId: 7, caseId: 3, sha256: "A".repeat(64) }); return false; } catch { /* */ } try { quoteSentPdfKey({ businessId: 7, caseId: 0, sha256: SHA }); return false; } catch { return true; } })());
ok("K3 looksLikePdf: %PDF- only", looksLikePdf(Buffer.from("%PDF-1.7\n")) && !looksLikePdf(Buffer.from("<html>")));

console.log("C — fit with the unchanged case core");
const ctx = (o: Partial<ServiceCaseContext> = {}): ServiceCaseContext => ({
  kind: "IN_SHOP", status: "QUOTE_PENDING", holdReason: null, outcome: null, version: 5, staffMemberId: null, siteId: null, coverage: null,
  currentQuote: { version: 2, totalAgorot: 59000, docHash: base, state: "SENT", approval: null },
  intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: false }, qaChecklistCompleted: false,
  openPartReservations: 0, openLoaner: false, cancellationRequested: false, pickupRemindersSent: 0, settlement: { known: false }, ...o,
});
const OWNER = { kind: "OWNER" as const, userId: 9 };
const a = ap.ok ? evaluateTransition(ctx(), decisionAction(row, ap), OWNER) : null;
ok("C1 approve (PHONE) → IN_REPAIR, the server check QUOTE_DOCUMENT_MATCHES_HASH listed", !!a && a.ok && a.to === "IN_REPAIR" && a.serverChecks.includes("QUOTE_DOCUMENT_MATCHES_HASH") && a.event.payload.method === "PHONE");
const r = rj.ok ? evaluateTransition(ctx(), decisionAction(row, rj), OWNER) : null;
ok("C2 reject → READY with outcome QUOTE_REJECTED", !!r && r.ok && r.to === "READY" && r.outcome === "QUOTE_REJECTED");
const old = ap.ok ? evaluateTransition(ctx({ currentQuote: { version: 3, totalAgorot: 60000, docHash: "b".repeat(64), state: "SENT", approval: null } }), decisionAction(row, ap), OWNER) : null;
ok("C3 approving an older version than the current one → APPROVAL_MISMATCH (the core binds the current version)", !!old && !old.ok && old.violations.some((v) => v.code === "APPROVAL_MISMATCH"));
const linkApproval = evaluateTransition(ctx(), { type: "APPROVE_QUOTE", approval: { version: 2, totalAgorot: 59000, docHash: base, method: "LINK" } }, OWNER);
ok("C4 the owner can never record LINK (the core agrees: APPROVAL_METHOD_NOT_ALLOWED)", !linkApproval.ok && linkApproval.violations.some((v) => v.code === "APPROVAL_METHOD_NOT_ALLOWED"));

console.log(`\nquote-core: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
