/**
 * ר1 / S08 — quote validity selection (pure: no DB, no network, no clock).
 * Run: npx tsx lib/services/business-documents/quote-followup/quote-validity-core.test.ts
 */
import { QUOTE_VALIDITY_WINDOW_DAYS, selectQuoteValidityItems, validDayOf, windowEndInstant, type QuoteValidityRow } from "./quote-validity.core";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

const today = "2026-11-05";
const at = (iso: string) => new Date(iso);
const row = (over: Partial<QuoteValidityRow>): QuoteValidityRow => ({
  id: 1,
  validUntil: at("2026-11-06T21:00:00.000Z"), // 7.11 in Israel? no: 21:00Z on 6.11 = 23:00 Israel → day 6.11
  convertedToInvoiceId: null,
  documentNumberFormatted: "000004",
  customerNameSnapshot: "דנה",
  updatedAt: at("2026-11-01T10:00:00.000Z"),
  ...over,
});

ok("window is 3 days (spec S08)", QUOTE_VALIDITY_WINDOW_DAYS === 3);
ok("valid day in Israel time (21:30Z on 6.11 is 7.11 in Israel, winter +2)", validDayOf(at("2026-11-06T22:30:00.000Z")) === "2026-11-07", validDayOf(at("2026-11-06T22:30:00.000Z")));

const items = selectQuoteValidityItems(
  [
    row({ id: 1, validUntil: at("2026-11-05T10:00:00.000Z") }), // today → 0 days left
    row({ id: 2, validUntil: at("2026-11-08T10:00:00.000Z") }), // +3 → in
    row({ id: 3, validUntil: at("2026-11-09T10:00:00.000Z") }), // +4 → out
    row({ id: 4, validUntil: at("2026-10-20T10:00:00.000Z") }), // expired → in
    row({ id: 5, validUntil: null }), // no date → out
    row({ id: 6, validUntil: at("2026-11-06T10:00:00.000Z"), convertedToInvoiceId: 99 }), // converted → out
    row({ id: 7, validUntil: at("2026-11-06T10:00:00.000Z") }), // service-owned → out
  ],
  new Set([7]),
  today
);
const ids = items.map((i) => i.id);
ok("today and +3 days are in; +4 is out", ids.includes(1) && ids.includes(2) && !ids.includes(3), JSON.stringify(ids));
ok("an expired quote is in, marked EXPIRED", items.find((i) => i.id === 4)?.state === "EXPIRED" && (items.find((i) => i.id === 4)?.daysLeft ?? 0) < 0);
ok("a quote valid today is EXPIRES_SOON with 0 days left", items.find((i) => i.id === 1)?.state === "EXPIRES_SOON" && items.find((i) => i.id === 1)?.daysLeft === 0);
ok("no validity date → never a reminder", !ids.includes(5));
ok("a converted quote → never a reminder", !ids.includes(6));
ok("a quote referenced by ANY ServiceQuote row → never a reminder", !ids.includes(7));
ok("soonest first (expired, today, +3)", ids.join(",") === "4,1,2", ids.join(","));
ok("empty input → nothing", selectQuoteValidityItems([], new Set(), today).length === 0);
ok("DB pre-filter bound covers the whole window in Israel time", windowEndInstant(today).toISOString() === "2026-11-09T00:00:00.000Z");
ok("the bound never excludes a day inside the window (+3 at 23:59 Israel)", at("2026-11-08T21:59:00.000Z") < windowEndInstant(today));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  process.exit(1);
}
