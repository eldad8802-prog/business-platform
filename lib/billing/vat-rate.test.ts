/**
 * Run: npx tsx lib/billing/vat-rate.test.ts
 *
 * Pure: the Israeli standard-VAT table, the civil-date (Asia/Jerusalem)
 * boundary, the new-line default by business kind, and the non-blocking
 * mismatch warning.
 */
import assert from "node:assert/strict";
import {
  EXEMPT_DEALER_VAT_RATE_PERCENT,
  ISRAEL_STANDARD_VAT_RATES,
  defaultVatRatePercentFor,
  documentTypeGetsVatRateCheck,
  isExemptDealer,
  israelCivilDate,
  standardVatRatePercentOn,
  summarizeDocumentVatRates,
  vatRateWarningFor,
} from "./vat-rate";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
const d = (iso: string) => new Date(iso);

// ---- table ----
ok("table is ascending, frozen and has the two known periods", () => {
  assert.deepEqual(
    ISRAEL_STANDARD_VAT_RATES.map((p) => [p.fromIsraelDate, p.ratePercent]),
    [
      ["2015-10-01", "17"],
      ["2025-01-01", "18"],
    ]
  );
  assert.ok(Object.isFrozen(ISRAEL_STANDARD_VAT_RATES));
  assert.ok(Object.isFrozen(ISRAEL_STANDARD_VAT_RATES[0]));
});

// ---- civil date in Israel ----
ok("israelCivilDate: UTC evening is already the next day in Israel (winter, UTC+2)", () => {
  assert.equal(israelCivilDate(d("2024-12-31T21:59:59Z")), "2024-12-31");
  assert.equal(israelCivilDate(d("2024-12-31T22:00:00Z")), "2025-01-01");
  assert.equal(israelCivilDate(d("2024-12-31T23:30:00Z")), "2025-01-01");
});
ok("israelCivilDate: summer time (UTC+3)", () => {
  assert.equal(israelCivilDate(d("2025-07-01T20:59:59Z")), "2025-07-01");
  assert.equal(israelCivilDate(d("2025-07-01T21:00:00Z")), "2025-07-02");
});
ok("israelCivilDate: invalid date throws", () => {
  assert.throws(() => israelCivilDate(new Date("nope")), RangeError);
});

// ---- standard rate by date ----
ok("17% on the last day of 2024 (Israel)", () => {
  assert.equal(standardVatRatePercentOn(d("2024-12-31T00:00:00+02:00")), "17");
  assert.equal(standardVatRatePercentOn(d("2024-12-31T23:59:59+02:00")), "17");
  assert.equal(standardVatRatePercentOn(d("2024-12-31T21:59:59Z")), "17");
});
ok("18% from the first moment of 2025-01-01 in Israel", () => {
  assert.equal(standardVatRatePercentOn(d("2025-01-01T00:00:00+02:00")), "18");
  assert.equal(standardVatRatePercentOn(d("2024-12-31T22:00:00Z")), "18");
  // the time-zone edge: still 2024 in UTC, already 2025 in Israel
  assert.equal(standardVatRatePercentOn(d("2024-12-31T23:30:00Z")), "18");
});
ok("18% today and later", () => {
  assert.equal(standardVatRatePercentOn(d("2026-10-22T12:00:00Z")), "18");
  assert.equal(standardVatRatePercentOn(d("2030-01-01T12:00:00Z")), "18");
});
ok("17% from 2015-10-01 (Israel), null before the table", () => {
  assert.equal(standardVatRatePercentOn(d("2015-10-01T00:00:00+03:00")), "17");
  assert.equal(standardVatRatePercentOn(d("2015-09-30T21:00:00Z")), "17"); // 00:00 IDT
  assert.equal(standardVatRatePercentOn(d("2015-09-30T20:59:59Z")), null);
  assert.equal(standardVatRatePercentOn(d("2010-01-01T12:00:00Z")), null);
});

