/**
 * Bank of Israel representative rates (שערים יציגים) — the SDMX CSV parser. Pure: no I/O, no clock of its
 * own (the caller passes "today" in Asia/Jerusalem), no floating point.
 *
 * Every rule fails CLOSED (docs/i18n-multicurrency/FX-SOURCE-RECOMMENDATION.md §2): a response with an
 * unexpected header, or ANY row that breaks a rule, is rejected as a whole — nothing of it is returned for
 * storage. There is no "best effort": the run reports the rejection and the next run back-fills.
 *
 *   header      exactly the documented column set (any order); an unknown, missing or repeated column → reject
 *   SERIES_CODE the series that was requested (RER_USD_ILS / RER_EUR_ILS)
 *   FREQ        D
 *   BASE        the requested base, ∈ {USD, EUR}
 *   COUNTER     ILS (and UNIT_MEASURE ILS)
 *   DATA_TYPE   OF00 (= representative rate)
 *   UNIT_MULT   an integer 0..6; OBS_VALUE is divided by 10^UNIT_MULT exactly (JPY is published per 100)
 *   OBS_VALUE   a plain positive decimal string (no sign, no exponent), exact at numeric(20,10)
 *   TIME_PERIOD a valid civil date YYYY-MM-DD, ≤ today (Asia/Jerusalem), inside the requested window,
 *               at most once per response
 */
import { formatScaled, parseScaled } from "@/lib/money/decimal";
import { RATE_SCALE } from "@/lib/money/fx";

export type BoiBase = "USD" | "EUR";
export const BOI_BASES: readonly BoiBase[] = ["USD", "EUR"];

export function boiSeriesCode(base: BoiBase): string {
  return `RER_${base}_ILS`;
}

/** The documented response columns (probed 2026-10-22; see FX-SOURCE-RECOMMENDATION.md §2). */
export const BOI_COLUMNS = [
  "SERIES_CODE",
  "FREQ",
  "BASE_CURRENCY",
  "COUNTER_CURRENCY",
  "UNIT_MEASURE",
  "DATA_TYPE",
  "DATA_SOURCE",
  "TIME_COLLECT",
  "CONF_STATUS",
  "PUB_WEBSITE",
  "UNIT_MULT",
  "COMMENTS",
  "TIME_PERIOD",
  "OBS_VALUE",
  "RELEASE_STATUS",
] as const;

/** numeric(20,10): at most 10 digits before the point. */
const MAX_WHOLE_DIGITS = 20 - RATE_SCALE;
const MAX_UNIT_MULT = 6;

export type BoiObservation = {
  readonly base: BoiBase;
  readonly quote: "ILS";
  /** ILS for ONE unit of base, exactly RATE_SCALE decimal places (UNIT_MULT already applied). */
  readonly rate: string;
  /** YYYY-MM-DD as published (TIME_PERIOD). */
  readonly rateDate: string;
  /** The published value and multiplier, for the audit trail. */
  readonly obsValue: string;
  readonly unitMult: number;
  readonly seriesCode: string;
};

export type BoiRejection = { readonly line: number | null; readonly reason: string };

export type BoiParseResult =
  | { readonly ok: true; readonly observations: readonly BoiObservation[] }
  | { readonly ok: false; readonly rejections: readonly BoiRejection[] };

export type BoiParseContext = {
  readonly base: BoiBase;
  /** Today in Asia/Jerusalem, YYYY-MM-DD. */
  readonly today: string;
  /** The requested window (inclusive), YYYY-MM-DD. */
  readonly startPeriod: string;
  readonly endPeriod: string;
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OBS_RE = /^\d+(?:\.\d+)?$/;

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30, 2026-13-01, …). */
export function isCivilDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Today's civil date in a time zone (default Asia/Jerusalem), YYYY-MM-DD. */
export function civilDateIn(now: Date, timeZone = "Asia/Jerusalem"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** date ± days, on civil dates (UTC arithmetic, no DST involved). */
export function addCivilDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`not a civil date: ${date}`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * RFC 4180 CSV → rows of fields. Quoted fields (with "" escapes, commas and line breaks inside) are
 * supported; an unterminated quote or a stray quote inside an unquoted field is an error (null).
 * Returns each row with the 1-based line it started on.
 */
export function parseCsv(text: string): { line: number; fields: string[] }[] | null {
  const rows: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const endField = () => {
    fields.push(field);
    field = "";
    quotedField = false;
  };
  const endRow = () => {
    endField();
    // A completely empty line (one empty unquoted field) is skipped — trailing newline etc.
    if (!(fields.length === 1 && fields[0] === "")) rows.push({ line: rowLine, fields });
    fields = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        const n = text[i];
        if (n !== undefined && n !== "," && n !== "\r" && n !== "\n") return null; // text after a closing quote
        continue;
      }
      if (c === "\n") line += 1;
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      if (field.length > 0 || quotedField) return null; // a quote in the middle of an unquoted field
      inQuotes = true;
      quotedField = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      line += 1;
      rowLine = line;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) return null;
  if (field.length > 0 || fields.length > 0 || quotedField) endRow();
  return rows;
}

