/**
 * Run: npx tsx lib/services/service-desk/case-balance.test.ts
 *
 * The balance of a service case (case-balance.ts) from its charge, its active links and billing's facts (#1102 shape).
 * One check per owner requirement (2026-11-11): no other business's document, no double link, a cancelled / missing /
 * re-statused document never yields a wrong balance, no double count of receipts / allocations / tax invoice-receipts /
 * credits, partial payments and one receipt over several invoices, every contradiction → UNKNOWN (never auto-fixed);
 * plus the five handover cases, exempt dealer, overpayment, and charge changes against issued documents.
 */
import { checkChargeChange, computeCaseBalance, type BillingSettlementFacts, type CaseBillingLink } from "./case-balance";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

type Doc = BillingSettlementFacts["documents"][number];
const doc = (id: number, type: string, flag: Doc["flag"] = null): Doc => ({ id, type, flag });
const inv = (id: number, total: number, credited: number, outstanding: number) => ({ id, totalAgorot: total, creditedAgorot: credited, outstandingAgorot: outstanding });
const rcpt = (id: number, total: number, notAttributed: number, type: "RECEIPT" | "TAX_INVOICE_RECEIPT" = "RECEIPT") =>
  ({ id, type, totalAgorot: total, notAttributedToAnyInvoiceAgorot: notAttributed });
const facts = (p: Partial<BillingSettlementFacts>): BillingSettlementFacts => ({ documents: [], invoices: [], receipts: [], credits: [], ...p });
const charge = (amountAgorot: number) => ({ mode: "CHARGEABLE" as const, amountAgorot });
const C = (id: number): CaseBillingLink => ({ billingDocumentId: id, role: "CHARGE" });
const P = (id: number): CaseBillingLink => ({ billingDocumentId: id, role: "STANDALONE_PAYMENT" });
const show = (b: unknown) => JSON.stringify(b);

// ── the five handover cases ─────────────────────────────────────────────────────────────────────────────────
ok("B0 no charge record → UNKNOWN / NO_CHARGE_DECISION (absence is never 'no debt')",
  computeCaseBalance(null, [], facts({})).state === "UNKNOWN" && (computeCaseBalance(null, [], facts({})) as { reason: string }).reason === "NO_CHARGE_DECISION");
{
  const b = computeCaseBalance({ mode: "NO_CHARGE" }, [], facts({}));
  ok("B1 the owner's NO_CHARGE, nothing linked → NO_CHARGE, 0", b.state === "NO_CHARGE" && b.openBalanceAgorot === 0, show(b));
}
{
  const f = facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 0)] });
  const b = computeCaseBalance(charge(50000), [C(1)], f);
  ok("B2 paid service, invoice fully paid → SETTLED, 0", b.state === "SETTLED" && b.openBalanceAgorot === 0 && b.detail.paidAgorot === 50000, show(b));
}
{
  const f = facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 20000)] });
  const b = computeCaseBalance(charge(50000), [C(1)], f);
  ok("B3 paid service, documented open debt → OPEN 20000 (handover only with the owner's reason)", b.state === "OPEN" && b.openBalanceAgorot === 20000, show(b));
}
{
  const f = facts({ documents: [doc(1, "TAX_INVOICE", "NOT_ISSUED")] });
  const b = computeCaseBalance(charge(50000), [C(1)], f);
  ok("B4 paid service, balance unknown (a draft invoice) → UNKNOWN / DRAFT_PENDING", b.state === "UNKNOWN" && (b as { reason: string }).reason === "DRAFT_PENDING", show(b));
}
{
  const b = computeCaseBalance(charge(50000), [], facts({}));
  ok("B5 paid service, no charge document yet → CHARGE_NOT_DOCUMENTED 50000 (a debt, never 0)", b.state === "CHARGE_NOT_DOCUMENTED" && b.openBalanceAgorot === 50000, show(b));
}

