/**
 * Collection · wire-shape verify:
 *   npx tsx lib/services/billing/collection/awaiting-payment.serializer.test.ts
 *
 * One invariant carries this file: money must cross the wire exactly. A Decimal
 * that becomes a float somewhere in this boundary is a number the owner reads,
 * repeats to his customer, and is wrong about.
 */

import { Prisma } from "@prisma/client";

import { buildAwaitingPaymentList, type InvoiceRow } from "./awaiting-payment.rules";
import { serializeAwaitingPaymentList } from "./awaiting-payment.serializer";

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
const NOW = new Date("2026-07-20T10:00:00.000Z");

function row(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 1,
    documentNumber: "2026-0001",
    type: "TAX_INVOICE",
    status: "ISSUED",
    issuedAt: new Date("2026-06-03T10:00:00.000Z"),
    totalAmount: d("1000"),
    currency: "ILS",
    allocatedAmount: d("0"),
    creditedAmount: d("0"),
    customerId: 7,
    customerName: "משה",
    customerPhone: "0501234567",
    customerEmail: null,
    ...over,
  };
}

const serialize = (rows: InvoiceRow[]) =>
  serializeAwaitingPaymentList(
    buildAwaitingPaymentList({ rows, configuredTermsDays: null, now: NOW }),
  );

function run() {
  const out = serialize([row({ totalAmount: d("3400") })]);
  const customer = out.customers[0];

  // --- shape ---
  ok("one customer", out.customerCount === 1);
  ok("customer id carried", customer.customerId === 7);
  ok("name carried", customer.customerName === "משה");
  ok("phone carried", customer.customerPhone === "0501234567");

  // --- money crosses as an exact string ---
  ok("exact value is a string", typeof customer.totalOutstanding === "string");
  ok("exact value keeps two places", customer.totalOutstanding === "3400.00");
  ok("display value is grouped", customer.totalOutstandingFormatted === "3,400");
  ok("list total exact", out.totalOutstanding === "3400.00");
  ok("list total formatted", out.totalOutstandingFormatted === "3,400");

  // --- agorot survive ---
  const agorot = serialize([row({ totalAmount: d("1234.56") })]);
  ok("exact agorot", agorot.customers[0].totalOutstanding === "1234.56");
  ok("displayed agorot", agorot.customers[0].totalOutstandingFormatted === "1,234.56");

  // --- a value no float can hold ---
  const big = serialize([row({ totalAmount: d("99999999.99") })]);
  ok("large exact amount is not rounded", big.customers[0].totalOutstanding === "99999999.99");
  ok(
    "large amount is grouped for display",
    big.customers[0].totalOutstandingFormatted === "99,999,999.99",
  );

  // --- dates: ISO for machines, Hebrew for the owner ---
  ok("awaitingSince is ISO", customer.awaitingSince === "2026-07-03T10:00:00.000Z");
  ok("awaitingSince is displayed dd/mm/yyyy", customer.awaitingSinceFormatted === "03/07/2026");
  ok("invoice issuedAt is ISO", customer.invoices[0].issuedAt === "2026-06-03T10:00:00.000Z");
  ok("invoice date displayed", customer.invoices[0].issuedAtFormatted === "03/06/2026");

  // --- no countdown ever reaches the client (Constitution, Article 8) ---
  const asJson = JSON.parse(JSON.stringify(out));
  ok("daysAwaiting is not serialized", !("daysAwaiting" in asJson.customers[0].invoices[0]));
  ok("maxDaysAwaiting is not serialized", !("maxDaysAwaiting" in asJson.customers[0]));

  // --- the whole payload is JSON-safe: no Decimal, no Date ---
  ok(
    "round-trips through JSON unchanged",
    JSON.stringify(JSON.parse(JSON.stringify(out))) === JSON.stringify(out),
  );

  // --- partial settlement and flags survive ---
  const partial = serialize([row({ allocatedAmount: d("400") })]);
  ok("partial balance exact", partial.customers[0].totalOutstanding === "600.00");
  ok("partial flag carried", partial.customers[0].invoices[0].isPartiallySettled === true);

  const unreachable = serialize([row({ customerPhone: null, customerEmail: null })]);
  ok("no-contact flag carried", unreachable.customers[0].hasNoContactChannel === true);

  // --- orphans are counted on the wire too, never dropped ---
  const orphan = serialize([row({ customerId: null })]);
  ok("orphan counted", orphan.unassignedCount === 1);
  ok("orphan not listed", orphan.customerCount === 0);
  ok("empty total is zero, not empty string", orphan.totalOutstanding === "0.00");
  ok("empty total displayed as 0", orphan.totalOutstandingFormatted === "0");

  console.log(
    failed === 0
      ? "\nCollection · serializer: ALL CHECKS PASSED"
      : `\nCollection · serializer: ${failed} CHECK(S) FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

run();
