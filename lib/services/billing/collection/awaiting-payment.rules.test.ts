/**
 * Collection · awaiting-payment read-model verify (pure — no DB, no network):
 *   npx tsx lib/services/billing/collection/awaiting-payment.rules.test.ts
 *
 * The invariant under test is one sentence:
 *
 *   Dubiz must never put a customer on this list who does not owe money.
 *
 * Everything below is a way that could go wrong: a document type that was paid
 * at issuance, an invoice already settled, one fully credited, one not yet due,
 * a draft, an over-allocation. Each is checked on its own.
 */

import { Prisma } from "@prisma/client";

import {
  buildAwaitingPaymentList,
  computeOutstanding,
  isCollectible,
  type InvoiceRow,
} from "./awaiting-payment.rules";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const d = (s: string) => new Prisma.Decimal(s);
const ISSUED = new Date("2026-06-03T10:00:00.000Z");
/** Terms default to 30 days, so this is comfortably past the expectation. */
const NOW = new Date("2026-07-20T10:00:00.000Z");

function row(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 1,
    documentNumber: "2026-0001",
    type: "TAX_INVOICE",
    status: "ISSUED",
    issuedAt: ISSUED,
    totalAmount: d("1000"),
    currency: "ILS",
    allocatedAmount: d("0"),
    creditedAmount: d("0"),
    customerId: 7,
    customerName: "לקוח",
    customerPhone: "0501234567",
    customerEmail: null,
    ...over,
  };
}

const build = (rows: InvoiceRow[], termsDays: number | null = null) =>
  buildAwaitingPaymentList({ rows, configuredTermsDays: termsDays, now: NOW });

