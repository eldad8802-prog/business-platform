/**
 * Israeli holidays and their eves — a static, code-level table for the Hebrew years 5787 (Sept 2026 – Sept 2027) and
 * 5788 (Oct 2027 – Sept 2028), used by the "סגירה בחגים" helper of the special-days screen (G7). PURE: no I/O, safe on
 * the server and in the browser.
 *
 * SOURCE (authoritative, fetched 2026-11-24): Hebcal Jewish calendar REST API, Israel schedule —
 *   https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&mod=on&i=on&start=2026-09-01&end=2028-10-31
 * (i=on = Israel: one-day festivals, Shmini Atzeret and Simchat Torah on the same day, Yom HaAtzma'ut / Yom HaZikaron
 * with the Israeli postponement rules applied). Every date below is copied from that answer. The pure test
 * (israeli-holidays.test.ts) cross-checks each date independently against the ICU Hebrew calendar (Intl, `u-ca-hebrew`):
 * the Hebrew day and month of every entry, and the weekday rule of Yom HaAtzma'ut (Tue/Wed/Thu only).
 *
 * Dates are Israeli calendar days (YYYY-MM-DD). An "eve" (ערב חג) is a day the owner may shorten — never closed by
 * default; a holiday is a day the owner may close. The server never trusts dates from the browser: it takes holiday
 * ids ("5787:YOM_KIPPUR") and looks the date up here.
 */

export type HebrewYear = 5787 | 5788;
export const HEBREW_YEARS: readonly HebrewYear[] = [5787, 5788];

export type HolidayKey =
  | "EREV_ROSH_HASHANA"
  | "ROSH_HASHANA_1"
  | "ROSH_HASHANA_2"
  | "EREV_YOM_KIPPUR"
  | "YOM_KIPPUR"
  | "EREV_SUKKOT"
  | "SUKKOT_1"
  | "SUKKOT_CHM_1"
  | "SUKKOT_CHM_2"
  | "SUKKOT_CHM_3"
  | "SUKKOT_CHM_4"
  | "SUKKOT_CHM_5"
  | "HOSHANA_RABA"
  | "SIMCHAT_TORAH"
  | "EREV_PESACH"
  | "PESACH_1"
  | "PESACH_CHM_1"
  | "PESACH_CHM_2"
  | "PESACH_CHM_3"
  | "PESACH_CHM_4"
  | "EREV_PESACH_7"
  | "PESACH_7"
  | "YOM_HAZIKARON"
  | "YOM_HAATZMAUT"
  | "EREV_SHAVUOT"
  | "SHAVUOT";

export type HolidayDef = {
  key: HolidayKey;
  /** Hebrew name, as the owner reads it. */
  name: string;
  /** An eve: offered as a shorter day (closing early), not a closed day. */
  eve: boolean;
  /** Ticked when the helper opens. */
  defaultOn: boolean;
  /** The Hebrew calendar day it falls on (the cross-check); Yom HaAtzma'ut / HaZikaron move — see the test. */
  hebrew: { month: string; day: number } | null;
};