// ── exempt dealer (no tax invoice exists) ───────────────────────────────────────────────────────────────────
{
  const f = facts({ documents: [doc(7, "RECEIPT")], receipts: [rcpt(7, 30000, 30000)] });
  const b = computeCaseBalance(charge(50000), [P(7)], f);
  ok("E1 exempt dealer: agreed 50000, a standalone receipt 30000 linked by the owner → CHARGE_NOT_DOCUMENTED 20000", b.state === "CHARGE_NOT_DOCUMENTED" && b.openBalanceAgorot === 20000, show(b));
  const f2 = facts({ documents: [doc(7, "RECEIPT"), doc(8, "RECEIPT")], receipts: [rcpt(7, 30000, 30000), rcpt(8, 20000, 20000)] });
  const b2 = computeCaseBalance(charge(50000), [P(7), P(8)], f2);
  ok("E2 exempt dealer: two receipts cover it → SETTLED", b2.state === "SETTLED" && b2.detail.paidAgorot === 50000, show(b2));
}

// ── overpayment ─────────────────────────────────────────────────────────────────────────────────────────────
{
  const f = facts({ documents: [doc(7, "RECEIPT")], receipts: [rcpt(7, 52000, 52000)] });
  const b = computeCaseBalance(charge(50000), [P(7)], f);
  ok("O1 an overpayment → SETTLED with overpaidAgorot 2000, shown in the detail (never silently 0, no refund)",
    b.state === "SETTLED" && (b as { overpaidAgorot?: number }).overpaidAgorot === 2000 && b.detail.overpaidAgorot === 2000, show(b));
}

// ── requirement 1: another business's document ──────────────────────────────────────────────────────────────
{
  const f = facts({ documents: [doc(9, null as never, "NOT_FOUND")] });
  const b = computeCaseBalance(charge(50000), [C(9)], f);
  ok("R1 a linked document of another business (billing: NOT_FOUND under RLS) → UNKNOWN / CONFLICT", b.state === "UNKNOWN" && (b as { reason: string }).reason === "CONFLICT", show(b));
}

// ── requirement 2: a double link ────────────────────────────────────────────────────────────────────────────
{
  const f = facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 0)] });
  const b = computeCaseBalance(charge(100000), [C(1), C(1)], f);
  ok("R2 the same document twice among the active links → UNKNOWN / CONFLICT (the database also refuses it: partial UNIQUE)",
    b.state === "UNKNOWN" && (b as { reason: string }).reason === "CONFLICT", show(b));
}

// ── requirement 3: cancelled / deleted / re-statused ────────────────────────────────────────────────────────
{
  const gone = computeCaseBalance(charge(50000), [C(1)], facts({ documents: [doc(1, null as never, "NOT_FOUND")] }));
  const draft = computeCaseBalance(charge(50000), [C(1)], facts({ documents: [doc(1, "TAX_INVOICE", "NOT_ISSUED")] }));
  const fx = computeCaseBalance(charge(50000), [C(1)], facts({ documents: [doc(1, "TAX_INVOICE", "NOT_ILS")] }));
  const quote = computeCaseBalance(charge(50000), [C(1)], facts({ documents: [doc(1, "QUOTE", "NOT_A_SETTLEMENT_DOCUMENT")] }));
  const missing = computeCaseBalance(charge(50000), [C(1)], facts({}));
  ok("R3 a deleted / vanished document → UNKNOWN (CONFLICT); back to draft → DRAFT_PENDING; foreign currency → FOREIGN_CURRENCY; a quote → CONFLICT; facts silent on an id → READ_ERROR",
    [gone, draft, fx, quote, missing].map((b) => (b as { reason?: string }).reason).join() === "CONFLICT,DRAFT_PENDING,FOREIGN_CURRENCY,CONFLICT,READ_ERROR");
  const cancelled = computeCaseBalance(charge(50000), [C(1)], facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 50000, 0)] }));
  ok("R3b an invoice cancelled by a full credit note → documented 0, paid 0 → CHARGE_NOT_DOCUMENTED 50000 (never 'paid')",
    cancelled.state === "CHARGE_NOT_DOCUMENTED" && cancelled.openBalanceAgorot === 50000 && cancelled.detail.paidAgorot === 0, show(cancelled));
}

