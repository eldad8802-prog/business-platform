/**
 * Revenue report uploads — reading printed amounts and dates exactly, or refusing with a code. docs/revenue-report-uploads.md
 * Pure: no database, no network, no clock. Synthetic values only — this proves the reading rules, NOT any vendor's
 * format (the registry ships empty until real samples exist).
 *
 *   npm run test:revenue-report-uploads:values
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { validateSettlementDraft, validateZDraft } from "./core";
import type { SettlementDraft, ZReportDraft } from "./contract";
import { asDeduction, linesDifference, readAmount, readDate, type AmountRead } from "./report-values";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

const B = (n: number | string) => BigInt(n);
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const minor = (r: AmountRead) => {
  assert.ok(r.ok, `expected ok, got ${show(r)}`);
  return (r as { minor: bigint }).minor;
};
const code = (r: AmountRead | ReturnType<typeof readDate>) => (r.ok ? "ok" : r.code);
const DOT = { decimal: "." as const };
const COMMA = { decimal: "," as const };

console.log("1. amounts — decimal point exports");
check("plain, with ₪, with ש״ח / ש\"ח / NIS, spaces and direction marks", () => {
  assert.equal(minor(readAmount("1234.50")), B(123450));
  assert.equal(minor(readAmount("₪ 1,234.50")), B(123450));
  assert.equal(minor(readAmount("1,234.50 ש״ח")), B(123450));
  assert.equal(minor(readAmount('1,234.50 ש"ח')), B(123450));
  assert.equal(minor(readAmount("NIS 1,234.50")), B(123450));
  assert.equal(minor(readAmount("‏1,234.50‏")), B(123450));
  assert.equal(minor(readAmount("1 234.50".replace(" ", ""))), B(123450));
});
check("thousands groups up to millions; whole numbers; one decimal; leading-dot cents", () => {
  assert.equal(minor(readAmount("1,234,567.89")), B(123456789));
  assert.equal(minor(readAmount("800")), B(80000));
  assert.equal(minor(readAmount("800.5")), B(80050));
  assert.equal(minor(readAmount(".75")), B(75));
  assert.equal(minor(readAmount("0.00")), B(0));
});
check("no float drift: values a float would round are exact", () => {
  assert.equal(minor(readAmount("0.29")), B(29));
  assert.equal(minor(readAmount("1,000,000.07")), B(100000007));
  assert.equal(minor(readAmount("4,503,599,627,370.49")), B("450359962737049"));
});
check("negatives: leading, trailing, U+2212, parentheses — all the same value", () => {
  for (const s of ["-150.00", "150.00-", "−150.00", "(150.00)", "(₪150.00)", "₪ -150.00"]) {
    const r = readAmount(s);
    assert.equal(minor(r), B(-15000), s);
    assert.equal(r.ok && r.negative, true, s);
  }
  assert.equal(minor(readAmount("+150.00")), B(15000));
});
check("refused, never guessed: decimal comma under a decimal-point format, broken groups, 3 decimals", () => {
  assert.equal(code(readAmount("12,50", DOT)), "SEPARATOR_MISMATCH");
  assert.equal(code(readAmount("1,23.00", DOT)), "SEPARATOR_MISMATCH");
  assert.equal(code(readAmount("1234,567.00", DOT)), "SEPARATOR_MISMATCH");
  assert.equal(code(readAmount("1.234.50", DOT)), "SEPARATOR_MISMATCH");
  assert.equal(code(readAmount("12.345", DOT)), "TOO_MANY_DECIMALS");
  assert.equal(code(readAmount("12.", DOT)), "NOT_A_NUMBER");
});
check("refused: empty, text, a lone sign, a double sign, exponent, a date", () => {
  assert.equal(code(readAmount("")), "EMPTY");
  assert.equal(code(readAmount("   ")), "EMPTY");
  assert.equal(code(readAmount(null)), "EMPTY");
  assert.equal(code(readAmount("סה״כ")), "NOT_A_NUMBER");
  assert.equal(code(readAmount("-")), "NOT_A_NUMBER");
  assert.equal(code(readAmount("--5")), "NOT_A_NUMBER");
  assert.equal(code(readAmount("1e5")), "NOT_A_NUMBER");
  assert.equal(code(readAmount("03/11/2026")), "NOT_A_NUMBER");
});
check("above the store's ceiling is refused", () => {
  assert.equal(code(readAmount("10,000,000,000,000.01")), "TOO_LARGE");
});

console.log("2. amounts — decimal comma exports (stated by the parser, never inferred)");
check("1.234,50 and 1.234.567,89 and 12,50", () => {
  assert.equal(minor(readAmount("1.234,50", COMMA)), B(123450));
  assert.equal(minor(readAmount("1.234.567,89", COMMA)), B(123456789));
  assert.equal(minor(readAmount("12,50", COMMA)), B(1250));
  assert.equal(minor(readAmount("(1.234,50)", COMMA)), B(-123450));
});
check("a decimal-point value under a decimal-comma format is refused", () => {
  assert.equal(code(readAmount("1,234.50", COMMA)), "SEPARATOR_MISMATCH");
  assert.equal(code(readAmount("12.50", COMMA)), "SEPARATOR_MISMATCH");
});

console.log("3. refunds, voids, fees — magnitudes");
check("a refund printed negative or positive is the same deduction", () => {
  assert.equal(minor(asDeduction(readAmount("-150.00"))), B(15000));
  assert.equal(minor(asDeduction(readAmount("150.00"))), B(15000));
  assert.equal(minor(asDeduction(readAmount("(150.00)"))), B(15000));
  assert.equal(code(asDeduction(readAmount("abc"))), "NOT_A_NUMBER");
});
check("a refund day: gross − refund − void = total passes the Z check; a refund read into the wrong column fails it", () => {
  const read = (s: string) => minor(asDeduction(readAmount(s)));
  const z: ZReportDraft = {
    businessDay: "2026-11-03", registerKey: "1", zNumber: B(2),
    grossMinor: read("950.00"), refundMinor: read("-150.00"), voidMinor: read("0.00"),
    totalMinor: minor(readAmount("800.00")), vatMinor: minor(readAmount("122.03")),
    tenders: [
      { method: "CASH", label: "", amountMinor: minor(readAmount("300.00")) },
      { method: "CARD", label: "", amountMinor: minor(readAmount("500.00")) },
    ],
    vatLines: [],
  } as unknown as ZReportDraft;
  const ok = validateZDraft(z);
  assert.equal(ok.ok, true, show(ok));
  const wrong = validateZDraft({ ...z, refundMinor: B(0) } as ZReportDraft);
  assert.equal(wrong.ok, false);
  assert.ok(!wrong.ok && wrong.codes.includes("TOTAL_MISMATCH"));
});
check("a settlement: gross − fee − other = net passes; a fee read as negative into net fails", () => {
  const s: SettlementDraft = {
    acquirer: "synthetic_acq", valueDate: "2026-11-05", externalId: "batch-1",
    grossMinor: minor(readAmount("1,000.00")), feeMinor: minor(asDeduction(readAmount("-12.50"))),
    otherDeductionsMinor: B(0), netMinor: minor(readAmount("987.50")),
  };
  assert.equal(validateSettlementDraft(s).ok, true);
  const wrong = validateSettlementDraft({ ...s, netMinor: minor(readAmount("1,012.50")) });
  assert.equal(wrong.ok, false);
});
check("tenders against the printed total: 0 when they add up, the gap otherwise (never adjusted)", () => {
  assert.equal(linesDifference(B(80000), [B(30000), B(50000)]), B(0));
  assert.equal(linesDifference(B(80000), [B(30000), B(45000)]), B(-5000));
});

console.log("4. dates");
check("day-first with / . - ; two-digit year; leading zeros optional", () => {
  for (const s of ["03/11/2026", "3/11/2026", "03.11.2026", "03-11-2026", "03/11/26", "3.11.26"]) {
    const r = readDate(s);
    assert.ok(r.ok && r.day === "2026-11-03", `${s} → ${show(r)}`);
  }
});
check("ISO only when the parser states YMD; ISO under DMY is refused", () => {
  const r = readDate("2026-11-03", { order: "YMD" });
  assert.ok(r.ok && r.day === "2026-11-03");
  assert.equal(code(readDate("2026-11-03", { order: "DMY" })), "NOT_A_DATE");
});
check("month-first is never read: 11/03/2026 is 11 March under DMY, and 03/13/2026 is refused", () => {
  const r = readDate("11/03/2026");
  assert.ok(r.ok && r.day === "2026-03-11");
  assert.equal(code(readDate("03/13/2026")), "NOT_A_CALENDAR_DAY");
});
check("impossible days refused: 30/02, 31/04, 29/02 on a non-leap year; 29/02/2028 read", () => {
  assert.equal(code(readDate("30/02/2026")), "NOT_A_CALENDAR_DAY");
  assert.equal(code(readDate("31/04/2026")), "NOT_A_CALENDAR_DAY");
  assert.equal(code(readDate("29/02/2026")), "NOT_A_CALENDAR_DAY");
  const r = readDate("29/02/2028");
  assert.ok(r.ok && r.day === "2028-02-29");
});
check("a time after the date is returned as printed and never moves the day (a Z closed at 00:40)", () => {
  const r = readDate("04/11/2026 00:40");
  assert.ok(r.ok && r.day === "2026-11-04" && r.time === "00:40", show(r));
  const r2 = readDate("03/11/2026 23:59:59");
  assert.ok(r2.ok && r2.day === "2026-11-03" && r2.time === "23:59:59");
  assert.equal(code(readDate("03/11/2026 24:10")), "NOT_A_DATE");
});
check("refused: empty, mixed separators, words, an amount", () => {
  assert.equal(code(readDate("")), "EMPTY");
  assert.equal(code(readDate(undefined)), "EMPTY");
  assert.equal(code(readDate("03/11-2026")), "NOT_A_DATE");
  assert.equal(code(readDate("3 בנובמבר 2026")), "NOT_A_DATE");
  assert.equal(code(readDate("1,234.50")), "NOT_A_DATE");
});

console.log("5. static");
check("the helpers are pure: no database, network, clock or randomness", () => {
  const src = fs.readFileSync(new URL("./report-values.ts", import.meta.url), "utf8");
  for (const banned of ["prisma", "fetch(", "Date.now", "new Date()", "Math.random", "parseFloat", "Number(raw"]) {
    assert.ok(!src.includes(banned), banned);
  }
});
check("no vendor is named in the helpers (the registry still ships empty)", () => {
  const src = fs.readFileSync(new URL("./report-values.ts", import.meta.url), "utf8").toLowerCase();
  for (const v of ["isracard", "cardcom", "tranzila", "max ", "cal ", "shva", "payplus", "rivhit", "priority"]) {
    assert.ok(!src.includes(v), v);
  }
});

console.log(`\n[revenue-report-values] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