/** In calendar order. */
export const HOLIDAYS: readonly HolidayDef[] = [
  { key: "EREV_ROSH_HASHANA", name: "ערב ראש השנה", eve: true, defaultOn: true, hebrew: { month: "Elul", day: 29 } },
  { key: "ROSH_HASHANA_1", name: "ראש השנה (יום א׳)", eve: false, defaultOn: true, hebrew: { month: "Tishri", day: 1 } },
  { key: "ROSH_HASHANA_2", name: "ראש השנה (יום ב׳)", eve: false, defaultOn: true, hebrew: { month: "Tishri", day: 2 } },
  { key: "EREV_YOM_KIPPUR", name: "ערב יום כיפור", eve: true, defaultOn: true, hebrew: { month: "Tishri", day: 9 } },
  { key: "YOM_KIPPUR", name: "יום כיפור", eve: false, defaultOn: true, hebrew: { month: "Tishri", day: 10 } },
  { key: "EREV_SUKKOT", name: "ערב סוכות", eve: true, defaultOn: true, hebrew: { month: "Tishri", day: 14 } },
  { key: "SUKKOT_1", name: "סוכות (החג הראשון)", eve: false, defaultOn: true, hebrew: { month: "Tishri", day: 15 } },
  { key: "SUKKOT_CHM_1", name: "חול המועד סוכות", eve: false, defaultOn: false, hebrew: { month: "Tishri", day: 16 } },
  { key: "SUKKOT_CHM_2", name: "חול המועד סוכות", eve: false, defaultOn: false, hebrew: { month: "Tishri", day: 17 } },
  { key: "SUKKOT_CHM_3", name: "חול המועד סוכות", eve: false, defaultOn: false, hebrew: { month: "Tishri", day: 18 } },
  { key: "SUKKOT_CHM_4", name: "חול המועד סוכות", eve: false, defaultOn: false, hebrew: { month: "Tishri", day: 19 } },
  { key: "SUKKOT_CHM_5", name: "חול המועד סוכות", eve: false, defaultOn: false, hebrew: { month: "Tishri", day: 20 } },
  { key: "HOSHANA_RABA", name: "הושענא רבה (ערב שמחת תורה)", eve: true, defaultOn: true, hebrew: { month: "Tishri", day: 21 } },
  { key: "SIMCHAT_TORAH", name: "שמיני עצרת / שמחת תורה", eve: false, defaultOn: true, hebrew: { month: "Tishri", day: 22 } },
  { key: "EREV_PESACH", name: "ערב פסח", eve: true, defaultOn: true, hebrew: { month: "Nisan", day: 14 } },
  { key: "PESACH_1", name: "פסח (החג הראשון)", eve: false, defaultOn: true, hebrew: { month: "Nisan", day: 15 } },
  { key: "PESACH_CHM_1", name: "חול המועד פסח", eve: false, defaultOn: false, hebrew: { month: "Nisan", day: 16 } },
  { key: "PESACH_CHM_2", name: "חול המועד פסח", eve: false, defaultOn: false, hebrew: { month: "Nisan", day: 17 } },
  { key: "PESACH_CHM_3", name: "חול המועד פסח", eve: false, defaultOn: false, hebrew: { month: "Nisan", day: 18 } },
  { key: "PESACH_CHM_4", name: "חול המועד פסח", eve: false, defaultOn: false, hebrew: { month: "Nisan", day: 19 } },
  { key: "EREV_PESACH_7", name: "ערב שביעי של פסח", eve: true, defaultOn: true, hebrew: { month: "Nisan", day: 20 } },
  { key: "PESACH_7", name: "שביעי של פסח", eve: false, defaultOn: true, hebrew: { month: "Nisan", day: 21 } },
  { key: "YOM_HAZIKARON", name: "יום הזיכרון (ערב יום העצמאות)", eve: true, defaultOn: false, hebrew: null },
  { key: "YOM_HAATZMAUT", name: "יום העצמאות", eve: false, defaultOn: true, hebrew: null },
  { key: "EREV_SHAVUOT", name: "ערב שבועות", eve: true, defaultOn: true, hebrew: { month: "Sivan", day: 5 } },
  { key: "SHAVUOT", name: "שבועות", eve: false, defaultOn: true, hebrew: { month: "Sivan", day: 6 } },
];

