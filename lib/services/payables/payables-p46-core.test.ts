/**
 * Payables Phases 4–6 — pure rules. Run:
 *   npx tsx lib/services/payables/payables-p46-core.test.ts
 */
import {
  approvalHash,
  assertDestinationRule,
  assertExecutionTransition,
  assertPreparableMethod,
  assertPreparationTransition,
  isLiveExecution,
  parseStatementAmount,
  parseStatementCsv,
  parseStatementDate,
  preparationActions,
  scoreBankLine,
  statementLineIdentities,
  type ApprovalSnapshot,
  type BankCandidateTarget,
  type ExecutionStatusValue,
  type PreparationStatusValue,
} from "./payables-p46-core";
import { confidenceOf } from "./payables-matching";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
const ok = (fn: () => unknown) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

/* ── A. preparation ──────────────────────────────────────────────────── */
console.log("\n[A] preparation");
check("CHECK is refused (cheques have their own register)", !ok(() => assertPreparableMethod("CHECK")));
check("BANK_TRANSFER is preparable", ok(() => assertPreparableMethod("BANK_TRANSFER")));
check("an unknown method is refused", !ok(() => assertPreparableMethod("WIRE")));
check("a bank transfer without a destination is refused", !ok(() => assertDestinationRule("BANK_TRANSFER", null)));
check("cash WITH a destination is refused", !ok(() => assertDestinationRule("CASH", 5)));
check("a bank transfer with a destination is fine", ok(() => assertDestinationRule("BANK_TRANSFER", 5)));

const allowed: Array<[PreparationStatusValue, PreparationStatusValue]> = [
  ["PREPARED", "APPROVED"], ["PREPARED", "CANCELLED"],
  ["APPROVED", "SUBMITTED"], ["APPROVED", "COMPLETED"], ["APPROVED", "CANCELLED"],
  ["SUBMITTED", "COMPLETED"], ["SUBMITTED", "FAILED"],
  ["FAILED", "SUBMITTED"], ["FAILED", "COMPLETED"], ["FAILED", "CANCELLED"],
];
const ALL_PREP: PreparationStatusValue[] = ["PREPARED", "APPROVED", "SUBMITTED", "COMPLETED", "FAILED", "CANCELLED"];
let tableOk = true;
for (const f of ALL_PREP) for (const t of ALL_PREP) {
  const expected = allowed.some(([a, b]) => a === f && b === t);
  if (ok(() => assertPreparationTransition(f, t)) !== expected) tableOk = false;
}
check("preparation transition table is exactly the designed one", tableOk);
check("PREPARED cannot be completed without approval", !ok(() => assertPreparationTransition("PREPARED", "COMPLETED")));
check("SUBMITTED cannot be cancelled while a provider holds it", !ok(() => assertPreparationTransition("SUBMITTED", "CANCELLED")));
check("COMPLETED and CANCELLED are terminal", ALL_PREP.every((t) => !ok(() => assertPreparationTransition("COMPLETED", t)) && !ok(() => assertPreparationTransition("CANCELLED", t))));
check("PREPARED offers approve+cancel, not completion", JSON.stringify(preparationActions("PREPARED")) === JSON.stringify({ approve: true, cancel: true, reportCompleted: false, execute: false }));

const snap: ApprovalSnapshot = {
  preparationId: 1, businessId: 2, commitmentId: 3, installmentId: 4, payeeId: 5, amount: "1200.00",
  currency: "ILS", method: "BANK_TRANSFER", destinationId: 6, destinationFingerprint: "fpA",
  sourceBankAccountId: 7, sourceFingerprint: "fpS", reference: "INV-9",
};
const h = approvalHash(snap);
check("approval hash is deterministic", h === approvalHash({ ...snap }));
check("amount formatting does not change the hash (1200 == 1200.00)", h === approvalHash({ ...snap, amount: "1200" }));
check("a changed amount changes the hash", h !== approvalHash({ ...snap, amount: "1200.01" }));
check("a substituted destination (same id, new coordinates) changes the hash", h !== approvalHash({ ...snap, destinationFingerprint: "fpB" }));
check("a different destination id changes the hash", h !== approvalHash({ ...snap, destinationId: 8 }));
check("a changed source changes the hash", h !== approvalHash({ ...snap, sourceFingerprint: "fpT" }));
check("a changed reference changes the hash", h !== approvalHash({ ...snap, reference: "INV-10" }));

/* ── B. execution ───────────────────────────────────────────────────── */
console.log("\n[B] execution");
const ALL_EX: ExecutionStatusValue[] = ["REQUESTED", "SUBMITTED", "ACKNOWLEDGED", "SETTLED", "FAILED", "CANCELLED"];
check("REQUESTED cannot jump to SETTLED", !ok(() => assertExecutionTransition("REQUESTED", "SETTLED")));
check("ACKNOWLEDGED → SETTLED is allowed", ok(() => assertExecutionTransition("ACKNOWLEDGED", "SETTLED")));
check("SETTLED is terminal", ALL_EX.every((t) => !ok(() => assertExecutionTransition("SETTLED", t))));
check("FAILED is terminal (a retry is a NEW execution)", ALL_EX.every((t) => !ok(() => assertExecutionTransition("FAILED", t))));
check("live = REQUESTED | SUBMITTED | ACKNOWLEDGED", ALL_EX.filter(isLiveExecution).join() === "REQUESTED,SUBMITTED,ACKNOWLEDGED");

