/**
 * Collection · display helpers verify:
 *   npx tsx lib/services/billing/collection/collection-display.test.ts
 *
 * The phone cases matter more than they look. Every one of them is a way the
 * owner's message could reach the wrong person — so anything ambiguous must
 * return null and fall back to "copy", never to a guess.
 */

import { currencySymbol, toWhatsAppNumber } from "./collection-display";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function run() {
  // --- currency ---
  ok("ILS", currencySymbol("ILS") === "₪");
  ok("USD", currencySymbol("USD") === "$");
  ok("EUR", currencySymbol("EUR") === "€");
  ok("unknown code is shown, not dropped", currencySymbol("GBP") === "GBP");

  // --- Israeli mobile, the ordinary case ---
  ok("05X mobile", toWhatsAppNumber("0501234567") === "972501234567");
  ok("dashes stripped", toWhatsAppNumber("050-123-4567") === "972501234567");
  ok("spaces stripped", toWhatsAppNumber("050 123 4567") === "972501234567");
  ok("parentheses stripped", toWhatsAppNumber("(050) 1234567") === "972501234567");
  ok("surrounding whitespace", toWhatsAppNumber("  0501234567  ") === "972501234567");

  // --- Israeli landline (9 digits) ---
  ok("09 landline", toWhatsAppNumber("091234567") === "97291234567");

  // --- already international ---
  ok("972 prefix passes through", toWhatsAppNumber("972501234567") === "972501234567");
  ok("+972 prefix", toWhatsAppNumber("+972-50-123-4567") === "972501234567");
  ok("+972 with spaces", toWhatsAppNumber("+972 50 1234567") === "972501234567");

  // --- other countries: trust the explicit + ---
  ok("US with +", toWhatsAppNumber("+1 415 555 0123") === "14155550123");
  ok("UK with +", toWhatsAppNumber("+44 20 7946 0958") === "442079460958");

  // --- everything ambiguous must refuse ---
  ok("null", toWhatsAppNumber(null) === null);
  ok("undefined", toWhatsAppNumber(undefined) === null);
  ok("empty", toWhatsAppNumber("") === null);
  ok("whitespace only", toWhatsAppNumber("   ") === null);
  ok("letters only", toWhatsAppNumber("no phone") === null);
  ok("too short", toWhatsAppNumber("050123") === null);
  ok("11 local digits is not a real IL number", toWhatsAppNumber("05012345678") === null);
  ok("972 with too few digits", toWhatsAppNumber("9725012") === null);
  ok(
    "bare digits with no country code and no zero: refuse rather than guess",
    toWhatsAppNumber("501234567") === null,
  );
  ok("+ with too few digits", toWhatsAppNumber("+1 415") === null);

  // --- an extension is noise, and stripping it silently would be wrong ---
  ok(
    "extension digits are not silently accepted as part of the number",
    toWhatsAppNumber("03-1234567 ext 22") !== "9731234567",
  );

  console.log(
    failed === 0
      ? "\nCollection · display: ALL CHECKS PASSED"
      : `\nCollection · display: ${failed} CHECK(S) FAILED`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

run();