/** Hebcal (Israel) dates — see SOURCE above. */
export const HOLIDAY_DATES: Readonly<Record<HebrewYear, Readonly<Record<HolidayKey, string>>>> = {
  5787: {
    EREV_ROSH_HASHANA: "2026-09-11",
    ROSH_HASHANA_1: "2026-09-12",
    ROSH_HASHANA_2: "2026-09-13",
    EREV_YOM_KIPPUR: "2026-09-20",
    YOM_KIPPUR: "2026-09-21",
    EREV_SUKKOT: "2026-09-25",
    SUKKOT_1: "2026-09-26",
    SUKKOT_CHM_1: "2026-09-27",
    SUKKOT_CHM_2: "2026-09-28",
    SUKKOT_CHM_3: "2026-09-29",
    SUKKOT_CHM_4: "2026-09-30",
    SUKKOT_CHM_5: "2026-10-01",
    HOSHANA_RABA: "2026-10-02",
    SIMCHAT_TORAH: "2026-10-03",
    EREV_PESACH: "2027-04-21",
    PESACH_1: "2027-04-22",
    PESACH_CHM_1: "2027-04-23",
    PESACH_CHM_2: "2027-04-24",
    PESACH_CHM_3: "2027-04-25",
    PESACH_CHM_4: "2027-04-26",
    EREV_PESACH_7: "2027-04-27",
    PESACH_7: "2027-04-28",
    YOM_HAZIKARON: "2027-05-11",
    YOM_HAATZMAUT: "2027-05-12",
    EREV_SHAVUOT: "2027-06-10",
    SHAVUOT: "2027-06-11",
  },
  5788: {
    EREV_ROSH_HASHANA: "2027-10-01",
    ROSH_HASHANA_1: "2027-10-02",
    ROSH_HASHANA_2: "2027-10-03",
    EREV_YOM_KIPPUR: "2027-10-10",
    YOM_KIPPUR: "2027-10-11",
    EREV_SUKKOT: "2027-10-15",
    SUKKOT_1: "2027-10-16",
    SUKKOT_CHM_1: "2027-10-17",
    SUKKOT_CHM_2: "2027-10-18",
    SUKKOT_CHM_3: "2027-10-19",
    SUKKOT_CHM_4: "2027-10-20",
    SUKKOT_CHM_5: "2027-10-21",
    HOSHANA_RABA: "2027-10-22",
    SIMCHAT_TORAH: "2027-10-23",
    EREV_PESACH: "2028-04-10",
    PESACH_1: "2028-04-11",
    PESACH_CHM_1: "2028-04-12",
    PESACH_CHM_2: "2028-04-13",
    PESACH_CHM_3: "2028-04-14",
    PESACH_CHM_4: "2028-04-15",
    EREV_PESACH_7: "2028-04-16",
    PESACH_7: "2028-04-17",
    YOM_HAZIKARON: "2028-05-01",
    YOM_HAATZMAUT: "2028-05-02",
    EREV_SHAVUOT: "2028-05-30",
    SHAVUOT: "2028-05-31",
  },
};

/** "5787:YOM_KIPPUR" — what the browser sends and the server looks up. */
export type HolidayId = `${HebrewYear}:${HolidayKey}`;

export type HolidayDay = { id: HolidayId; year: HebrewYear; key: HolidayKey; name: string; eve: boolean; defaultOn: boolean; dayKey: string };

const DEFS = new Map(HOLIDAYS.map((h) => [h.key, h]));

