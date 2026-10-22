/**
 * Verify — Bank of Israel SDMX CSV parser (lib/fx/boi-parser.ts). Pure: no network, no database.
 * Run: npx tsx lib/fx/boi-parser.test.ts
 *
 * Fixtures (.fxboi/fixtures) are hand-written in the exact format the live endpoint returned on 2026-10-22
 * (same 15 columns, same order, same field values); one is CRLF on purpose.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { addCivilDays, civilDateIn, exactRate, isCivilDate, parseBoiCsv, parseCsv, type BoiParseContext } from "@/lib/fx/boi-parser";

let checks = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  assert.ok(cond, `${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  checks += 1;
  console.log(`  ok ${label}`);
};
const eq = (label: string, got: unknown, want: unknown) => {
  assert.deepEqual(got, want, label);
  checks += 1;
  console.log(`  ok ${label}`);
};

const fx = (name: string) => fs.readFileSync(path.join(process.cwd(), ".fxboi/fixtures", name), "utf8");
const HEADER = "SERIES_CODE,FREQ,BASE_CURRENCY,COUNTER_CURRENCY,UNIT_MEASURE,DATA_TYPE,DATA_SOURCE,TIME_COLLECT,CONF_STATUS,PUB_WEBSITE,UNIT_MULT,COMMENTS,TIME_PERIOD,OBS_VALUE,RELEASE_STATUS";
const row = (o: Partial<Record<string, string>> = {}) => {
  const v = { SERIES_CODE: "RER_USD_ILS", FREQ: "D", BASE_CURRENCY: "USD", COUNTER_CURRENCY: "ILS", UNIT_MEASURE: "ILS", DATA_TYPE: "OF00", DATA_SOURCE: "BOI_MRKT", TIME_COLLECT: "V", CONF_STATUS: "F", PUB_WEBSITE: "Y", UNIT_MULT: "0", COMMENTS: "", TIME_PERIOD: "2026-10-21", OBS_VALUE: "3.091", RELEASE_STATUS: "YP", ...o };
  return HEADER.split(",").map((c) => v[c as keyof typeof v]).join(",");
};
const USD: BoiParseContext = { base: "USD", today: "2026-10-22", startPeriod: "2026-10-13", endPeriod: "2026-10-22" };
const one = (r: string, ctx: BoiParseContext = USD) => parseBoiCsv(`${HEADER}\n${r}\n`, ctx);
const rejectedFor = (label: string, r: ReturnType<typeof parseBoiCsv>, pattern: RegExp) => {
  ok(label, !r.ok && r.rejections.some((x) => pattern.test(x.reason)), r.ok ? "accepted" : r.rejections);
};

console.log("1. recorded-style fixtures");
{
  const r = parseBoiCsv(fx("usd-day1.csv"), USD);
  ok("USD day 1 accepted", r.ok, r.ok ? undefined : r.rejections);
  if (r.ok) {
    eq("8 business days, in date order", r.observations.map((o) => o.rateDate), ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
    eq("exact rate string at scale 10 (3.091 → 3.0910000000)", r.observations[6].rate, "3.0910000000");
    eq("short value kept exact (3.11 → 3.1100000000)", r.observations[4].rate, "3.1100000000");
    eq("series + published value carried for the audit trail", [r.observations[0].seriesCode, r.observations[0].obsValue, r.observations[0].unitMult], ["RER_USD_ILS", "3.074", 0]);
  }
  const e = parseBoiCsv(fx("eur-day1.csv"), { ...USD, base: "EUR" });
  ok("EUR day 1 (CRLF line ends) accepted", e.ok && e.observations.length === 8 && e.observations[7].rate === "3.4816000000", e.ok ? e.observations.length : e.rejections);
  rejectedFor("a USD response is never accepted as EUR", parseBoiCsv(fx("usd-day1.csv"), { ...USD, base: "EUR" }), /SERIES_CODE|BASE_CURRENCY/);
  const bad = parseBoiCsv(fx("usd-bad-datatype.csv"), USD);
  ok("one non-representative row (OF01) rejects the WHOLE response", !bad.ok && bad.rejections.length === 1 && /DATA_TYPE/.test(bad.rejections[0].reason), bad);
  rejectedFor("an unknown column rejects the response", parseBoiCsv(fx("usd-bad-extra-column.csv"), USD), /unknown column "EXTRA"/);
}

console.log("2. header");
rejectedFor("missing column", parseBoiCsv(`${HEADER.replace(",RELEASE_STATUS", "")}\n`, USD), /missing column RELEASE_STATUS/);
rejectedFor("repeated column", parseBoiCsv(`${HEADER},FREQ\n`, USD), /repeated column FREQ/);
rejectedFor("empty body", parseBoiCsv("", USD), /empty response/);
rejectedFor("header only = no observations", parseBoiCsv(`${HEADER}\n`, USD), /no observations/);
rejectedFor("an HTML error page is not a header", parseBoiCsv("<!DOCTYPE html><html><body>error</body></html>", USD), /unknown column/);
{
  const cols = HEADER.split(",");
  const shuffled = [...cols].reverse();
  const r0 = row().split(",");
  const rowShuffled = shuffled.map((c) => r0[cols.indexOf(c)]).join(",");
  const r = parseBoiCsv(`${shuffled.join(",")}\n${rowShuffled}\n`, USD);
  ok("columns are read by name (order-independent)", r.ok && r.observations[0].rate === "3.0910000000", r);
}
ok("a UTF-8 BOM before the header is tolerated", parseBoiCsv(`﻿${HEADER}\n${row()}\n`, USD).ok);

console.log("3. row rules — each fails closed");
rejectedFor("FREQ ≠ D", one(row({ FREQ: "M" })), /FREQ/);
rejectedFor("DATA_TYPE ≠ OF00", one(row({ DATA_TYPE: "OF01" })), /DATA_TYPE/);
rejectedFor("COUNTER ≠ ILS", one(row({ COUNTER_CURRENCY: "USD" })), /COUNTER_CURRENCY/);
rejectedFor("UNIT_MEASURE ≠ ILS", one(row({ UNIT_MEASURE: "USD" })), /UNIT_MEASURE/);
rejectedFor("BASE ≠ requested", one(row({ BASE_CURRENCY: "EUR" })), /BASE_CURRENCY/);
rejectedFor("SERIES_CODE ≠ requested", one(row({ SERIES_CODE: "RER_GBP_ILS" })), /SERIES_CODE/);
rejectedFor("unsupported base in the context", parseBoiCsv(`${HEADER}\n${row()}\n`, { ...USD, base: "GBP" as never }), /unsupported base/);
rejectedFor("float exponent", one(row({ OBS_VALUE: "3.091e0" })), /plain positive decimal/);
rejectedFor("negative", one(row({ OBS_VALUE: "-3.091" })), /plain positive decimal/);
rejectedFor("zero", one(row({ OBS_VALUE: "0" })), /not positive/);
rejectedFor("empty value", one(row({ OBS_VALUE: "" })), /plain positive decimal/);
rejectedFor("comma decimal", one(row({ OBS_VALUE: "3,091" })), /fields|plain positive decimal/);
rejectedFor("more decimals than numeric(20,10) holds", one(row({ OBS_VALUE: "3.09100000001" })), /decimal places/);
rejectedFor("too large for numeric(20,10)", one(row({ OBS_VALUE: "12345678901" })), /numeric\(20,10\)/);
rejectedFor("UNIT_MULT not an integer", one(row({ UNIT_MULT: "x" })), /UNIT_MULT/);
rejectedFor("UNIT_MULT out of range", one(row({ UNIT_MULT: "7" })), /UNIT_MULT/);
rejectedFor("TIME_PERIOD not a date", one(row({ TIME_PERIOD: "2026-02-30" })), /civil date/);
rejectedFor("TIME_PERIOD wrong shape", one(row({ TIME_PERIOD: "21/10/2026" })), /civil date/);
rejectedFor("TIME_PERIOD in the future (Asia/Jerusalem)", one(row({ TIME_PERIOD: "2026-10-23" }), { ...USD, endPeriod: "2026-10-23" }), /future/);
rejectedFor("TIME_PERIOD outside the requested window", one(row({ TIME_PERIOD: "2026-10-01" })), /outside the requested window/);
rejectedFor("the same date twice", parseBoiCsv(`${HEADER}\n${row()}\n${row({ OBS_VALUE: "3.092" })}\n`, USD), /appears twice/);
rejectedFor("a short row", parseBoiCsv(`${HEADER}\nRER_USD_ILS,D,USD\n`, USD), /expected 15 fields/);
ok("a quoted comment with a comma parses (RFC 4180)", one(row({ COMMENTS: '"a, b"' })).ok);
rejectedFor("an unterminated quote", parseBoiCsv(`${HEADER}\n${row({ COMMENTS: '"open' })}\n`, USD), /malformed CSV/);

console.log("4. UNIT_MULT division is exact");
{
  const j = exactRate("1.9794", 2);
  eq("JPY per 100: 1.9794 / 10^2 = 0.0197940000", j.ok ? j.rate : j, "0.0197940000");
  eq("UNIT_MULT 0 unchanged", exactRate("3.107", 0), { ok: true, rate: "3.1070000000" });
  ok("division needing > 10 places refused (no rounding)", !exactRate("1.123456789", 2).ok);
  const csv = fx("jpy-unitmult.csv").replaceAll("JPY", "USD");
  const r = parseBoiCsv(csv, { ...USD, startPeriod: "2026-10-13" });
  ok("parser applies UNIT_MULT=2 from the row", r.ok && r.observations[0].rate === "0.0197940000" && r.observations[0].unitMult === 2, r);
}

console.log("5. dates");
ok("leap day valid", isCivilDate("2028-02-29"));
ok("non-leap 29 Feb invalid", !isCivilDate("2026-02-29"));
eq("addCivilDays across month end", addCivilDays("2026-10-31", 1), "2026-11-01");
eq("window start = today − 9", addCivilDays("2026-10-22", -9), "2026-10-13");
eq("Asia/Jerusalem date at 21:30 UTC is already the next day (IDT)", civilDateIn(new Date("2026-10-21T21:30:00Z")), "2026-10-22");
eq("Asia/Jerusalem date at 21:30 UTC in winter (IST, +2) is still the same day", civilDateIn(new Date("2026-12-21T21:30:00Z")), "2026-12-21");
eq("parseCsv skips blank trailing lines", parseCsv("a,b\r\n1,2\r\n\r\n")?.length, 2);

console.log(`boi-parser: ${checks} checks passed`);