// ---- business kind ----
ok("isExemptDealer", () => {
  assert.equal(isExemptDealer("EXEMPT_DEALER"), true);
  assert.equal(isExemptDealer(" EXEMPT_DEALER "), true);
  assert.equal(isExemptDealer("AUTHORIZED_DEALER"), false);
  assert.equal(isExemptDealer("LTD_COMPANY"), false);
  assert.equal(isExemptDealer(null), false);
  assert.equal(isExemptDealer(undefined), false);
  assert.equal(isExemptDealer(""), false);
  assert.equal(isExemptDealer("exempt_dealer"), false);
});

// ---- default for a NEW line ----
ok("default: exempt dealer → 0 on any date", () => {
  for (const iso of ["2024-06-01T12:00:00Z", "2026-10-22T12:00:00Z", "2001-01-01T00:00:00Z"]) {
    assert.equal(
      defaultVatRatePercentFor({ businessKind: "EXEMPT_DEALER", documentDate: d(iso) }),
      EXEMPT_DEALER_VAT_RATE_PERCENT
    );
  }
  assert.equal(EXEMPT_DEALER_VAT_RATE_PERCENT, "0");
});
ok("default: licensed dealer / company / unknown → rate in force", () => {
  for (const kind of ["AUTHORIZED_DEALER", "LTD_COMPANY", null, undefined, "", "SOMETHING_ELSE"]) {
    assert.equal(defaultVatRatePercentFor({ businessKind: kind, documentDate: d("2026-10-22T09:00:00Z") }), "18");
    assert.equal(defaultVatRatePercentFor({ businessKind: kind, documentDate: d("2024-12-31T21:00:00Z") }), "17");
    assert.equal(defaultVatRatePercentFor({ businessKind: kind, documentDate: d("2024-12-31T23:30:00Z") }), "18");
  }
});
ok("default: date before the table falls back to its first entry", () => {
  assert.equal(defaultVatRatePercentFor({ businessKind: "LTD_COMPANY", documentDate: d("2010-01-01T00:00:00Z") }), "17");
});
ok("default is never the old hard-coded 17 today", () => {
  assert.notEqual(defaultVatRatePercentFor({ businessKind: null, documentDate: d("2026-10-22T09:00:00Z") }), "17");
});