// ── requirement 4: no double count ──────────────────────────────────────────────────────────────────────────
{
  // receipt R10 = 1000 → I1 (this case) + 200 → I2 (another case): fully allocated, nothing unattributed
  const f = facts({ documents: [doc(1, "TAX_INVOICE"), doc(10, "RECEIPT")], invoices: [inv(1, 100000, 0, 0)], receipts: [rcpt(10, 120000, 0)] });
  const viaInvoice = computeCaseBalance(charge(100000), [C(1)], f);
  const alsoReceipt = computeCaseBalance(charge(100000), [C(1), P(10)], f);
  ok("R4a an allocated receipt counts only through its invoice's outstanding: 100000, never 120000 or 220000",
    viaInvoice.detail.paidAgorot === 100000 && alsoReceipt.detail.paidAgorot === 100000 && alsoReceipt.state === "SETTLED", `${show(viaInvoice)} ${show(alsoReceipt)}`);
  const tir = computeCaseBalance(charge(30000), [C(3)], facts({ documents: [doc(3, "TAX_INVOICE_RECEIPT")], receipts: [rcpt(3, 30000, 0, "TAX_INVOICE_RECEIPT")] }));
  ok("R4b a tax invoice / receipt is counted once (charge and payment in one) → SETTLED, documented 30000, paid 30000",
    tir.state === "SETTLED" && tir.detail.documentedAgorot === 30000 && tir.detail.paidAgorot === 30000, show(tir));
  const tirCredit = computeCaseBalance(charge(30000), [C(3)], facts({ documents: [doc(3, "TAX_INVOICE_RECEIPT")], receipts: [rcpt(3, 30000, 0, "TAX_INVOICE_RECEIPT")], credits: [{ creditNoteId: 9, invoiceDocumentId: 3, amountAgorot: 5000 }] }));
  ok("R4b2 a credit note against a tax invoice / receipt is not netted (no currency per credit) → UNKNOWN / CONFLICT",
    tirCredit.state === "UNKNOWN" && (tirCredit as { reason: string }).reason === "CONFLICT", show(tirCredit));
  const credit = computeCaseBalance(charge(40000), [C(1)], facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 10000, 0)], credits: [{ creditNoteId: 5, invoiceDocumentId: 1, amountAgorot: 10000 }] }));
  ok("R4c a credit note counts once, through its invoice (net 40000), never again from the credits list",
    credit.state === "SETTLED" && credit.detail.documentedAgorot === 40000 && credit.detail.paidAgorot === 40000, show(credit));
  const overUnapplied = computeCaseBalance(charge(100000), [C(1), P(11)],
    facts({ documents: [doc(1, "TAX_INVOICE"), doc(11, "RECEIPT")], invoices: [inv(1, 100000, 0, 0)], receipts: [rcpt(11, 105000, 5000)] }));
  ok("R4d a receipt with a stated unapplied part, also linked: only the unattributed 5000 is added → overpaid 5000",
    overUnapplied.state === "SETTLED" && overUnapplied.detail.paidAgorot === 105000 && overUnapplied.detail.overpaidAgorot === 5000, show(overUnapplied));
}

// ── requirement 5: partial payments; one receipt over several invoices ─────────────────────────────────────
{
  const f = facts({ documents: [doc(1, "TAX_INVOICE"), doc(2, "TAX_INVOICE")], invoices: [inv(1, 30010, 0, 10010), inv(2, 20000, 0, 5000)] });
  const b = computeCaseBalance(charge(50010), [C(1), C(2)], f);
  ok("R5a two invoices, each partly paid (one receipt across both) → OPEN 15010 = Σ outstanding, exact in agorot",
    b.state === "OPEN" && b.openBalanceAgorot === 15010 && b.detail.paidAgorot === 35000, show(b));
  const mixed = computeCaseBalance(charge(80000), [C(1), P(7)],
    facts({ documents: [doc(1, "TAX_INVOICE"), doc(7, "RECEIPT")], invoices: [inv(1, 50000, 0, 20000)], receipts: [rcpt(7, 30000, 30000)] }));
  ok("R5b invoice 50000 (20000 open) + an undocumented 30000 paid by a standalone receipt → OPEN 20000 (the open part is documented)",
    mixed.state === "OPEN" && mixed.openBalanceAgorot === 20000, show(mixed));
}

