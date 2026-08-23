/**
 * Collection · message verify (pure — no DB, no network, no AI):
 *   npx tsx lib/services/billing/collection/collection-message.test.ts
 *
 * Most of these assertions check what the message must NOT say. That is
 * deliberate: the wording is the product here, and the ways it can go wrong —
 * sounding like a debt collector, counting days, blaming the customer — are
 * more specific than the ways it can go right.
 */

import {
  buildCollectionMessage,
  formatAmount,
  formatHebrewDate,
  type MessageInvoiceLine,
} from "./collection-message";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const inv = (over: Partial<MessageInvoiceLine> = {}): MessageInvoiceLine => ({
  documentNumber: "2026-0042",
  amount: "3,400",
  issuedOn: new Date("2026-06-03T10:00:00.000Z"),
  ...over,
});

const base = {
  customerName: "משה",
  totalAmount: "3,400",
  currencySymbol: "₪",
  businessName: "מיזוג רונן",
};

function run() {
  // --- formatting ---
  ok("date is dd/mm/yyyy", formatHebrewDate(new Date("2026-06-03T10:00:00Z")) === "03/06/2026");
  ok("thousands separated", formatAmount(3400) === "3,400");
  ok("large number grouped", formatAmount(1234567) === "1,234,567");
  ok("agorot kept when present", formatAmount(99.5) === "99.50");
  ok("round amount has no decimals", formatAmount(100) === "100");
  ok("string input accepted", formatAmount("3400") === "3,400");

  // --- one invoice ---
  const one = buildCollectionMessage({ ...base, invoices: [inv()] });
  ok("addresses the customer by name", one.includes("היי משה"));
  ok("names the document", one.includes("2026-0042"));
  ok("states the amount", one.includes("3,400 ₪"));
  ok("states the date", one.includes("03/06/2026"));
  ok("signs off as the business", one.trimEnd().endsWith("מיזוג רונן"));

  // --- RULE 1 · assume good faith ---
  ok("offers the benefit of the doubt", one.includes("אם כבר העברת"));
  ok("never accuses", !one.includes("לא שילמת"));
  ok("never demands", !one.includes("נא לשלם") && !one.includes("עליך לשלם"));

  // --- RULE 3 · no collections vocabulary ---
  for (const word of ["חוב", "גבייה", "באיחור", "התראה", "עיכוב", "פיגור"]) {
    ok(`the word "${word}" never appears`, !one.includes(word));
  }

  // --- RULE 2 · no countdown ---
  ok("no day count", !/\d+\s*ימים/.test(one));
  ok("no 'since X days'", !one.includes("כבר") || !/\d+\s*ימ/.test(one));

  // --- RULE 4 · sounds like a person ---
  ok("no exclamation marks", !one.includes("!"));
  ok("does not apologise", !one.includes("מצטער") && !one.includes("סליחה"));
  ok("short — under ten lines", one.split("\n").length < 10);
  ok("first person", one.includes("אצלי") || one.includes("אשמח"));

  // --- payment link is optional, never load-bearing ---
  ok("no link section when none supplied", !one.includes("לשלם כאן"));
  const withLink = buildCollectionMessage({
    ...base,
    invoices: [inv()],
    paymentUrl: "https://pay.example/abc",
  });
  ok("link included when supplied", withLink.includes("https://pay.example/abc"));
  ok("link is offered, not commanded", withLink.includes("אפשר גם לשלם כאן"));

  // --- several invoices become a short list, not several messages ---
  const many = buildCollectionMessage({
    ...base,
    totalAmount: "5,900",
    invoices: [
      inv({ documentNumber: "2026-0042", amount: "3,400" }),
      inv({
        documentNumber: "2026-0051",
        amount: "2,500",
        issuedOn: new Date("2026-06-20T10:00:00.000Z"),
      }),
    ],
  });
  ok("states how many are open", many.includes("2 חשבוניות"));
  ok("states the total", many.includes("5,900 ₪"));
  ok("lists the first", many.includes("2026-0042"));
  ok("lists the second", many.includes("2026-0051"));
  ok("uses bullets", many.includes("•"));
  ok("still assumes good faith", many.includes("אם כבר העברת"));
  for (const word of ["חוב", "גבייה", "באיחור"]) {
    ok(`multi-invoice: "${word}" never appears`, !many.includes(word));
  }

  // --- degenerate inputs must still produce something sendable ---
  const noName = buildCollectionMessage({
    ...base,
    customerName: "   ",
    invoices: [inv()],
  });
  ok("blank customer name still greets", noName.startsWith("היי,"));
  const noNumber = buildCollectionMessage({
    ...base,
    invoices: [inv({ documentNumber: null })],
  });
  ok("missing document number still reads correctly", noNumber.includes("שחשבונית מ-"));
  ok("no dangling separator", !noNumber.includes("· ·"));

  // --- determinism: the owner can trust what he approves ---
  ok(
    "identical input produces identical output",
    buildCollectionMessage({ ...base, invoices: [inv()] }) ===
      buildCollectionMessage({ ...base, invoices: [inv()] }),
  );

  console.log(
    failed === 0
      ? "\nCollection · message: ALL CHECKS PASSED"
      : `\nCollection · message: ${failed} CHECK(S) FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

run();