// ---- warning ----
const now = d("2026-10-22T09:00:00Z");
ok("no warning when a licensed dealer uses the rate in force (any spelling)", () => {
  for (const r of ["18", "18.0", "18.00", " 18 "]) {
    assert.equal(vatRateWarningFor({ businessKind: "AUTHORIZED_DEALER", documentDate: now, ratePercent: r }), null);
  }
});
ok("warning when a licensed dealer / company keeps the old 17", () => {
  for (const kind of ["AUTHORIZED_DEALER", "LTD_COMPANY"]) {
    assert.deepEqual(vatRateWarningFor({ businessKind: kind, documentDate: now, ratePercent: "17" }), {
      kind: "DIFFERS_FROM_STANDARD",
      ratePercent: "17",
      expectedPercent: "18",
    });
  }
  assert.deepEqual(vatRateWarningFor({ businessKind: "LTD_COMPANY", documentDate: now, ratePercent: "17.00" }), {
    kind: "DIFFERS_FROM_STANDARD",
    ratePercent: "17.00",
    expectedPercent: "18",
  });
});
ok("licensed dealer at 0% is warned (zero-rated is legal, so it is only a warning)", () => {
  assert.equal(
    vatRateWarningFor({ businessKind: "AUTHORIZED_DEALER", documentDate: now, ratePercent: "0" })?.kind,
    "DIFFERS_FROM_STANDARD"
  );
});
ok("17 in 2024 is right, 18 in 2024 is flagged (date-aware)", () => {
  const dec2024 = d("2024-12-31T12:00:00Z");
  assert.equal(vatRateWarningFor({ businessKind: "LTD_COMPANY", documentDate: dec2024, ratePercent: "17" }), null);
  assert.deepEqual(vatRateWarningFor({ businessKind: "LTD_COMPANY", documentDate: dec2024, ratePercent: "18" }), {
    kind: "DIFFERS_FROM_STANDARD",
    ratePercent: "18",
    expectedPercent: "17",
  });
  // 23:30Z on Dec 31 is already Jan 1 in Israel
  assert.equal(vatRateWarningFor({ businessKind: "LTD_COMPANY", documentDate: d("2024-12-31T23:30:00Z"), ratePercent: "18" }), null);
});
ok("exempt dealer: 0 is fine, anything else is flagged", () => {
  for (const r of ["0", "0.00", "0.0"]) {
    assert.equal(vatRateWarningFor({ businessKind: "EXEMPT_DEALER", documentDate: now, ratePercent: r }), null);
  }
  for (const r of ["17", "18", "0.5"]) {
    assert.deepEqual(vatRateWarningFor({ businessKind: "EXEMPT_DEALER", documentDate: now, ratePercent: r }), {
      kind: "EXEMPT_DEALER_CHARGES_VAT",
      ratePercent: r,
    });
  }
});
ok("unknown kind: 0 is not flagged, 17 is", () => {
  for (const kind of [null, undefined, ""]) {
    assert.equal(vatRateWarningFor({ businessKind: kind, documentDate: now, ratePercent: "0" }), null);
    assert.equal(vatRateWarningFor({ businessKind: kind, documentDate: now, ratePercent: "18" }), null);
    assert.equal(vatRateWarningFor({ businessKind: kind, documentDate: now, ratePercent: "17" })?.kind, "DIFFERS_FROM_STANDARD");
  }
});
ok("unparsable input or a date before the table → no warning", () => {
  for (const r of ["", " ", "abc", "1e2", "18%", "١٨"]) {
    assert.equal(vatRateWarningFor({ businessKind: "LTD_COMPANY", documentDate: now, ratePercent: r }), null);
  }
  assert.equal(
    vatRateWarningFor({ businessKind: "LTD_COMPANY", documentDate: d("2010-01-01T00:00:00Z"), ratePercent: "16" }),
    null
  );
});

// ---- document types ----
ok("credit notes are not checked (they carry the reversed invoice's rate)", () => {
  assert.equal(documentTypeGetsVatRateCheck("CREDIT_NOTE"), false);
  for (const t of ["TAX_INVOICE", "QUOTE", "RECEIPT", "TAX_INVOICE_RECEIPT"]) {
    assert.equal(documentTypeGetsVatRateCheck(t), true);
  }
});

// ---- document summary (issue dialog) ----
ok("summary: lists the 1-based line numbers that need a look", () => {
  assert.deepEqual(
    summarizeDocumentVatRates({ businessKind: "AUTHORIZED_DEALER", documentDate: now, documentType: "TAX_INVOICE", ratePercents: ["18", "17", "18.00", "17.00"] }),
    { kind: "DIFFERS_FROM_STANDARD", expectedPercent: "18", lineNumbers: [2, 4] }
  );
  assert.deepEqual(
    summarizeDocumentVatRates({ businessKind: "EXEMPT_DEALER", documentDate: now, documentType: "TAX_INVOICE_RECEIPT", ratePercents: ["0", "18"] }),
    { kind: "EXEMPT_DEALER_CHARGES_VAT", lineNumbers: [2] }
  );
});
ok("summary: null when all lines are fine, no lines, or a credit note", () => {
  assert.equal(summarizeDocumentVatRates({ businessKind: "LTD_COMPANY", documentDate: now, documentType: "TAX_INVOICE", ratePercents: ["18", "18.0"] }), null);
  assert.equal(summarizeDocumentVatRates({ businessKind: "LTD_COMPANY", documentDate: now, documentType: "QUOTE", ratePercents: [] }), null);
  assert.equal(summarizeDocumentVatRates({ businessKind: "LTD_COMPANY", documentDate: now, documentType: "CREDIT_NOTE", ratePercents: ["17"] }), null);
});

console.log(`\nvat-rate: ${passed} checks passed`);
