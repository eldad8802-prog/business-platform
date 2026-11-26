/**
 * Calendar daily use (G7, G8, G10) — pure proofs. Run:
 *   npx tsx lib/services/appointment/calendar-daily-use.test.ts
 *
 *   H. The Israeli holiday table (5787, 5788): every date checked INDEPENDENTLY against the ICU Hebrew calendar (Intl
 *      `u-ca-hebrew`) — Rosh Hashana 1–2 Tishri, Yom Kippur 10 Tishri, Sukkot 15, Hoshana Raba 21, Simchat Torah 22
 *      (Israel), Pesach 15 / 7th day 21 Nisan, Shavuot 6 Sivan, every eve the day before; Yom HaAtzma'ut on 3–5 Iyar
 *      and only Tue/Wed/Thu (the Israeli postponement rule), Yom HaZikaron the day before. Ids resolve only from the
 *      table; defaults are the owner-facing set.
 *   R. Range expansion: inclusive whole days across month / year / DST edges, the 62-day cap, refusals.
 *   P. holidayPlans: holidays all day, eves from the closing time to 24:00, past days dropped, unknown ids refused.
 *   S. Search normalisation: names as typed, phones as canonical digits (0 / 00 / +972 forms), min 2 characters.
 *   D. G10 staff default: tapped lane > last used (if still active) > the only active > ask (never a silent business
 *      lane); storage that throws never breaks the form.
 * No database, no network, no clock.
 */
import { defaultStaffChoice, readLastStaff, rememberLastStaff } from "@/features/calendar/staff-default";


import { expandDayRange, holidayPlans, MAX_CLOSURE_DAYS, normalizeSearchQuery } from "./calendar-daily-core";
import { allHolidayDays, HEBREW_YEARS, HOLIDAY_DATES, HOLIDAYS, holidayGroupRows, idsForRows, resolveHolidayId, upcomingHolidayDays } from "./israeli-holidays";

let failures = 0;
let total = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  [PASS] ${name}`);
  else { failures++; console.log(`  [FAIL] ${name}\n         got      ${a}\n         expected ${e}`); }
}
function ok(name: string, cond: boolean, detail = "") { eq(name + (cond || !detail ? "" : ` (${detail})`), cond, true); }

// ── H. Holidays ─────────────────────────────────────────────────────────────────────────────────
console.log("H. holiday table vs the ICU Hebrew calendar");
const HEB = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const hebrewOf = (dayKey: string) => {
  const parts = HEB.formatToParts(new Date(`${dayKey}T12:00:00Z`));
  return { day: Number(parts.find((p) => p.type === "day")?.value), month: parts.find((p) => p.type === "month")?.value ?? "", year: Number(parts.find((p) => p.type === "year")?.value) };
};
const weekday = (dayKey: string) => new Date(`${dayKey}T12:00:00Z`).getUTCDay();
const plusDays = (dayKey: string, n: number) => new Date(Date.parse(`${dayKey}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