/** OBS_VALUE / 10^unitMult as an exact RATE_SCALE decimal string, or a reason it cannot be. */
export function exactRate(obsValue: string, unitMult: number): { ok: true; rate: string } | { ok: false; reason: string } {
  if (!OBS_RE.test(obsValue)) return { ok: false, reason: "OBS_VALUE is not a plain positive decimal" };
  let scaled: bigint;
  try {
    // value / 10^unitMult at RATE_SCALE places = value × 10^(RATE_SCALE − unitMult): parsing at
    // RATE_SCALE − unitMult places and reading the integer at RATE_SCALE divides exactly; a value with more
    // places than that cannot be stored exactly and is refused (no rounding).
    scaled = parseScaled(obsValue, RATE_SCALE - unitMult);
  } catch {
    return { ok: false, reason: `OBS_VALUE has more than ${RATE_SCALE - unitMult} decimal places (UNIT_MULT ${unitMult})` };
  }
  if (scaled <= BigInt(0)) return { ok: false, reason: "OBS_VALUE is not positive" };
  const rate = formatScaled(scaled, RATE_SCALE);
  if (rate.split(".")[0].length > MAX_WHOLE_DIGITS) return { ok: false, reason: "OBS_VALUE does not fit numeric(20,10)" };
  return { ok: true, rate };
}

export function parseBoiCsv(text: string, ctx: BoiParseContext): BoiParseResult {
  const rejections: BoiRejection[] = [];
  const reject = (line: number | null, reason: string): BoiParseResult => ({ ok: false, rejections: [...rejections, { line, reason }] });

  if (!BOI_BASES.includes(ctx.base)) return reject(null, `unsupported base ${String(ctx.base)}`);
  if (!isCivilDate(ctx.today) || !isCivilDate(ctx.startPeriod) || !isCivilDate(ctx.endPeriod)) return reject(null, "invalid parse context dates");

  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const rows = parseCsv(body);
  if (!rows) return reject(null, "malformed CSV (quoting)");
  if (rows.length === 0) return reject(null, "empty response");

  const header = rows[0].fields.map((h) => h.trim());
  const expected = new Set<string>(BOI_COLUMNS);
  const seen = new Set<string>();
  for (const h of header) {
    if (!expected.has(h)) return reject(rows[0].line, `unknown column ${JSON.stringify(h)}`);
    if (seen.has(h)) return reject(rows[0].line, `repeated column ${h}`);
    seen.add(h);
  }
  for (const c of BOI_COLUMNS) if (!seen.has(c)) return reject(rows[0].line, `missing column ${c}`);
  const col = new Map(header.map((h, i) => [h, i]));
  const get = (fields: string[], c: (typeof BOI_COLUMNS)[number]) => fields[col.get(c)!];

  const series = boiSeriesCode(ctx.base);
  const observations: BoiObservation[] = [];
  const dates = new Set<string>();
  for (const { line, fields } of rows.slice(1)) {
    if (fields.length !== header.length) {
      rejections.push({ line, reason: `expected ${header.length} fields, got ${fields.length}` });
      continue;
    }
    const v = (c: (typeof BOI_COLUMNS)[number]) => get(fields, c);
    const problems: string[] = [];
    if (v("SERIES_CODE") !== series) problems.push(`SERIES_CODE ${JSON.stringify(v("SERIES_CODE"))} ≠ ${series}`);
    if (v("FREQ") !== "D") problems.push(`FREQ ${JSON.stringify(v("FREQ"))} ≠ D`);
    if (v("BASE_CURRENCY") !== ctx.base) problems.push(`BASE_CURRENCY ${JSON.stringify(v("BASE_CURRENCY"))} ≠ ${ctx.base}`);
    if (v("COUNTER_CURRENCY") !== "ILS") problems.push(`COUNTER_CURRENCY ${JSON.stringify(v("COUNTER_CURRENCY"))} ≠ ILS`);
    if (v("UNIT_MEASURE") !== "ILS") problems.push(`UNIT_MEASURE ${JSON.stringify(v("UNIT_MEASURE"))} ≠ ILS`);
    if (v("DATA_TYPE") !== "OF00") problems.push(`DATA_TYPE ${JSON.stringify(v("DATA_TYPE"))} ≠ OF00`);
    const multText = v("UNIT_MULT");
    const unitMult = /^\d$/.test(multText) ? Number(multText) : Number.NaN;
    if (!(unitMult >= 0 && unitMult <= MAX_UNIT_MULT)) problems.push(`UNIT_MULT ${JSON.stringify(multText)} is not an integer 0..${MAX_UNIT_MULT}`);
    const date = v("TIME_PERIOD");
    if (!isCivilDate(date)) problems.push(`TIME_PERIOD ${JSON.stringify(date)} is not a civil date`);
    else {
      if (date > ctx.today) problems.push(`TIME_PERIOD ${date} is in the future (today ${ctx.today} Asia/Jerusalem)`);
      if (date < ctx.startPeriod || date > ctx.endPeriod) problems.push(`TIME_PERIOD ${date} is outside the requested window`);
      if (dates.has(date)) problems.push(`TIME_PERIOD ${date} appears twice`);
    }
    const obsValue = v("OBS_VALUE");
    const exact = Number.isNaN(unitMult) ? null : exactRate(obsValue, unitMult);
    if (exact && !exact.ok) problems.push(exact.reason);
    if (problems.length > 0 || !exact || !exact.ok) {
      rejections.push({ line, reason: problems.join("; ") || "invalid row" });
      continue;
    }
    dates.add(date);
    observations.push({ base: ctx.base, quote: "ILS", rate: exact.rate, rateDate: date, obsValue, unitMult, seriesCode: series });
  }
  if (rejections.length > 0) return { ok: false, rejections };
  if (observations.length === 0) return reject(null, "no observations");
  observations.sort((a, b) => (a.rateDate < b.rateDate ? -1 : a.rateDate > b.rateDate ? 1 : 0));
  return { ok: true, observations };
}
