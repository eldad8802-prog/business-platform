/**
 * finance-ui proof (`npm run verify:finance-ui`).
 *
 * The shared Secretary/Payables presentation layer:
 *   - one money format (whole amounts without ".00", agorot always 2 digits),
 *     and no formatter ever changes the value it was given;
 *   - day distances are Israel CALENDAR days, correct around Israel midnight
 *     (the hours when a UTC comparison is off by one);
 *   - every server state has a label and a tone, labels are the existing
 *     wording, and "טופל" never looks like "שולם";
 *   - English server errors never reach the owner; Hebrew ones pass through.
 */

import {
  civilDaysFromToday,
  countPhrase,
  formatAmount,
  formatShortDate,
  hebrewErrorMessage,
  israelDayKey,
  relativeDayText,
} from "./format";
import {
  ALL_PAYABLES_STATES,
  ALL_SECRETARY_STATUSES,
  SECRETARY_STATUS_LABEL,
  statusLabel,
  statusTone,
} from "./status";
import { STATE_LABEL } from "@/lib/payables/payables-client";

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const strip = (v: string) => v.replace(/[‎‏ \s]/g, " ").replace(/ +/g, " ").trim();
const digits = (v: string) => v.replace(/[^\d.]/g, "");

// ── money ───────────────────────────────────────────────────────────────────
check(digits(formatAmount("3545")) === "3545", "whole amount keeps its value", formatAmount("3545"));
check(!formatAmount("3545.00").includes(".00"), "whole amount drops .00", formatAmount("3545.00"));
check(digits(formatAmount("15.5")) === "15.50", "agorot show two digits", formatAmount("15.5"));
check(digits(formatAmount("2.10")) === "2.10", "2.10 stays 2.10 (never rounded to 2)", formatAmount("2.10"));
check(digits(formatAmount("0.01")) === "0.01", "one agora is not rounded away", formatAmount("0.01"));
check(strip(formatAmount("3545")).includes("₪"), "ILS renders the shekel sign", formatAmount("3545"));
check(formatAmount("abc") === "abc", "a non-number is shown as given, never as 0");
check(digits(formatAmount("1234567.89")) === "1234567.89", "large amount with agorot keeps every digit", formatAmount("1234567.89"));

// ── Israel calendar days ────────────────────────────────────────────────────
// 2026-09-15 is a due day. Stored either as UTC midnight (payables) or 09:00
// local (secretary). At 00:30 and 23:30 Israel time on that day, the distance
// must be 0 — a UTC comparison gets one of these wrong.
const dueUtcMidnight = "2026-09-15T00:00:00.000Z";
const dueLocalMorning = "2026-09-15T06:00:00.000Z"; // 09:00 IDT
const justAfterIsraelMidnight = new Date("2026-09-14T21:30:00.000Z"); // 00:30 IDT on 15.09
const lateInIsraelDay = new Date("2026-09-15T20:30:00.000Z"); // 23:30 IDT on 15.09
const nextIsraelDay = new Date("2026-09-15T21:30:00.000Z"); // 00:30 IDT on 16.09
check(israelDayKey(justAfterIsraelMidnight) === "2026-09-15", "00:30 Israel is already the 15th", israelDayKey(justAfterIsraelMidnight));
for (const due of [dueUtcMidnight, dueLocalMorning]) {
  check(civilDaysFromToday(due, justAfterIsraelMidnight) === 0, `due day reads 0 at 00:30 (${due})`);
  check(civilDaysFromToday(due, lateInIsraelDay) === 0, `due day reads 0 at 23:30 (${due})`);
  check(civilDaysFromToday(due, nextIsraelDay) === -1, `next Israel day reads -1 (${due})`);
}
// Observed Prod: 21.10.2026 vs due 15.09.2026 → 36 days ago; vs 10.09 → 41.
const prodNow = new Date("2026-10-21T09:00:00.000Z");
check(civilDaysFromToday("2026-09-15T00:00:00.000Z", prodNow) === -36, "15.09 is 36 days before 21.10");
check(civilDaysFromToday("2026-09-10T06:00:00.000Z", prodNow) === -41, "10.09 is 41 days before 21.10");
check(civilDaysFromToday("2026-12-29T00:00:00.000Z", prodNow) === 69, "29.12 is 69 days after 21.10");
// Across the end of daylight saving (25.10.2026).
check(civilDaysFromToday("2026-10-26T00:00:00.000Z", new Date("2026-10-24T21:30:00.000Z")) === 1, "DST change does not skip or repeat a day");
check(civilDaysFromToday("not a date") === null, "an invalid date has no distance");

check(relativeDayText(0) === "היום", "0 → היום");
check(relativeDayText(1) === "מחר", "1 → מחר");
check(relativeDayText(-36) === "לפני 36 ימים", "-36 → לפני 36 ימים");
check(relativeDayText(5) === "בעוד 5 ימים", "5 → בעוד 5 ימים");
check(strip(formatShortDate("2026-09-15T00:00:00.000Z")).replace(/\//g, ".") === "15.09.2026", "short date is the Israel day", formatShortDate("2026-09-15T00:00:00.000Z"));
check(countPhrase(1, "תשלום אחד", "תשלומים") === "תשלום אחד", "singular phrase");
check(countPhrase(3, "תשלום אחד", "תשלומים") === "3 תשלומים", "plural phrase");

// ── status vocabulary ───────────────────────────────────────────────────────
for (const state of ALL_PAYABLES_STATES) {
  check(statusLabel({ domain: "payables", state }) === STATE_LABEL[state], `payables ${state} keeps the existing label`);
  check(Boolean(statusTone({ domain: "payables", state })), `payables ${state} has a tone`);
}
for (const state of ALL_SECRETARY_STATUSES) {
  check(Boolean(SECRETARY_STATUS_LABEL[state]), `secretary ${state} has a label`);
}
check(statusTone({ domain: "secretary", state: "MET" }) !== statusTone({ domain: "payables", state: "PAID" }), "handled (טופל) never shares the paid (שולם) tone");
check(statusTone({ domain: "payables", state: "SETTLED_LEGACY" }) !== statusTone({ domain: "payables", state: "PAID" }), "legacy 'סומן כטופל' never looks paid");
check(statusTone({ domain: "payables", state: "OVERDUE" }) === statusTone({ domain: "secretary", state: "OVERDUE" }), "overdue looks the same on both screens");

// ── errors ──────────────────────────────────────────────────────────────────
const FALLBACK = "הפעולה לא הצליחה.";
check(hebrewErrorMessage(new Error('Amount must be a decimal with at most 2 places, got "1,200"'), FALLBACK).startsWith("הסכום"), "known English rule is translated");
check(hebrewErrorMessage(new Error("Something unexpected in the ledger"), FALLBACK) === FALLBACK, "unknown English falls back to Hebrew");
check(hebrewErrorMessage(new Error("פג תוקף ההתחברות. יש להתחבר מחדש."), FALLBACK) === "פג תוקף ההתחברות. יש להתחבר מחדש.", "Hebrew passes through");
check(hebrewErrorMessage(null, FALLBACK) === FALLBACK, "no error object → fallback");
check(!/[A-Za-z]{3,}/.test(hebrewErrorMessage(new Error("This commitment names a saved payee"), FALLBACK)), "no English reaches the owner");

if (failures > 0) {
  console.error(`finance-ui: ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`finance-ui: ${checks} checks passed`);