for (const year of HEBREW_YEARS) {
  for (const h of HOLIDAYS) {
    const dayKey = HOLIDAY_DATES[year][h.key];
    const heb = hebrewOf(dayKey);
    if (h.hebrew) {
      // Erev Rosh Hashana (29 Elul) belongs to the year before; everything else to `year`.
      const wantYear = h.key === "EREV_ROSH_HASHANA" ? year - 1 : year;
      eq(`${year} ${h.key} ${dayKey} = ${h.hebrew.day} ${h.hebrew.month} ${wantYear}`, heb, { day: h.hebrew.day, month: h.hebrew.month, year: wantYear });
    }
  }
  const atz = HOLIDAY_DATES[year].YOM_HAATZMAUT;
  const atzHeb = hebrewOf(atz);
  ok(`${year} Yom HaAtzma'ut ${atz} is 3–5 Iyar`, atzHeb.month === "Iyar" && atzHeb.day >= 3 && atzHeb.day <= 6 && atzHeb.year === year, JSON.stringify(atzHeb));
  ok(`${year} Yom HaAtzma'ut falls on Tue/Wed/Thu`, [2, 3, 4].includes(weekday(atz)), String(weekday(atz)));
  eq(`${year} Yom HaZikaron is the day before`, HOLIDAY_DATES[year].YOM_HAZIKARON, plusDays(atz, -1));
  for (const [eve, day] of [["EREV_ROSH_HASHANA", "ROSH_HASHANA_1"], ["EREV_YOM_KIPPUR", "YOM_KIPPUR"], ["EREV_SUKKOT", "SUKKOT_1"], ["HOSHANA_RABA", "SIMCHAT_TORAH"], ["EREV_PESACH", "PESACH_1"], ["EREV_PESACH_7", "PESACH_7"], ["EREV_SHAVUOT", "SHAVUOT"]] as const) {
    eq(`${year} ${eve} is the day before ${day}`, HOLIDAY_DATES[year][eve], plusDays(HOLIDAY_DATES[year][day], -1));
  }
}
// Known anchors (Hebcal, Israel) spelled out, so a wrong table cannot pass by a matching wrong algorithm.
eq("anchor: Rosh Hashana 5787 = 2026-09-12", HOLIDAY_DATES[5787].ROSH_HASHANA_1, "2026-09-12");
eq("anchor: Yom Kippur 5787 = 2026-09-21", HOLIDAY_DATES[5787].YOM_KIPPUR, "2026-09-21");
eq("anchor: Pesach 5787 = 2027-04-22", HOLIDAY_DATES[5787].PESACH_1, "2027-04-22");
eq("anchor: Shavuot 5787 = 2027-06-11", HOLIDAY_DATES[5787].SHAVUOT, "2027-06-11");
eq("anchor: Independence Day 5787 = 2027-05-12", HOLIDAY_DATES[5787].YOM_HAATZMAUT, "2027-05-12");
eq("anchor: Rosh Hashana 5788 = 2027-10-02", HOLIDAY_DATES[5788].ROSH_HASHANA_1, "2027-10-02");
eq("anchor: Yom Kippur 5788 = 2027-10-11", HOLIDAY_DATES[5788].YOM_KIPPUR, "2027-10-11");
eq("anchor: Sukkot 5788 = 2027-10-16", HOLIDAY_DATES[5788].SUKKOT_1, "2027-10-16");
eq("anchor: Pesach 5788 = 2028-04-11", HOLIDAY_DATES[5788].PESACH_1, "2028-04-11");
eq("anchor: Shavuot 5788 = 2028-05-31", HOLIDAY_DATES[5788].SHAVUOT, "2028-05-31");
eq("anchor: Independence Day 5788 = 2028-05-02", HOLIDAY_DATES[5788].YOM_HAATZMAUT, "2028-05-02");