function run() {
  // --- outstanding: total − paid − credited, never negative ---
  ok("nothing paid: full amount", computeOutstanding(row()).equals(d("1000")));
  ok(
    "partly paid",
    computeOutstanding(row({ allocatedAmount: d("300") })).equals(d("700")),
  );
  ok(
    "partly credited (D3)",
    computeOutstanding(row({ creditedAmount: d("250") })).equals(d("750")),
  );
  ok(
    "paid and credited together",
    computeOutstanding(
      row({ allocatedAmount: d("300"), creditedAmount: d("200") }),
    ).equals(d("500")),
  );
  ok(
    "over-allocated clamps to zero, never negative",
    computeOutstanding(row({ allocatedAmount: d("1500") })).equals(d("0")),
  );

  // --- D2: only TAX_INVOICE is a debt ---
  ok("TAX_INVOICE is collectible", isCollectible(row()) === true);
  ok(
    "D2 · TAX_INVOICE_RECEIPT is NOT — it was paid at issuance",
    isCollectible(row({ type: "TAX_INVOICE_RECEIPT" })) === false,
  );
  ok("D2 · RECEIPT is not", isCollectible(row({ type: "RECEIPT" })) === false);
  ok("D2 · QUOTE is not", isCollectible(row({ type: "QUOTE" })) === false);
  ok(
    "D2 · CREDIT_NOTE is not",
    isCollectible(row({ type: "CREDIT_NOTE" })) === false,
  );

  // --- only issued documents ---
  ok("DRAFT is not collectible", isCollectible(row({ status: "DRAFT" })) === false);
  ok(
    "PENDING_REVIEW is not collectible",
    isCollectible(row({ status: "PENDING_REVIEW" })) === false,
  );
  ok(
    "issued flag without a date is not collectible",
    isCollectible(row({ issuedAt: null })) === false,
  );

  // --- settled invoices leave ---
  ok(
    "fully paid leaves the list",
    isCollectible(row({ allocatedAmount: d("1000") })) === false,
  );
  ok(
    "D3 · fully credited leaves the list",
    isCollectible(row({ creditedAmount: d("1000") })) === false,
  );
  ok(
    "D3 · paid + credited to zero leaves the list",
    isCollectible(
      row({ allocatedAmount: d("400"), creditedAmount: d("600") }),
      NOW,
    ) === false,
  );

  // --- the expectation gate ---
  const notYet = build([row({ issuedAt: new Date("2026-07-15T10:00:00.000Z") })]);
  ok("issued 5 days ago is NOT awaiting under 30-day terms", notYet.customerCount === 0);

  // 5 days have elapsed, so 7-day terms are still NOT due — the boundary is
  // exact, and being wrong here means asking for money that is not yet owed.
  const sevenDays = build(
    [row({ issuedAt: new Date("2026-07-15T10:00:00.000Z") })],
    7,
  );
  ok("5 days elapsed under 7-day terms is still not awaiting", sevenDays.customerCount === 0);

  const threeDays = build(
    [row({ issuedAt: new Date("2026-07-15T10:00:00.000Z") })],
    3,
  );
  ok("same invoice IS awaiting under 3-day terms", threeDays.customerCount === 1);

  // --- one customer, one row ---
  const grouped = build([
    row({ id: 1, totalAmount: d("1000") }),
    row({ id: 2, totalAmount: d("2400"), documentNumber: "2026-0002" }),
  ]);
  ok("two invoices, one customer = ONE row", grouped.customerCount === 1);
  ok("amounts add up", grouped.customers[0].totalOutstanding.equals(d("3400")));
  ok("both invoices carried", grouped.customers[0].invoices.length === 2);
  ok("total matches", grouped.totalOutstanding.equals(d("3400")));

  // --- ordering: biggest first ---
  const ordered = build([
    row({ id: 1, customerId: 1, customerName: "קטן", totalAmount: d("500") }),
    row({ id: 2, customerId: 2, customerName: "גדול", totalAmount: d("9000") }),
    row({ id: 3, customerId: 3, customerName: "בינוני", totalAmount: d("3000") }),
  ]);
  ok(
    "ordered by amount, largest first",
    ordered.customers.map((c) => c.customerName).join(",") === "גדול,בינוני,קטן",
  );

  // --- oldest expectation wins inside a customer ---
  const twoDates = build([
    row({ id: 1, issuedAt: new Date("2026-05-01T10:00:00.000Z") }),
    row({ id: 2, issuedAt: new Date("2026-06-03T10:00:00.000Z") }),
  ]);
  ok(
    "awaitingSince is the OLDEST expectation",
    twoDates.customers[0].awaitingSince.getTime() ===
      new Date("2026-05-31T10:00:00.000Z").getTime(),
  );
  ok(
    "invoices inside a customer are oldest-first",
    twoDates.customers[0].invoices[0].id === 1,
  );

  // --- unassigned debt is counted, never hidden ---
  const unassigned = build([row({ customerId: null })]);
  ok("no customer: not on the list", unassigned.customerCount === 0);
  ok("no customer: counted, not hidden", unassigned.unassignedCount === 1);

  // --- no contact channel: still listed, and flagged ---
  const noChannel = build([row({ customerPhone: null, customerEmail: null })]);
  ok("no phone and no email: STILL listed", noChannel.customerCount === 1);
  ok("flagged as unreachable", noChannel.customers[0].hasNoContactChannel === true);
  ok(
    "having only an email is reachable",
    build([row({ customerPhone: null, customerEmail: "a@b.co" })]).customers[0]
      .hasNoContactChannel === false,
  );

  // --- partial settlement is visible ---
  const partial = build([row({ allocatedAmount: d("400") })]);
  ok("partial balance carried", partial.customers[0].totalOutstanding.equals(d("600")));
  ok("marked partially settled", partial.customers[0].invoices[0].isPartiallySettled);
  ok(
    "untouched invoice is not marked partial",
    build([row()]).customers[0].invoices[0].isPartiallySettled === false,
  );

  // --- the empty state is a real answer, not an accident ---
  const empty = build([]);
  ok("empty list has no customers", empty.customerCount === 0);
  ok("empty list totals zero", empty.totalOutstanding.equals(d("0")));
  ok("empty list has no orphans", empty.unassignedCount === 0);

  // --- a mixed, realistic batch ---
  const mixed = build([
    row({ id: 1, customerId: 1, customerName: "א", totalAmount: d("1000") }),
    row({ id: 2, customerId: 1, customerName: "א", totalAmount: d("500") }),
    row({ id: 3, customerId: 2, customerName: "ב", totalAmount: d("8000") }),
    row({ id: 4, type: "TAX_INVOICE_RECEIPT", customerId: 3, totalAmount: d("400") }),
    row({ id: 5, customerId: 4, allocatedAmount: d("1000") }),
    row({ id: 6, customerId: 5, creditedAmount: d("1000") }),
    row({ id: 7, customerId: null, totalAmount: d("700") }),
    row({ id: 8, status: "DRAFT", customerId: 6 }),
  ]);
  ok("mixed batch: exactly 2 customers owe", mixed.customerCount === 2);
  ok("mixed batch: total is 9,500", mixed.totalOutstanding.equals(d("9500")));
  ok("mixed batch: one orphan counted", mixed.unassignedCount === 1);
  ok("mixed batch: largest customer first", mixed.customers[0].customerName === "ב");

  console.log(
    failed === 0
      ? "\nCollection · awaiting-payment: ALL CHECKS PASSED"
      : `\nCollection · awaiting-payment: ${failed} CHECK(S) FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

run();
