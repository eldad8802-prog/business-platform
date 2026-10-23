/**
 * Verify — multi-currency money engine (lib/money).
 * Run: npx tsx lib/money/money.verify.test.ts
 *
 * Pins the rules the financial integration relies on: exact parsing (no float), no arithmetic across
 * currencies, explicit rounding, and conversion that refuses instead of guessing.
 */
import assert from "node:assert/strict";

import { sumByCurrency, singleCurrency, totalIn } from "@/lib/money/aggregate";
import { parseCurrency, UnsupportedCurrencyError } from "@/lib/money/currency";
import { divRound, InvalidDecimalError, parseScaled } from "@/lib/money/decimal";
import {
  accountingPolicy,
  canonicalRateString,
  convert,
  displayPolicy,
  selectRate,
  type FxRate,
} from "@/lib/money/fx";
import {
  add,
  CurrencyMismatchError,
  moneyFromDecimal,
  subtract,
  sumSameCurrency,
  toDecimalString,
} from "@/lib/money/money";

let checks = 0;
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks++;
}
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
function throwsCode(label: string, fn: () => unknown, ctor: new (...a: never[]) => Error) {
  assert.throws(fn, ctor, label);
  checks++;
}

const ILS = (s: string) => moneyFromDecimal(s, "ILS");
const USD = (s: string) => moneyFromDecimal(s, "USD");
const EUR = (s: string) => moneyFromDecimal(s, "EUR");

function rate(partial: Partial<FxRate> & Pick<FxRate, "base" | "quote" | "rate">): FxRate {
  return {
    kind: "REPRESENTATIVE",
    source: "BANK_OF_ISRAEL",
    rateDate: "2026-10-20",
    fetchedAt: "2026-10-20T12:00:00Z",
    verification: "VERIFIED",
    ...partial,
  };
}

// ---------------------------------------------------------------- currency
eq("normalises case/space", parseCurrency(" usd "), "USD");
throwsCode("unknown currency refused", () => parseCurrency("GBP"), UnsupportedCurrencyError);
throwsCode("empty currency refused, never defaulted", () => parseCurrency(""), UnsupportedCurrencyError);

// ---------------------------------------------------------------- decimal parsing
eq("exact 2dp", parseScaled("1234.56", 2), BigInt(123456));
eq("negative", parseScaled("-0.5", 2), -BigInt(50));
eq("Prisma.Decimal-like toString", parseScaled({ toString: () => "10.10" }, 2), BigInt(1010));
eq("float 0.1+0.2 is refused, not rounded", (() => { try { parseScaled(0.1 + 0.2, 2); return "parsed"; } catch (e) { return e instanceof InvalidDecimalError ? "refused" : "other"; } })(), "refused");
eq("number 19.99 exact", parseScaled(19.99, 2), BigInt(1999));
throwsCode("3dp into ILS refused without rounding", () => parseScaled("1.005", 2), InvalidDecimalError);
eq("HALF_UP 1.005 → 1.01", parseScaled("1.005", 2, "HALF_UP"), BigInt(101));
eq("HALF_EVEN 1.005 → 1.00", parseScaled("1.005", 2, "HALF_EVEN"), BigInt(100));
eq("HALF_EVEN 1.015 → 1.02", parseScaled("1.015", 2, "HALF_EVEN"), BigInt(102));
eq("HALF_UP symmetric for negatives", parseScaled("-1.005", 2, "HALF_UP"), -BigInt(101));
throwsCode("exponent notation refused", () => parseScaled("1e3", 2), InvalidDecimalError);
eq("divRound half-up", divRound(BigInt(5), BigInt(2), "HALF_UP"), BigInt(3));
eq("divRound half-even", divRound(BigInt(5), BigInt(2), "HALF_EVEN"), BigInt(2));
eq("divRound negative half-up", divRound(-BigInt(5), BigInt(2), "HALF_UP"), -BigInt(3));

// ---------------------------------------------------------------- money arithmetic
eq("toDecimalString keeps 2dp", toDecimalString(ILS("1500")), "1500.00");
eq("add same currency", toDecimalString(add(ILS("0.10"), ILS("0.20"))), "0.30");
eq("subtract to negative (refund)", toDecimalString(subtract(ILS("100"), ILS("150.5"))), "-50.50");
throwsCode("ILS + USD is an error", () => add(ILS("1"), USD("1")), CurrencyMismatchError);
throwsCode("sumSameCurrency refuses a mix", () => sumSameCurrency([ILS("1"), EUR("1")], "ILS"), CurrencyMismatchError);
eq("sumSameCurrency empty = zero", toDecimalString(sumSameCurrency([], "USD")), "0.00");

// ---------------------------------------------------------------- aggregation
const mixed = sumByCurrency([ILS("100"), USD("10"), ILS("50.25"), EUR("5"), USD("-2.5")]);
eq("per-currency ILS", toDecimalString(mixed.get("ILS")!), "150.25");
eq("per-currency USD (refund netted)", toDecimalString(mixed.get("USD")!), "7.50");
eq("mixed → no single currency", singleCurrency(mixed), null);
eq("single currency detected", singleCurrency(sumByCurrency([ILS("1"), ILS("2")])), "ILS");