/** Every holiday and eve of the table, in date order. */
export function allHolidayDays(): HolidayDay[] {
  const out: HolidayDay[] = [];
  for (const year of HEBREW_YEARS) {
    for (const h of HOLIDAYS) {
      out.push({ id: `${year}:${h.key}`, year, key: h.key, name: h.name, eve: h.eve, defaultOn: h.defaultOn, dayKey: HOLIDAY_DATES[year][h.key] });
    }
  }
  return out.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

/** The holidays still ahead (on or after `fromDay`), in date order. */
export function upcomingHolidayDays(fromDay: string): HolidayDay[] {
  return allHolidayDays().filter((d) => d.dayKey >= fromDay);
}

/** A holiday id → its day, or null when the id is not in the table (the server refuses it). */
export function resolveHolidayId(id: unknown): HolidayDay | null {
  if (typeof id !== "string") return null;
  const m = /^(\d{4}):([A-Z0-9_]{1,40})$/.exec(id);
  if (!m) return null;
  const year = Number(m[1]) as HebrewYear;
  if (!HEBREW_YEARS.includes(year)) return null;
  const def = DEFS.get(m[2] as HolidayKey);
  if (!def) return null;
  return { id: `${year}:${def.key}`, year, key: def.key, name: def.name, eve: def.eve, defaultOn: def.defaultOn, dayKey: HOLIDAY_DATES[year][def.key] };
}

/**
 * How the "חגים" tab shows the table (design proposal e, owner-approved): one row per holiday — its closed day(s) and,
 * when the owner keeps "ערבי חג — יום קצר", its eve as a short day. Yom HaZikaron is its own short-day row (unticked);
 * Chol HaMoed are offered as whole rows, unticked.
 */
export type HolidayGroupKey =
  | "ROSH_HASHANA" | "YOM_KIPPUR" | "SUKKOT" | "SUKKOT_CHM" | "SIMCHAT_TORAH"
  | "PESACH" | "PESACH_CHM" | "PESACH_7" | "YOM_HAZIKARON" | "YOM_HAATZMAUT" | "SHAVUOT";

export type HolidayGroupDef = { key: HolidayGroupKey; name: string; days: HolidayKey[]; eve: HolidayKey | null; defaultOn: boolean };

export const HOLIDAY_GROUPS: readonly HolidayGroupDef[] = [
  { key: "ROSH_HASHANA", name: "ראש השנה", days: ["ROSH_HASHANA_1", "ROSH_HASHANA_2"], eve: "EREV_ROSH_HASHANA", defaultOn: true },
  { key: "YOM_KIPPUR", name: "יום כיפור", days: ["YOM_KIPPUR"], eve: "EREV_YOM_KIPPUR", defaultOn: true },
  { key: "SUKKOT", name: "סוכות (חג ראשון)", days: ["SUKKOT_1"], eve: "EREV_SUKKOT", defaultOn: true },
  { key: "SUKKOT_CHM", name: "חול המועד סוכות", days: ["SUKKOT_CHM_1", "SUKKOT_CHM_2", "SUKKOT_CHM_3", "SUKKOT_CHM_4", "SUKKOT_CHM_5"], eve: null, defaultOn: false },
  { key: "SIMCHAT_TORAH", name: "שמיני עצרת / שמחת תורה", days: ["SIMCHAT_TORAH"], eve: "HOSHANA_RABA", defaultOn: true },
  { key: "PESACH", name: "פסח (חג ראשון)", days: ["PESACH_1"], eve: "EREV_PESACH", defaultOn: true },
  { key: "PESACH_CHM", name: "חול המועד פסח", days: ["PESACH_CHM_1", "PESACH_CHM_2", "PESACH_CHM_3", "PESACH_CHM_4"], eve: null, defaultOn: false },
  { key: "PESACH_7", name: "שביעי של פסח", days: ["PESACH_7"], eve: "EREV_PESACH_7", defaultOn: true },
  { key: "YOM_HAZIKARON", name: "יום הזיכרון (יום קצר)", days: [], eve: "YOM_HAZIKARON", defaultOn: false },
  { key: "YOM_HAATZMAUT", name: "יום העצמאות", days: ["YOM_HAATZMAUT"], eve: null, defaultOn: true },
  { key: "SHAVUOT", name: "שבועות", days: ["SHAVUOT"], eve: "EREV_SHAVUOT", defaultOn: true },
];

export type HolidayGroupRow = { id: string; year: HebrewYear; key: HolidayGroupKey; name: string; defaultOn: boolean; fromDay: string; toDay: string; dayIds: HolidayId[]; eveId: HolidayId | null };

/** The rows of one Hebrew year still ahead on `fromDay` (a row whose closed days have all passed is left out). */
export function holidayGroupRows(year: HebrewYear, fromDay: string): HolidayGroupRow[] {
  return HOLIDAY_GROUPS.map((g) => {
    const days = g.days.map((k) => HOLIDAY_DATES[year][k]);
    const all = [...days, ...(g.eve ? [HOLIDAY_DATES[year][g.eve]] : [])].sort();
    return {
      id: `${year}:${g.key}`, year, key: g.key, name: g.name, defaultOn: g.defaultOn,
      fromDay: (days[0] ?? all[0]), toDay: (days[days.length - 1] ?? all[all.length - 1]),
      dayIds: g.days.map((k) => `${year}:${k}` as HolidayId),
      eveId: g.eve ? (`${year}:${g.eve}` as HolidayId) : null,
      _last: all[all.length - 1],
    };
  }).filter((r) => r._last >= fromDay).map(({ _last, ...r }) => { void _last; return r; });
}

/**
 * The ids a selection of rows means: each row's closed days, plus its eve as a short day when eves are kept
 * (`eves` true). A short-day-only row (Yom HaZikaron) always brings its own day. Past days are dropped by the server.
 */
export function idsForRows(rows: HolidayGroupRow[], eves: boolean): HolidayId[] {
  const out: HolidayId[] = [];
  for (const r of rows) {
    out.push(...r.dayIds);
    if (r.eveId && (eves || r.dayIds.length === 0)) out.push(r.eveId);
  }
  return [...new Set(out)];
}