const all = allHolidayDays();
eq("the table: 26 entries × 2 years, in date order", [all.length, all.every((d, i) => i === 0 || all[i - 1].dayKey <= d.dayKey)], [52, true]);
eq("anchor: Chol HaMoed Sukkot 5787 = 2026-09-27…10-01 (Hebcal Sukkot II–VI)", [HOLIDAY_DATES[5787].SUKKOT_CHM_1, HOLIDAY_DATES[5787].SUKKOT_CHM_5], ["2026-09-27", "2026-10-01"]);
eq("anchor: Chol HaMoed Pesach 5788 = 2028-04-12…04-15 (Hebcal Pesach II–V)", [HOLIDAY_DATES[5788].PESACH_CHM_1, HOLIDAY_DATES[5788].PESACH_CHM_4], ["2028-04-12", "2028-04-15"]);
{
  const rows5787 = holidayGroupRows(5787, "2026-09-01");
  eq("the tab: 11 rows for 5787 from Elul", rows5787.length, 11);
  const rh = rows5787.find((r) => r.key === "ROSH_HASHANA")!;
  eq("Rosh Hashana row: both days, its eve", [rh.fromDay, rh.toDay, rh.dayIds, rh.eveId], ["2026-09-12", "2026-09-13", ["5787:ROSH_HASHANA_1", "5787:ROSH_HASHANA_2"], "5787:EREV_ROSH_HASHANA"]);
  eq("defaults: Chol HaMoed and Yom HaZikaron unticked", rows5787.filter((r) => !r.defaultOn).map((r) => r.key), ["SUKKOT_CHM", "PESACH_CHM", "YOM_HAZIKARON"]);
  eq("rows already past are left out (from 2026-11-24: Pesach onward)", holidayGroupRows(5787, "2026-11-24").map((r) => r.key), ["PESACH", "PESACH_CHM", "PESACH_7", "YOM_HAZIKARON", "YOM_HAATZMAUT", "SHAVUOT"]);
  const pick = rows5787.filter((r) => r.key === "YOM_KIPPUR" || r.key === "YOM_HAZIKARON");
  eq("ids with eves kept", idsForRows(pick, true), ["5787:YOM_KIPPUR", "5787:EREV_YOM_KIPPUR", "5787:YOM_HAZIKARON"]);
  eq("ids without eves: the short-day-only row still brings its day", idsForRows(pick, false), ["5787:YOM_KIPPUR", "5787:YOM_HAZIKARON"]);
  ok("every row id resolves on the server", rows5787.every((r) => [...r.dayIds, ...(r.eveId ? [r.eveId] : [])].every((id) => resolveHolidayId(id) !== null)));
}
eq("default ON: the owner's set (no Yom HaZikaron by default)",
  HOLIDAYS.filter((h) => h.defaultOn && !h.eve).map((h) => h.key),
  ["ROSH_HASHANA_1", "ROSH_HASHANA_2", "YOM_KIPPUR", "SUKKOT_1", "SIMCHAT_TORAH", "PESACH_1", "PESACH_7", "YOM_HAATZMAUT", "SHAVUOT"]);
eq("upcoming from 2026-11-24 starts at Erev Pesach 5787", upcomingHolidayDays("2026-11-24")[0]?.id, "5787:EREV_PESACH");
eq("an id resolves from the table", resolveHolidayId("5788:SHAVUOT")?.dayKey, "2028-05-31");
eq("unknown / foreign ids do not resolve", ["5789:SHAVUOT", "5787:PURIM", "5787:shavuot", "x", 5787, null, "5787:SHAVUOT;drop"].map(resolveHolidayId), [null, null, null, null, null, null, null]);