// ---------------------------------------------------------------- conversion
const usdIls = rate({ base: "USD", quote: "ILS", rate: "3.7250" });
const eurIls = rate({ base: "EUR", quote: "ILS", rate: "4.0310" });
const acct = accountingPolicy("2026-10-21");

const c1 = convert(USD("100"), "ILS", usdIls, acct);
ok("USD→ILS converts", c1.ok && c1.converted && !c1.inverted && !c1.approximate);
eq("USD 100 × 3.725 = ILS 372.50", c1.ok ? toDecimalString(c1.money) : "", "372.50");

const c2 = convert(ILS("372.50"), "USD", usdIls, acct);
eq("inverse ILS→USD", c2.ok ? toDecimalString(c2.money) : "", "100.00");
ok("inverse flagged", c2.ok && c2.inverted);

const c3 = convert(USD("0.01"), "ILS", usdIls, acct);
eq("rounding of 0.03725 → 0.04 (HALF_UP)", c3.ok ? toDecimalString(c3.money) : "", "0.04");

const same = convert(ILS("10"), "ILS", null, acct);
ok("same currency needs no rate", same.ok && !same.converted && same.rate === null);

const refused = (r: ReturnType<typeof convert>) => (r.ok ? "OK" : r.reason);
eq("missing rate refused", refused(convert(USD("1"), "ILS", null, acct)), "RATE_MISSING");
eq("wrong pair refused", refused(convert(EUR("1"), "ILS", usdIls, acct)), "RATE_PAIR_MISMATCH");
eq("unverified refused for accounting", refused(convert(USD("1"), "ILS", rate({ base: "USD", quote: "ILS", rate: "3.7", verification: "UNVERIFIED" }), acct)), "RATE_UNVERIFIED");
eq("display rate refused for accounting", refused(convert(USD("1"), "ILS", rate({ base: "USD", quote: "ILS", rate: "3.7", kind: "DISPLAY" }), acct)), "RATE_KIND_NOT_ALLOWED");
eq("stale rate refused", refused(convert(USD("1"), "ILS", rate({ base: "USD", quote: "ILS", rate: "3.7", rateDate: "2026-10-10" }), acct)), "RATE_STALE");
eq("future rate refused", refused(convert(USD("1"), "ILS", rate({ base: "USD", quote: "ILS", rate: "3.7", rateDate: "2026-10-22" }), acct)), "RATE_FROM_FUTURE");
eq("zero rate refused", refused(convert(USD("1"), "ILS", rate({ base: "USD", quote: "ILS", rate: "0" }), acct)), "RATE_INVALID");
eq("garbage rate refused", refused(convert(USD("1"), "ILS", rate({ base: "USD", quote: "ILS", rate: "abc" }), acct)), "RATE_INVALID");
eq("bad date refused", refused(convert(USD("1"), "ILS", rate({ base: "USD", quote: "ILS", rate: "3.7", rateDate: "20/10/2026" }), acct)), "RATE_INVALID");

const disp = convert(USD("10"), "ILS", rate({ base: "USD", quote: "ILS", rate: "3.7", kind: "DISPLAY", verification: "UNVERIFIED" }), displayPolicy("2026-10-21"));
ok("display conversion allowed but approximate", disp.ok && disp.approximate);

// The original amount never changes because a rate changed: conversion returns a NEW value.
const original = USD("100");
convert(original, "ILS", usdIls, acct);
eq("source value untouched", toDecimalString(original), "100.00");

eq("canonical rate string", canonicalRateString("3.725"), "3.7250000000");

// ---------------------------------------------------------------- totals in a target currency
const lookup = (c: string) => (c === "USD" ? usdIls : c === "EUR" ? eurIls : null);
const total = totalIn(mixed, "ILS", lookup, acct);
// 150.25 + 7.50×3.725 (27.9375→27.94) + 5×4.031 (20.155→20.16) = 198.35
eq("mixed total in ILS", total.ok ? toDecimalString(total.total) : "", "198.35");
ok("total flagged converted", total.ok && total.converted && total.ratesUsed.length === 2);

const partial = totalIn(mixed, "ILS", (c) => (c === "USD" ? usdIls : null), acct);
ok("missing EUR rate → no total at all", !partial.ok);
eq("…and it says which currency", partial.ok ? [] : partial.unconverted.map((u) => `${u.currency}:${u.reason}`), ["EUR:RATE_MISSING"]);

const inEur = totalIn(sumByCurrency([ILS("100"), EUR("10")]), "EUR", (c) => (c === "ILS" ? eurIls : null), acct);
// ILS 100 / 4.031 = 24.8077… → 24.81; + 10 = 34.81
eq("display in EUR via inverse rate", inEur.ok ? toDecimalString(inEur.total) : "", "34.81");

// ---------------------------------------------------------------- rate selection
const older = rate({ base: "USD", quote: "ILS", rate: "3.70", rateDate: "2026-10-19" });
const unverified = rate({ base: "USD", quote: "ILS", rate: "3.80", rateDate: "2026-10-21", verification: "UNVERIFIED" });
eq("selects newest acceptable rate", selectRate([older, usdIls, unverified], "USD", "ILS", acct)?.rate, "3.7250");
eq("no acceptable rate → null", selectRate([unverified], "USD", "ILS", acct), null);

console.log(`money.verify: ${checks} checks passed`);
