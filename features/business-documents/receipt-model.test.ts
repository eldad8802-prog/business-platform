/**
 * Receipt screen model (pure: no DB, no network, no clock).
 * Run: npx tsx features/business-documents/receipt-model.test.ts
 */
import {
  agorotToDecimal,
  allocationsPayload,
  autoAllocate,
  billingErrorText,
  emptyLine,
  formatAgorot,
  isConsolidated,
  METHOD_FIELDS,
  METHODS,
  paymentsPayload,
  receiptProblems,
  toAgorot,
  type OpenInvoice,
  type ReceiptForm,
} from "./receipt-model";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const today = "2026-11-09";
const inv = (id: number, remaining: number, issuedAt = `2026-10-0${id}T08:00:00.000Z`): OpenInvoice => ({ id, number: String(id).padStart(6, "0"), issuedAt, totalAgorot: remaining, remainingAgorot: remaining });
const form = (over: Partial<ReceiptForm> = {}): ReceiptForm => ({ customerId: "7", lines: [{ ...emptyLine(today), amount: "100" }], allocations: {}, ...over });

console.log("amounts");
ok("integer", toAgorot("100") === 10000);
ok("two decimals", toAgorot("1,234.5") === 123450);
ok("shekel sign and spaces", toAgorot(" ₪ 12.05 ") === 1205);
ok("three decimals refused", toAgorot("1.005") === null);
ok("zero refused", toAgorot("0") === null && toAgorot("0.00") === null);
ok("negative refused", toAgorot("-5") === null);
ok("text refused", toAgorot("abc") === null && toAgorot("") === null);
ok("decimal string for billing", agorotToDecimal(123405) === "1234.05" && agorotToDecimal(7) === "0.07");
ok("display", formatAgorot(123456789) === "1,234,567.89");

console.log("methods mirror the billing validation");
ok("debit methods are not offered", !METHODS.includes("DIRECT_DEBIT" as never) && !METHODS.includes("STANDING_ORDER" as never));
ok("bank transfer needs bank, branch, account", METHOD_FIELDS.BANK_TRANSFER.join() === "bankName,bankBranch,bankAccountNumber");
ok("check also needs number and due date", METHOD_FIELDS.CHECK.includes("checkNumber") && METHOD_FIELDS.CHECK.includes("checkDueDate"));
ok("card needs brand and last 4", METHOD_FIELDS.CREDIT_CARD.join() === "cardBrand,cardLast4");
ok("bit / paybox / other need a reference", ["BIT", "PAYBOX", "OTHER"].every((m) => METHOD_FIELDS[m as "BIT"].join() === "reference"));

console.log("problems");
ok("a cash receipt without allocation is ready", Object.keys(receiptProblems(form(), [])).length === 0);
ok("customer required", receiptProblems(form({ customerId: "" }), []).customer !== undefined);
ok("at least one line", receiptProblems(form({ lines: [] }), []).lines !== undefined);
ok("bad amount", receiptProblems(form({ lines: [{ ...emptyLine(today), amount: "1.234" }] }), [])["line.0.amount"] !== undefined);
{
  const p = receiptProblems(form({ lines: [{ ...emptyLine(today), method: "CHECK", amount: "50" }] }), []);
  ok("check: every required field is reported", ["bankName", "bankBranch", "bankAccountNumber", "checkNumber", "checkDueDate"].every((f) => p[`line.0.${f}`] !== undefined), JSON.stringify(p));
}
ok("card last 4 must be 4 digits", receiptProblems(form({ lines: [{ ...emptyLine(today), method: "CREDIT_CARD", amount: "50", cardBrand: "ויזה", cardLast4: "12a4" }] }), [])["line.0.cardLast4"] !== undefined);
ok("bit needs a reference", receiptProblems(form({ lines: [{ ...emptyLine(today), method: "BIT", amount: "50" }] }), [])["line.0.reference"] !== undefined);
{
  const invoices = [inv(1, 6000), inv(2, 4000)];
  ok("allocations equal to the total: ready", Object.keys(receiptProblems(form({ allocations: { 1: "60", 2: "40" } }), invoices)).length === 0);
  ok("allocations below the total refused", receiptProblems(form({ allocations: { 1: "60" } }), invoices).allocTotal !== undefined);
  ok("allocation above the remaining refused", receiptProblems(form({ lines: [{ ...emptyLine(today), amount: "70" }], allocations: { 2: "70" } }), invoices)["alloc.2"] !== undefined);
  ok("an invoice no longer open refused", receiptProblems(form({ allocations: { 9: "100" } }), invoices)["alloc.9"] !== undefined);
  ok("empty allocation cells are ignored", Object.keys(receiptProblems(form({ allocations: { 1: "", 2: " " } }), invoices)).length === 0);
}

console.log("payloads");
{
  const body = paymentsPayload([{ ...emptyLine(today), method: "BANK_TRANSFER", amount: "1,000.5", bankName: " לאומי ", bankBranch: "800", bankAccountNumber: "12345", checkNumber: "should-not-be-sent" }]);
  const line = body.payments[0];
  ok("payment line: method fields only, trimmed, decimal string", line.amount === "1000.50" && line.bankName === "לאומי" && !("checkNumber" in line) && line.lineIndex === 1 && line.currency === "ILS", JSON.stringify(line));
}
ok("every method sends ILS only (no currency input on the screen)", METHODS.every((m) => paymentsPayload([{ ...emptyLine(today), method: m, amount: "1" }]).payments[0].currency === "ILS"));
ok("optional reference is sent when typed", paymentsPayload([{ ...emptyLine(today), amount: "5", reference: "קופה 2" }]).payments[0].reference === "קופה 2");
ok("no allocations → null (receipt owed against nothing)", allocationsPayload({ 1: "", 2: "" }) === null);
{
  const a = allocationsPayload({ 1: "60", 2: "40.5" });
  ok("allocations body", JSON.stringify(a) === JSON.stringify({ allocations: [{ invoiceDocumentId: 1, allocatedAmount: "60.00" }, { invoiceDocumentId: 2, allocatedAmount: "40.50" }] }), JSON.stringify(a));
}

console.log("auto allocation and consolidated receipt");
{
  const invoices = [inv(2, 4000, "2026-10-05T08:00:00.000Z"), inv(1, 6000, "2026-10-01T08:00:00.000Z")];
  const a = autoAllocate(8000, invoices);
  ok("oldest first, up to the total", a[1] === "60.00" && a[2] === "20.00", JSON.stringify(a));
  ok("never above the remaining", autoAllocate(50000, invoices)[1] === "60.00" && autoAllocate(50000, invoices)[2] === "40.00");
  ok("two invoices = consolidated", isConsolidated(a) && !isConsolidated({ 1: "60.00", 2: "" }));
}

console.log("server refusals in Hebrew");
ok("network", billingErrorText(null, "x") === "אין חיבור. נסו שוב.");
ok("allocation total", billingErrorText(400, "Sum of allocations must equal the receipt total").includes("שווה"));
ok("unknown → generic", billingErrorText(500, "Internal Server Error") === "הפעולה נכשלה. נסו שוב.");

console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length) process.exit(1);