// ── R. Range expansion ─────────────────────────────────────────────────────────────────────────
console.log("R. range expansion");
eq("one day", expandDayRange("2026-12-01", "2026-12-01"), ["2026-12-01"]);
eq("across a month and a year", expandDayRange("2026-12-30", "2027-01-02"), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
eq("across the spring DST change (2027-03-26)", expandDayRange("2027-03-25", "2027-03-27"), ["2027-03-25", "2027-03-26", "2027-03-27"]);
eq("a leap day", expandDayRange("2028-02-28", "2028-03-01"), ["2028-02-28", "2028-02-29", "2028-03-01"]);
eq("exactly 62 days is allowed", expandDayRange("2027-01-01", "2027-03-03")?.length, MAX_CLOSURE_DAYS);
eq("63 days is refused", expandDayRange("2027-01-01", "2027-03-04"), null);
eq("reversed / malformed is refused", [expandDayRange("2027-01-02", "2027-01-01"), expandDayRange("2027-1-1", "2027-01-02"), expandDayRange(null, "2027-01-02"), expandDayRange("2027-02-30", "2027-03-01")], [null, null, null, null]);

// ── P. Holiday plans ───────────────────────────────────────────────────────────────────────────
console.log("P. holiday plans");
const plans = holidayPlans(["5787:PESACH_1", "5787:EREV_PESACH", "5787:PESACH_1"], 780, "2026-11-24");
eq("holiday all day, eve closed 13:00–24:00, duplicates once, in date order", plans.map((p) => [p.dayKey, p.startMinute, p.endMinute]),
  [["2027-04-21", 780, 1440], ["2027-04-22", null, null]]);
eq("the label is the holiday's Hebrew name", plans[1].label, "פסח (החג הראשון)");
eq("past days are dropped", holidayPlans(["5787:YOM_KIPPUR", "5788:YOM_KIPPUR"], 780, "2026-11-24").map((p) => p.dayKey), ["2027-10-11"]);
const refused = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
ok("unknown id / empty / bad closing minute are refused", [
  refused(() => holidayPlans(["5787:XMAS"], 780, "2026-11-24")),
  refused(() => holidayPlans([], 780, "2026-11-24")),
  refused(() => holidayPlans("5787:SHAVUOT", 780, "2026-11-24")),
  refused(() => holidayPlans(["5787:SHAVUOT"], 1440, "2026-11-24")),
  refused(() => holidayPlans(["5787:SHAVUOT"], 12.5, "2026-11-24")),
].every(Boolean));

// ── S. Search normalisation ────────────────────────────────────────────────────────────────────
console.log("S. search normalisation");
eq("a name, trimmed, spaces collapsed", normalizeSearchQuery("  דנה   כהן "), { text: "דנה כהן", digits: null });
eq("a local phone → canonical digits without the 0", normalizeSearchQuery("050-123 4567")?.digits, "501234567");
eq("+972 form", normalizeSearchQuery("+972 50 123 4567")?.digits, "972501234567");
eq("00972 form", normalizeSearchQuery("00972501234567")?.digits, "972501234567");
eq("two digits are enough", normalizeSearchQuery("45")?.digits, "45");
eq("too short / too long / not text → null", [normalizeSearchQuery("ד"), normalizeSearchQuery(" "), normalizeSearchQuery("x".repeat(61)), normalizeSearchQuery(undefined), normalizeSearchQuery("05")], [null, null, null, null, null]);
eq("letters with digits search by name only", normalizeSearchQuery("דנה 2"), { text: "דנה 2", digits: null });

// ── D. Staff default ───────────────────────────────────────────────────────────────────────────
console.log("D. G10 staff default");
eq("tapped staff lane wins", defaultStaffChoice({ tapped: 7, lastUsed: 3, activeStaffIds: [3, 7] }), { staffId: 7, pending: false, source: "tapped" });
eq("tapped business lane is explicit and kept", defaultStaffChoice({ tapped: null, lastUsed: 3, activeStaffIds: [3, 7] }), { staffId: null, pending: false, source: "tapped" });
eq("a tapped lane of an inactive member falls through", defaultStaffChoice({ tapped: 9, lastUsed: 3, activeStaffIds: [3, 7] }).source, "last");
eq("last used, still active", defaultStaffChoice({ tapped: undefined, lastUsed: 3, activeStaffIds: [3, 7] }), { staffId: 3, pending: false, source: "last" });
eq("last used no longer active → ask (two staff)", defaultStaffChoice({ tapped: undefined, lastUsed: 4, activeStaffIds: [3, 7] }), { staffId: null, pending: true, source: "ask" });
eq("the only active member", defaultStaffChoice({ tapped: undefined, lastUsed: null, activeStaffIds: [5] }), { staffId: 5, pending: false, source: "only" });
eq("no staff → the business lane, nothing to ask", defaultStaffChoice({ tapped: undefined, lastUsed: null, activeStaffIds: [] }), { staffId: null, pending: false, source: "none" });
eq("two or more → ask, never a silent business lane", defaultStaffChoice({ tapped: undefined, lastUsed: null, activeStaffIds: [1, 2] }), { staffId: null, pending: true, source: "ask" });
{
  const g = globalThis as unknown as { window?: unknown };
  g.window = { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } };
  ok("storage that throws: read → null, write → no throw", readLastStaff() === null && !refused(() => rememberLastStaff(4)));
  const store = new Map<string, string>();
  g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } };
  rememberLastStaff(null);
  ok("the business lane is not remembered", readLastStaff() === null);
  rememberLastStaff(12);
  ok("a staff lane is remembered", readLastStaff() === 12);
  store.set("dubiz.calendar.lastStaffId", "abc");
  ok("garbage in storage reads as nothing", readLastStaff() === null);
  delete g.window;
}

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
