/**
 * WP2 unit tests (run manually):
 *   npx tsx lib/services/billing/uniform/uniform-wp2-units.test.ts
 *
 * Encoding, field formatters (against exact spec 1.31 §2.4 examples), and layout
 * self-consistency. No DB, no IO.
 */
import { encodeIso8859_8i } from "@/lib/services/billing/uniform/uniform-encoding";
import {
  formatAlpha,
  formatDate,
  formatNumeric,
  formatSignedAmount,
  formatTime,
  formatUnsignedAmount,
} from "@/lib/services/billing/uniform/uniform-field-format";
import { ALL_LAYOUTS, assertLayoutConsistency } from "@/lib/services/billing/uniform/uniform-layout-1_31";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (!cond) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

// ---- encoding ----
{
  const heb = encodeIso8859_8i("אבג"); // א=05D0→E0, ב→E1, ג→E2
  ok("Hebrew א→0xE0 ב→0xE1 ג→0xE2", heb[0] === 0xe0 && heb[1] === 0xe1 && heb[2] === 0xe2);
  ok("Hebrew ת→0xFA", encodeIso8859_8i("ת")[0] === 0xfa);
  const asc = encodeIso8859_8i("ABC123");
  ok("ASCII passthrough", asc.toString("latin1") === "ABC123");
  ok("single byte per char", encodeIso8859_8i("לקוח 12").length === 7);
  ok("ל→0xEC (U+05DC)", encodeIso8859_8i("ל")[0] === 0xec);
  ok('gershayim ״→ASCII "', encodeIso8859_8i("״")[0] === 0x22);
  ok("unknown → '?'", encodeIso8859_8i("\u{1F600}".slice(0, 1))[0] === 0x3f);
}

// ---- alpha / numeric ----
{
  ok("alpha left-justify + space pad", formatAlpha("abc", 5) === "abc  ");
  ok("alpha truncates to fit", formatAlpha("abcdef", 4) === "abcd");
  ok("alpha empty → spaces", formatAlpha(null, 3) === "   ");
  ok("numeric zero-pad right-justify", formatNumeric("1234", 8) === "00001234");
  ok("numeric strips non-digits", formatNumeric("12-34", 6) === "001234");
  let threw = false;
  try { formatNumeric("1234567", 4); } catch { threw = true; }
  ok("numeric overflow throws", threw);
}

// ---- signed amounts (exact spec §2.4 examples: X9(5)v99) ----
{
  ok('spec: -12345.65 → "-1234565"', formatSignedAmount("-12345.65", 8, 2) === "-1234565");
  ok('spec: 1245.65 → "+0124565"', formatSignedAmount("1245.65", 8, 2) === "+0124565");
  ok('spec: 1245 → "+0124500"', formatSignedAmount("1245", 8, 2) === "+0124500");
  ok("117.00 @X9(12)v99 → +00000000011700", formatSignedAmount("117.00", 15, 2) === "+00000000011700");
  ok("0 → +…0 (§2.4.יא)", formatSignedAmount("0", 15, 2) === "+00000000000000");
  ok("quantity X9(12)v9999: 1 → +0000000000010000", formatSignedAmount("1.0000", 17, 4) === "+0000000000010000");
  ok("extra decimals truncate", formatSignedAmount("100.0000", 15, 2) === "+00000000010000");
  let threw = false;
  try { formatSignedAmount("9999999999999", 15, 2); } catch { threw = true; }
  ok("amount overflow throws", threw);
}

// ---- unsigned amount (VAT rate 9(2)v99) ----
{
  ok('VAT 17.00 → "1700"', formatUnsignedAmount("17.00", 4, 2) === "1700");
  ok('VAT 15.50 → "1550"', formatUnsignedAmount("15.50", 4, 2) === "1550");
  ok('VAT 0 → "0000"', formatUnsignedAmount("0", 4, 2) === "0000");
}

// ---- date / time ----
{
  ok("ISO → YYYYMMDD", formatDate("2026-06-15T10:00:00.000Z") === "20260615");
  ok("compact date passthrough", formatDate("20260615") === "20260615");
  ok("null date → zeros", formatDate(null) === "00000000");
  ok("ISO → HHMM", formatTime("2026-06-15T10:05:00.000Z") === "1005");
  ok("null time → zeros", formatTime(null) === "0000");
}

// ---- layout self-consistency (Σlen == declared length) ----
{
  for (const l of ALL_LAYOUTS) {
    let consistent = true;
    try { assertLayoutConsistency(l); } catch { consistent = false; }
    ok(`layout ${l.code} Σlen == ${l.length}`, consistent);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll WP2 unit tests passed.");