// ── requirement 6: contradictions → UNKNOWN, never corrected ────────────────────────────────────────────────
{
  const above = computeCaseBalance(charge(40000), [C(1)], facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 0)] }));
  const freeWithDoc = computeCaseBalance({ mode: "NO_CHARGE" }, [C(1)], facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 0)] }));
  const wrongRole = computeCaseBalance(charge(50000), [P(1)], facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 0)] }));
  const badOutstanding = computeCaseBalance(charge(50000), [C(1)], facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 60000)] }));
  const badReceipt = computeCaseBalance(charge(50000), [P(7)], facts({ documents: [doc(7, "RECEIPT")], receipts: [rcpt(7, 10000, 20000)] }));
  ok("R6 documented above the charge / NO_CHARGE with a linked invoice / a receipt-role link on an invoice / outstanding above net / unattributed above total → all UNKNOWN",
    [above, freeWithDoc, wrongRole, badOutstanding, badReceipt].every((b) => b.state === "UNKNOWN" && b.openBalanceAgorot === null),
    [above, freeWithDoc, wrongRole, badOutstanding, badReceipt].map((b) => (b as { reason?: string }).reason).join());
}

// ── T7: an after-sale credit note is evidence, never balance ─────────────────────────────────────────────────
{
  const ev: CaseBillingLink = { billingDocumentId: 70, role: "AFTER_SALE_CREDIT" };
  const free = computeCaseBalance({ mode: "NO_CHARGE" }, [ev], facts({ documents: [doc(70, "CREDIT_NOTE", "NOT_A_SETTLEMENT_DOCUMENT")] }));
  ok("T1 a T7 case resolved by a credit: NO_CHARGE + an AFTER_SALE_CREDIT link → NO_CHARGE (the credit is not a conflict, not a payment)", free.state === "NO_CHARGE", show(free));
  ok("T2 … and a charge change ignores it too", checkChargeChange({ mode: "NO_CHARGE" }, [ev], facts({})).ok === true);
}

// ── charge changes against issued documents (also after a handover) ─────────────────────────────────────────
{
  const f = facts({ documents: [doc(1, "TAX_INVOICE")], invoices: [inv(1, 50000, 0, 0)] });
  ok("X1 lowering the charge below the documented 50000 → CHARGE_BELOW_DOCUMENTED (a credit note in billing first)",
    show(checkChargeChange(charge(40000), [C(1)], f)) === '{"ok":false,"code":"CHARGE_BELOW_DOCUMENTED"}');
  ok("X2 raising it, or keeping it at the documented amount → allowed (the new part is undocumented debt until invoiced)",
    checkChargeChange(charge(60000), [C(1)], f).ok && checkChargeChange(charge(50000), [C(1)], f).ok);
  ok("X3 NO_CHARGE while a document is linked → NO_CHARGE_WITH_DOCUMENTS; with nothing linked → allowed",
    show(checkChargeChange({ mode: "NO_CHARGE" }, [C(1)], f)) === '{"ok":false,"code":"NO_CHARGE_WITH_DOCUMENTS"}' && checkChargeChange({ mode: "NO_CHARGE" }, [], facts({})).ok);
  ok("X4 a change while a linked document is a draft → BALANCE_UNKNOWN (refuse rather than guess)",
    show(checkChargeChange(charge(60000), [C(1)], facts({ documents: [doc(1, "TAX_INVOICE", "NOT_ISSUED")] }))) === '{"ok":false,"code":"BALANCE_UNKNOWN"}');
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