/* ── C. statements ──────────────────────────────────────────────────── */
console.log("\n[C] statements");
check("'1,234.50' → 123450", parseStatementAmount("1,234.50") === 123450);
check("'-1234.5' → -123450", parseStatementAmount("-1234.5") === -123450);
check("'1234.50-' (trailing minus) → -123450", parseStatementAmount("1234.50-") === -123450);
check("'(99.90)' → -9990", parseStatementAmount("(99.90)") === -9990);
check("'₪ 50' → 5000", parseStatementAmount("₪ 50") === 5000);
check("a third decimal is refused, not rounded", parseStatementAmount("1.234") === null);
check("text is refused", parseStatementAmount("abc") === null);
check("DD/MM/YYYY parses", parseStatementDate("05/03/2026")?.toISOString().slice(0, 10) === "2026-03-05");
check("YYYY-MM-DD parses", parseStatementDate("2026-03-05")?.toISOString().slice(0, 10) === "2026-03-05");
check("31/02/2026 is refused, not rolled over", parseStatementDate("31/02/2026") === null);

const csv = [
  "תאריך,תיאור,אסמכתא,חובה,זכות",
  "05/03/2026,העברה לספק הדפוס,000123,1200.00,",
  "05/03/2026,העברה לספק הדפוס,000123,1200.00,",
  "06/03/2026,זיכוי מלקוח,,,500.00",
  "bad-date,x,,1,",
  "07/03/2026,no amount,,,",
].join("\n");
const parsed = parseStatementCsv(csv);
check("Hebrew headers are understood", parsed.lines.length === 3, `lines=${parsed.lines.length}`);
check("a debit column becomes DEBIT, a credit column CREDIT", parsed.lines[0].direction === "DEBIT" && parsed.lines[2].direction === "CREDIT");
check("amounts arrive in minor units", parsed.lines[0].amountMinor === 120000);
check("bad lines are reported by number and FIELD", JSON.stringify(parsed.errors) === JSON.stringify([{ lineNumber: 5, field: "date" }, { lineNumber: 6, field: "amount" }]));
check("errors never carry line content", !JSON.stringify(parsed.errors).includes("no amount"));
check("a file without a date column is refused whole", parseStatementCsv("amount\n1").errors[0]?.field === "date column");
const heb = parseStatementCsv(
  ["date,description,amount", '2026-03-05,העברה ספק הדפוס בע"מ,-1000.00', '2026-03-06,"quoted, with comma",-5'].join("\n"),
);
check('a mid-field quote (בע"מ) is literal, not a quoted field', heb.lines.length === 2 && heb.lines[0].description === 'העברה ספק הדפוס בע"מ' && heb.lines[0].amountMinor === 100000);
check("a real quoted field with a comma still works", heb.lines[1]?.description === "quoted, with comma");
const signed = parseStatementCsv("date,amount,description\n2026-03-05,-80.00,fee\n2026-03-06,120,in");
check("a signed amount column works", signed.lines[0].direction === "DEBIT" && signed.lines[1].direction === "CREDIT");

const ids1 = statementLineIdentities(9, 3, parsed.lines);
const ids2 = statementLineIdentities(9, 3, parseStatementCsv(csv).lines);
check("re-uploading the same statement reproduces the same identities", JSON.stringify(ids1) === JSON.stringify(ids2));
check("two identical charges on one day stay TWO lines", ids1[0] !== ids1[1]);
check("identities are tenant-bound", statementLineIdentities(10, 3, parsed.lines)[0] !== ids1[0]);
check("identities are account-bound", statementLineIdentities(9, 4, parsed.lines)[0] !== ids1[0]);

/* ── D. matching a bank line ────────────────────────────────────────── */
console.log("\n[D] matching");
const line = { externalTransactionId: 1, amountMinor: 120000, bookedAt: new Date("2026-03-05T12:00:00Z"), direction: "DEBIT" as const, counterpartyName: "ספק הדפוס בע\"מ", description: null, reference: "000123" };
const pay = (over: Partial<Extract<BankCandidateTarget, { kind: "PAYMENT" }>> = {}): BankCandidateTarget => ({
  kind: "PAYMENT", paymentId: 1, commitmentId: 1, commitmentTitle: "t", payeeNameSnapshot: "ספק הדפוס", payeeId: 1,
  amountMinor: 120000, paidAt: new Date("2026-03-04T12:00:00Z"), hasDocumentEvidence: false, externalReference: null, ...over,
});
check("amount + vendor + date → a candidate", scoreBankLine(line, pay()) !== null);
check("AMOUNT ALONE is never identity (other vendor, far date, no ref)",
  scoreBankLine({ ...line, reference: null }, pay({ payeeNameSnapshot: "חברת החשמל", paidAt: new Date("2025-01-01T12:00:00Z") })) === null);
check("a different amount is never a candidate, whatever else agrees", scoreBankLine(line, pay({ amountMinor: 120001 })) === null);
const refOnly = scoreBankLine(line, pay({ payeeNameSnapshot: "חברת החשמל", paidAt: new Date("2025-01-01T12:00:00Z"), externalReference: "123" }));
check("a matching reference (leading zeros ignored) corroborates the amount", refOnly !== null && refOnly.reasons.includes("האסמכתא תואמת"));
check("…but a reference-only candidate is never STRONG", refOnly !== null && confidenceOf(refOnly) !== "STRONG");
check("a reference with the WRONG amount is still refused", scoreBankLine(line, pay({ amountMinor: 99900, externalReference: "123" })) === null);
check("an incoming CREDIT is never a payable", scoreBankLine({ ...line, direction: "CREDIT" }, pay()) === null);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
if (failures > 0) process.exit(1);
