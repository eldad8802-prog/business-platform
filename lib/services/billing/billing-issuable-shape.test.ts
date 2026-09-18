/**
 * Run: npx tsx lib/services/billing/billing-issuable-shape.test.ts
 *
 * What a document must look like before it may be issued.
 *
 * THE DEFECT THIS CLOSES. A pure RECEIPT could never be issued. The issuance
 * guard counted goods lines, and a receipt has none by design — its money is
 * its payment lines. Every legitimate receipt was refused with "Cannot issue a
 * document with no lines", which was proven by execution against a real
 * database before this rule was extracted.
 *
 * THE DANGER IN FIXING IT. The cheap fix is to delete the guard, and that would
 * let an empty invoice through. So the assertions below are weighted towards
 * the invoice cases: the rule became type-aware, not absent, and half of this
 * file exists to prove the old requirements still bite.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { BillingDocumentType, Prisma } from "@prisma/client";
import { assertIssuableShape, type IssuableDocumentShape } from "./billing-issuable-shape.rules";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}
function throws(name: string, fn: () => unknown, match: RegExp) {
  try {
    fn();
    ok(name, false, "it returned instead of throwing");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ok(name, match.test(message), message);
  }
}

const D = (v: string | number) => new Prisma.Decimal(v);
const ZERO = { subtotalAmount: D(0), vatAmount: D(0), totalAmount: D(0) };
const GOODS = { subtotalAmount: D("854.70"), vatAmount: D("145.30"), totalAmount: D("1000.00") };

function receipt(over: Partial<IssuableDocumentShape> = {}): IssuableDocumentShape {
  return {
    documentType: BillingDocumentType.RECEIPT,
    lineCount: 0,
    paymentAmounts: [D("1000.00")],
    stored: { subtotalAmount: D(0), vatAmount: D(0), totalAmount: D("1000.00") },
    recomputed: ZERO,
    ...over,
  };
}
function invoice(over: Partial<IssuableDocumentShape> = {}): IssuableDocumentShape {
  return {
    documentType: BillingDocumentType.TAX_INVOICE,
    lineCount: 1,
    paymentAmounts: [],
    stored: GOODS,
    recomputed: GOODS,
    ...over,
  };
}

// ── a legitimate pure receipt ────────────────────────────────────────────
{
  const totals = assertIssuableShape(receipt());
  ok("a receipt with one payment line is issuable", true);
  ok(
    "and its total comes from ITSELF, not from goods it does not have",
    totals.totalAmount.equals(D("1000.00")),
    totals.totalAmount.toString()
  );
  ok("its subtotal stays zero", totals.subtotalAmount.isZero());
  ok("and so does its VAT", totals.vatAmount.isZero());
}
{
  const totals = assertIssuableShape(
    receipt({
      paymentAmounts: [D("600.00"), D("400.00")],
    })
  );
  ok("several payment lines are summed", totals.totalAmount.equals(D("1000.00")));
}

// ── a receipt that is not really a receipt ───────────────────────────────
throws(
  "a receipt with no payment lines is refused",
  () => assertIssuableShape(receipt({ paymentAmounts: [] })),
  /no payment lines/
);
throws(
  "a receipt whose payment lines do not add up to its total is refused",
  () => assertIssuableShape(receipt({ paymentAmounts: [D("999.99")] })),
  /inconsistent with its payment lines/
);
throws(
  "a receipt carrying goods lines is refused",
  () => assertIssuableShape(receipt({ lineCount: 1 })),
  /payment lines only/
);
throws(
  "a receipt carrying a subtotal is refused",
  () =>
    assertIssuableShape(
      receipt({
        stored: { subtotalAmount: D("10"), vatAmount: D(0), totalAmount: D("1000.00") },
      })
    ),
  /payment lines only/
);
throws(
  "a receipt carrying VAT is refused",
  () =>
    assertIssuableShape(
      receipt({
        stored: { subtotalAmount: D(0), vatAmount: D("10"), totalAmount: D("1000.00") },
      })
    ),
  /payment lines only/
);

// ── THE REGRESSION THAT MATTERS: invoices are unchanged ──────────────────
//
// If the fix had simply removed the zero-line guard, every assertion below
// would pass silently and an empty invoice would become issuable.
{
  const totals = assertIssuableShape(invoice());
  ok("a normal invoice is still issuable", totals.totalAmount.equals(D("1000.00")));
}
throws(
  "an invoice with NO lines is still refused",
  () => assertIssuableShape(invoice({ lineCount: 0 })),
  /no lines/
);
throws(
  "an invoice whose totals disagree with its lines is still refused",
  () => assertIssuableShape(invoice({ stored: { ...GOODS, totalAmount: D("999") } })),
  /inconsistent with line items/
);
throws(
  "a QUOTE with no lines is still refused",
  () =>
    assertIssuableShape(
      invoice({ documentType: BillingDocumentType.QUOTE, lineCount: 0 })
    ),
  /no lines/
);
throws(
  "a CREDIT_NOTE with no lines is still refused",
  () =>
    assertIssuableShape(
      invoice({ documentType: BillingDocumentType.CREDIT_NOTE, lineCount: 0 })
    ),
  /no lines/
);
throws(
  "a TAX_INVOICE_RECEIPT with no goods lines is still refused",
  () =>
    assertIssuableShape(
      invoice({ documentType: BillingDocumentType.TAX_INVOICE_RECEIPT, lineCount: 0 })
    ),
  /no lines/
);
{
  // A tax-invoice-receipt is invoice-like: it has goods, and its payment lines
  // do not replace them. Proven explicitly because it is the type most easily
  // confused with the one being fixed.
  const totals = assertIssuableShape(
    invoice({
      documentType: BillingDocumentType.TAX_INVOICE_RECEIPT,
      paymentAmounts: [D("1000.00")],
    })
  );
  ok(
    "a tax-invoice-receipt is validated as the invoice-like document it is",
    totals.totalAmount.equals(D("1000.00"))
  );
  ok(
    "and its totals still come from its goods lines",
    totals.subtotalAmount.equals(D("854.70"))
  );
}
throws(
  "a tax-invoice-receipt cannot escape the totals check via its payment lines",
  () =>
    assertIssuableShape(
      invoice({
        documentType: BillingDocumentType.TAX_INVOICE_RECEIPT,
        paymentAmounts: [D("1000.00")],
        stored: { ...GOODS, totalAmount: D("999") },
      })
    ),
  /inconsistent with line items/
);

// ── the second defect: the customer snapshot ─────────────────────────────
//
// Issuance requires an immutable customer name snapshot, and receipt creation
// accepted a customer without writing one — so a customer-backed receipt could
// never be issued even once the shape rule was fixed. The fix reuses the one
// resolver every other document uses, rather than adding a second idea of who
// a customer is.
{
  const draft = fs.readFileSync(
    new URL("./receipt/billing-receipt-draft.service.ts", import.meta.url),
    "utf8"
  );
  ok(
    "receipt creation resolves its customer through the shared resolver",
    /await resolveCustomerForCreate\(/.test(draft)
  );
  ok(
    "and does not snapshot straight from unvalidated input",
    !/customerNameSnapshot:\s*input\.customerNameSnapshot/.test(draft)
  );
  ok(
    "nor takes the customer id without validating it",
    !/customerId:\s*input\.customerId\s*\?\?\s*null/.test(draft)
  );
}

console.log(`\nbilling-issuable-shape: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
assert.equal(failures.length, 0);
