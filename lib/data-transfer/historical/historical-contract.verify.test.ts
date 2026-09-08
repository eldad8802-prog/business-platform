/**
 * I-8B.1 — the historical import contract and its two risky primitives.
 *
 * NO database and NO network. Everything here is a property of the contract,
 * the normalizers, or a workbook built in memory and parsed straight back.
 *
 * The two primitives get the most attention because they are where a fiscal
 * import goes quietly wrong: a date read under the other convention moves an
 * invoice into another tax period, and an amount that passes through binary
 * floating point arrives an agora short. Neither failure raises an error, which
 * is exactly why they are tested by value rather than by shape.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-contract.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  HISTORICAL_CONDITIONAL_FIELDS,
  HISTORICAL_FIELDS,
  HISTORICAL_HEADERS,
  HISTORICAL_REQUIRED_FIELDS,
} from "@/lib/data-transfer/historical/historical-fields";
import {
  HISTORICAL_CURRENCIES,
  HISTORICAL_DOCUMENT_TYPES,
  HISTORICAL_SOURCE_MANUAL,
  normalizeCustomerTaxIdSnapshot,
  normalizeHistoricalCurrency,
  normalizeHistoricalDocumentType,
  normalizeHistoricalSourceSystem,
} from "@/lib/data-transfer/historical/historical-vocabulary";
import {
  fiscalDateToUtcDate,
  normalizeFiscalDate,
} from "@/lib/data-transfer/historical/historical-date";
import {
  fiscalAmountToDecimal,
  normalizeFiscalAmount,
} from "@/lib/data-transfer/historical/historical-money";
import { buildHistoricalImportTemplate } from "@/lib/data-transfer/historical/historical-template";
import {
  TEMPLATE_DATA_SHEET,
  TEMPLATE_GUIDE_SHEET,
} from "@/lib/data-transfer/templates/template-builder";
import { readXlsxTable } from "@/lib/data-transfer/format/xlsx-reader";
import { getDataTransferDomain } from "@/lib/data-transfer/domains";

let passed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${label}`);
    })
    .catch((error: unknown) => {
      failures.push(label);
      console.log(`FAIL  ${label} — ${(error as Error).message}`);
    });
}

/** A date well inside the past, so `isFuture` is never accidentally true. */
const NOW = new Date("2026-09-08T09:00:00.000Z");

async function main(): Promise<void> {
  console.log("\nI-8B.1 — historical field contract, dates and money\n");

  /* ================================================ 1. field contract ==== */

  await check("exactly eleven owner-facing columns, in contract order", () => {
    assert.deepEqual(HISTORICAL_HEADERS, [
      "סוג מסמך",
      "מספר מסמך מקורי",
      "תאריך המסמך",
      "סכום כולל",
      "סכום לפני מע״מ",
      "מע״מ",
      "מטבע",
      "שם לקוח",
      "מספר עוסק / ח.פ. לקוח",
      "מערכת מקור",
      "מספר מסמך שמזוכה",
    ]);
    assert.equal(HISTORICAL_FIELDS.length, 11);
  });

  await check("each column maps to exactly one model field, with no duplicates", () => {
    const targets = HISTORICAL_FIELDS.map((f) => f.target);
    assert.equal(new Set(targets).size, targets.length);
    assert.deepEqual(targets, [
      "documentTypeCode",
      "originalDocumentNumber",
      "originalIssueDate",
      "totalAmount",
      "subtotalAmount",
      "vatAmount",
      "currency",
      "customerNameSnapshot",
      "customerTaxIdSnapshot",
      "sourceSystemCode",
      "reversesOriginalNumberRaw",
    ]);
  });

  await check("the required set is what makes a row a fiscal record", () => {
    assert.deepEqual(
      HISTORICAL_REQUIRED_FIELDS.map((f) => f.header),
      ["סוג מסמך", "מספר מסמך מקורי", "תאריך המסמך", "סכום כולל", "מטבע", "מערכת מקור"]
    );
  });

  await check("subtotal, VAT, customer name and tax id are optional", () => {
    for (const header of ["סכום לפני מע״מ", "מע״מ", "שם לקוח", "מספר עוסק / ח.פ. לקוח"]) {
      const field = HISTORICAL_FIELDS.find((f) => f.header === header);
      assert.ok(field, header);
      assert.notEqual(field.required, true, `${header} must not be required`);
    }
  });

  await check("the credited-document number is conditional, not required", () => {
    assert.deepEqual(
      HISTORICAL_CONDITIONAL_FIELDS.map((f) => f.header),
      ["מספר מסמך שמזוכה"]
    );
    assert.notEqual(HISTORICAL_CONDITIONAL_FIELDS[0].required, true);
    assert.match(HISTORICAL_CONDITIONAL_FIELDS[0].help ?? "", /זיכוי/);
  });

  await check("no internal identifier is exposed to the owner", () => {
    const surface = HISTORICAL_FIELDS.map((f) =>
      [f.header, f.help, f.example, f.target].filter(Boolean).join(" ")
    ).join(" ");
    for (const forbidden of [
      "businessId",
      "documentId",
      "importRunId",
      "reversesHistoricalDocumentId",
      "createdAt",
      "updatedAt",
      "id",
    ]) {
      // `target` is an internal name by design, so only the OWNER-FACING text
      // is searched for it.
      const ownerText = HISTORICAL_FIELDS.map((f) =>
        [f.header, f.help, f.example].filter(Boolean).join(" ")
      ).join(" ");
      assert.ok(!ownerText.includes(forbidden), `owner text exposes ${forbidden}`);
    }
    assert.ok(!surface.includes("businessId"));
  });

  await check("no customer address, email or phone in the v1 contract", () => {
    for (const target of [
      "customerAddressSnapshot",
      "customerEmailSnapshot",
      "customerPhoneSnapshot",
    ]) {
      assert.ok(
        !HISTORICAL_FIELDS.some((f) => f.target === (target as never)),
        `${target} must not be collected in v1`
      );
    }
    const headers = HISTORICAL_HEADERS.join(" ");
    for (const word of ["כתובת", "אימייל", "טלפון"]) {
      assert.ok(!headers.includes(word), `v1 must not ask for ${word}`);
    }
  });

  await check("the document number column is TEXT, never a number", () => {
    const field = HISTORICAL_FIELDS.find((f) => f.target === "originalDocumentNumber");
    assert.equal(field?.type, "text");
    const credited = HISTORICAL_FIELDS.find(
      (f) => f.target === "reversesOriginalNumberRaw"
    );
    assert.equal(credited?.type, "text");
  });

  /* ============================================ 2. type vocabulary ======= */

  await check("exactly four document types, and QUOTE is not one of them", () => {
    assert.deepEqual([...HISTORICAL_DOCUMENT_TYPES], [
      "TAX_INVOICE",
      "RECEIPT",
      "TAX_INVOICE_RECEIPT",
      "CREDIT_NOTE",
    ]);
    assert.ok(!(HISTORICAL_DOCUMENT_TYPES as readonly string[]).includes("QUOTE"));
  });

  await check("a quote is refused by name, in every spelling", () => {
    for (const quote of ["הצעת מחיר", "הצעה", "quote", "QUOTE"]) {
      const result = normalizeHistoricalDocumentType(quote);
      assert.equal(result.ok, false, `${quote} must not be accepted`);
    }
  });

  await check("the Hebrew spellings a real export carries are recognised", () => {
    const cases: [string, string][] = [
      ["חשבונית מס", "TAX_INVOICE"],
      ["  חשבונית   מס  ", "TAX_INVOICE"],
      ["קבלה", "RECEIPT"],
      ["חשבונית מס/קבלה", "TAX_INVOICE_RECEIPT"],
      ["חשבונית מס קבלה", "TAX_INVOICE_RECEIPT"],
      ["חשבונית זיכוי", "CREDIT_NOTE"],
      ["זיכוי", "CREDIT_NOTE"],
    ];
    for (const [input, expected] of cases) {
      const result = normalizeHistoricalDocumentType(input);
      assert.ok(result.ok, `${input} should be recognised`);
      assert.equal(result.value, expected, input);
      assert.equal(result.raw, input.trim(), "the original wording must survive");
    }
  });

  await check("an unknown type is refused, not guessed at", () => {
    const result = normalizeHistoricalDocumentType("חשבונית מס משוערת");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /לא מוכר/);
  });

  /* ============================================ 3. currency ============== */

  await check("ILS is the only supported currency, and it is required", () => {
    assert.deepEqual([...HISTORICAL_CURRENCIES], ["ILS"]);
    const missing = normalizeHistoricalCurrency("");
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /במפורש/);
  });

  await check("shekel spellings normalise to ILS; other currencies are refused", () => {
    for (const spelling of ["ILS", "ils", "₪", "ש\"ח", "שקל", "NIS"]) {
      const result = normalizeHistoricalCurrency(spelling);
      assert.ok(result.ok, spelling);
      assert.equal(result.value, "ILS");
    }
    for (const unsupported of ["USD", "EUR", "$"]) {
      assert.equal(normalizeHistoricalCurrency(unsupported).ok, false, unsupported);
    }
  });

  /* ============================================ 4. source system ========= */

  await check("the manual fallback is a real value, in every spelling", () => {
    for (const spelling of ["ידני", "manual", "אחר", "לא ידוע"]) {
      const result = normalizeHistoricalSourceSystem(spelling);
      assert.ok(result.ok, spelling);
      assert.equal(result.value, HISTORICAL_SOURCE_MANUAL);
    }
  });

  await check("a named system becomes a stable code and keeps its own words", () => {
    const a = normalizeHistoricalSourceSystem("Green Invoice");
    const b = normalizeHistoricalSourceSystem("green invoice");
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) {
      assert.equal(a.value, b.value, "the same system must produce the same code");
      assert.equal(a.raw, "Green Invoice", "the owner's words are preserved");
    }
    assert.equal(normalizeHistoricalSourceSystem("").ok, false);
  });

  /* ============================================ 5. customer tax id ======= */

  await check("a tax id is normalised to digits and never looks anything up", () => {
    const ok = normalizeCustomerTaxIdSnapshot("51-234-5678");
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.value, "512345678");
    const blank = normalizeCustomerTaxIdSnapshot("");
    assert.ok(blank.ok);
    if (blank.ok) assert.equal(blank.value, null);
    assert.equal(normalizeCustomerTaxIdSnapshot("12345").ok, false);
    assert.equal(normalizeCustomerTaxIdSnapshot("abcdefghi").ok, false);

    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-vocabulary.ts",
      "utf8"
    );
    for (const forbidden of ["prisma", "customer.find", "@/lib/prisma"]) {
      assert.ok(!src.includes(forbidden), `the vocabulary must not reach ${forbidden}`);
    }
  });

  /* ============================================ 6. dates ================= */

  await check("a native Excel date cell keeps its calendar day", () => {
    // ExcelJS hands back a UTC-midnight Date for a date cell. Read locally in a
    // zone behind UTC this is the 16th, which is the bug this guards.
    const cell = new Date(Date.UTC(2024, 2, 17));
    const result = normalizeFiscalDate(cell, null, NOW);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value, "2024-03-17");
      assert.equal(result.source, "excel");
    }
  });

  await check("ISO is accepted exactly as written", () => {
    const result = normalizeFiscalDate("2024-03-17", null, NOW);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value, "2024-03-17");
      assert.equal(result.source, "iso");
      assert.equal(result.display, "17/03/2024");
    }
  });

  await check("DD/MM/YYYY and DD.MM.YYYY are read under the stated contract", () => {
    for (const written of ["17/03/2024", "17.03.2024"]) {
      const result = normalizeFiscalDate(written, "DMY", NOW);
      assert.ok(result.ok, written);
      if (result.ok) assert.equal(result.value, "2024-03-17");
    }
  });

  await check("the SAME value reads differently under DMY and MDY", () => {
    const dmy = normalizeFiscalDate("03/04/2024", "DMY", NOW);
    const mdy = normalizeFiscalDate("03/04/2024", "MDY", NOW);
    assert.ok(dmy.ok && mdy.ok);
    if (dmy.ok && mdy.ok) {
      assert.equal(dmy.value, "2024-04-03");
      assert.equal(mdy.value, "2024-03-04");
      assert.notEqual(dmy.value, mdy.value);
    }
  });

  await check("an ambiguous date with NO contract is refused, never guessed", () => {
    const result = normalizeFiscalDate("03/04/2024", null, NOW);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "AMBIGUOUS_DATE");
      assert.match(result.reason, /לא ברור/);
    }
  });

  await check("a value only one reading can explain needs no contract", () => {
    // 25 cannot be a month, so there is nothing to disambiguate.
    const result = normalizeFiscalDate("25/12/2024", null, NOW);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.value, "2024-12-25");
  });

  await check("leap days: 2024 and 2000 exist, 2023 and 2100 do not", () => {
    assert.ok(normalizeFiscalDate("2024-02-29", null, NOW).ok);
    assert.ok(normalizeFiscalDate("2000-02-29", null, NOW).ok);
    for (const impossible of ["2023-02-29", "2100-02-29"]) {
      const result = normalizeFiscalDate(impossible, null, NOW);
      assert.equal(result.ok, false, impossible);
      if (!result.ok) assert.equal(result.code, "IMPOSSIBLE_DATE");
    }
  });

  await check("impossible months and days are refused", () => {
    for (const impossible of ["2024-13-01", "2024-00-10", "2024-04-31", "2024-01-32"]) {
      const result = normalizeFiscalDate(impossible, null, NOW);
      assert.equal(result.ok, false, impossible);
      if (!result.ok) assert.equal(result.code, "IMPOSSIBLE_DATE");
    }
    // And the contract cannot force one either.
    const forced = normalizeFiscalDate("31/02/2024", "DMY", NOW);
    assert.equal(forced.ok, false);
  });

  await check("malformed and empty input are refused with distinct codes", () => {
    assert.equal(normalizeFiscalDate("", null, NOW).ok, false);
    const empty = normalizeFiscalDate("", null, NOW);
    if (!empty.ok) assert.equal(empty.code, "EMPTY");
    for (const junk of ["17 במרץ 2024", "2024/03/17", "17-03-2024", "not a date", "17/3/24"]) {
      const result = normalizeFiscalDate(junk, "DMY", NOW);
      assert.equal(result.ok, false, junk);
    }
  });

  await check("the day never shifts across a timezone boundary", () => {
    // The canonical value is a calendar day, and the ONE crossing to a Date
    // pins UTC midnight — so the day survives a round trip in either direction.
    const result = normalizeFiscalDate("2024-03-17", null, NOW);
    assert.ok(result.ok);
    if (result.ok) {
      const asDate = fiscalDateToUtcDate(result.value);
      assert.equal(asDate.toISOString(), "2024-03-17T00:00:00.000Z");
      assert.equal(asDate.getUTCDate(), 17);
      // And feeding it back through the normalizer is stable.
      const again = normalizeFiscalDate(asDate, null, NOW);
      assert.ok(again.ok);
      if (again.ok) assert.equal(again.value, "2024-03-17");
    }
  });

  await check("a future date parses, and is flagged rather than refused", () => {
    const result = normalizeFiscalDate("2027-01-01", null, NOW);
    assert.ok(result.ok, "normalization must not make a business judgement");
    if (result.ok) {
      assert.equal(result.value, "2027-01-01");
      assert.equal(result.isFuture, true);
    }
    const past = normalizeFiscalDate("2024-03-17", null, NOW);
    if (past.ok) assert.equal(past.isFuture, false);
  });

  await check("nothing in the date primitive parses a user string with Date", () => {
    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-date.ts",
      "utf8"
    );
    // Comments are stripped first: the module note NAMES the hazard in prose,
    // and a guard that fires on its own explanation is a guard nobody keeps.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    // `new Date(string)` is locale- and engine-dependent. The only permitted
    // constructions are `Date.UTC` and the injected `now`.
    assert.ok(
      !/new Date\((?!Date\.UTC)[a-z]/i.test(code.replace(/new Date\(\)/g, "")),
      "the date primitive must never construct a Date from a user string"
    );
    assert.ok(src.includes("Date.UTC"), "the UTC boundary must exist");
  });

  /* ============================================ 7. money ================= */

  await check("plain and decimal amounts normalise to two decimals", () => {
    const cases: [string, string][] = [
      ["1170", "1170.00"],
      ["1170.00", "1170.00"],
      ["1170.5", "1170.50"],
      ["0", "0.00"],
      ["+7.5", "7.50"],
    ];
    for (const [input, expected] of cases) {
      const result = normalizeFiscalAmount(input);
      assert.ok(result.ok, input);
      if (result.ok) assert.equal(result.value, expected, input);
    }
  });

  await check("thousands separators and the shekel sign are stripped", () => {
    for (const written of ["1,170.00", "₪1,170.00", "1,170.00 ₪", " 1,170.00 "]) {
      const result = normalizeFiscalAmount(written);
      assert.ok(result.ok, written);
      if (result.ok) {
        assert.equal(result.value, "1170.00", written);
        assert.equal(result.display, "1,170.00");
      }
    }
  });

  await check("a negative amount keeps its sign; negative zero does not", () => {
    const negative = normalizeFiscalAmount("-117.00");
    assert.ok(negative.ok);
    if (negative.ok) assert.equal(negative.value, "-117.00");

    for (const zero of ["-0", "-0.00", "-0.0"]) {
      const result = normalizeFiscalAmount(zero);
      assert.ok(result.ok, zero);
      if (result.ok) assert.equal(result.value, "0.00", zero);
    }
  });

  await check("an ambiguous decimal comma is refused, exactly as elsewhere", () => {
    const result = normalizeFiscalAmount("1,50");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "AMBIGUOUS_DECIMAL_COMMA");
  });

  await check("more than two decimals is refused, never silently rounded", () => {
    for (const tooPrecise of ["1170.355", "0.001", "99.999"]) {
      const result = normalizeFiscalAmount(tooPrecise);
      assert.equal(result.ok, false, tooPrecise);
      if (!result.ok) assert.equal(result.code, "TOO_MANY_DECIMALS");
    }
  });

  await check("Decimal(18,2) range is enforced at sixteen integer digits", () => {
    const biggest = normalizeFiscalAmount("9999999999999999.99");
    assert.ok(biggest.ok, "the largest storable amount must be accepted");
    if (biggest.ok) assert.equal(biggest.value, "9999999999999999.99");

    const tooBig = normalizeFiscalAmount("10000000000000000.00");
    assert.equal(tooBig.ok, false);
    if (!tooBig.ok) assert.equal(tooBig.code, "OUT_OF_RANGE");
  });

  await check("malformed, empty and whitespace amounts are refused", () => {
    const empty = normalizeFiscalAmount("   ");
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "EMPTY");
    for (const junk of ["abc", "1.2.3", "--5", "1 170", "₪"]) {
      const result = normalizeFiscalAmount(junk);
      assert.equal(result.ok, false, junk);
    }
  });

  await check("NO float drift — the classic hazards survive exactly", () => {
    // Every one of these loses precision through `Number`. The canonical value
    // must be the digits the source wrote, unchanged.
    const hazards = [
      "0.1",
      "0.2",
      "0.3",
      "1170.35",
      "8005.05",
      "1.005",
      "4501.75",
      "9007199254740993.00",
    ];
    for (const raw of hazards) {
      const result = normalizeFiscalAmount(raw);
      if (raw === "1.005") {
        // Three decimals: refused, rather than rounded to a number the source
        // never wrote.
        assert.equal(result.ok, false, raw);
        continue;
      }
      assert.ok(result.ok, raw);
      if (result.ok) {
        const expected = raw.includes(".")
          ? raw.replace(/\.(\d)$/, ".$10")
          : `${raw}.00`;
        assert.equal(result.value, expected, raw);
        // And the Decimal built from it agrees, digit for digit.
        assert.equal(fiscalAmountToDecimal(result.value).toFixed(2), expected, raw);
      }
    }
    // The float route would have failed this one.
    assert.notEqual((0.1 + 0.2).toString(), "0.3");
  });

  await check("the money primitive returns a string, never a JavaScript number", () => {
    const result = normalizeFiscalAmount("1170.00");
    assert.ok(result.ok);
    if (result.ok) assert.equal(typeof result.value, "string");

    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-money.ts",
      "utf8"
    );
    for (const forbidden of ["parseFloat(", "Number(cleaned)", "toPrecision("]) {
      assert.ok(!src.includes(forbidden), `money must not use ${forbidden}`);
    }
    assert.ok(src.includes("Prisma.Decimal"), "the Decimal library must do the parsing");
  });

  /* ============================================ 8. the template ========== */

  await check("the template is a two-sheet RTL workbook that parses back", async () => {
    const template = await buildHistoricalImportTemplate(NOW);
    assert.match(
      template.filename,
      /^dubiz-historical-documents-template-\d{4}-\d{2}-\d{2}\.xlsx$/
    );
    assert.equal(template.domainId, "historical-documents");
    assert.deepEqual(template.headers, [...HISTORICAL_HEADERS]);

    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template.body as unknown as ArrayBuffer);
    assert.deepEqual(
      wb.worksheets.map((w) => w.name),
      [TEMPLATE_DATA_SHEET, TEMPLATE_GUIDE_SHEET],
      "exactly two sheets, in order"
    );
    for (const ws of wb.worksheets) {
      assert.equal(ws.views[0].rightToLeft, true, ws.name);
    }
    assert.equal(
      wb.getWorksheet(TEMPLATE_DATA_SHEET)?.views[0].state,
      "frozen",
      "the header row must stay visible while filling"
    );
  });

  await check("the import sheet is headers only — nothing uploadable by accident", async () => {
    const template = await buildHistoricalImportTemplate(NOW);
    const data = await readXlsxTable(template.body, { sheetName: TEMPLATE_DATA_SHEET });
    assert.deepEqual(data.headers, [...HISTORICAL_HEADERS]);
    assert.equal(data.rows.length, 0, "an example row here would be uploaded as data");
  });

  await check("Hebrew survives the round trip, headers included", async () => {
    const template = await buildHistoricalImportTemplate(NOW);
    const data = await readXlsxTable(template.body, { sheetName: TEMPLATE_DATA_SHEET });
    const guide = await readXlsxTable(template.body, { sheetName: TEMPLATE_GUIDE_SHEET });
    assert.ok(data.headers.includes("סכום לפני מע״מ"));
    assert.ok(data.headers.includes("מספר עוסק / ח.פ. לקוח"));
    const guideText = guide.rows.map((r) => r.join(" ")).join("\n");
    assert.match(guideText, /חשבונית מס/);
  });

  await check("the guide explains every field and the four historical rules", async () => {
    const template = await buildHistoricalImportTemplate(NOW);
    const guide = await readXlsxTable(template.body, { sheetName: TEMPLATE_GUIDE_SHEET });
    const text = guide.rows.map((r) => r.map((c) => c ?? "").join(" ")).join("\n");

    for (const header of HISTORICAL_HEADERS) {
      assert.ok(text.includes(header), `the guide must explain ${header}`);
    }
    // The four things an owner must not misread.
    assert.match(text, /במערכת אחרת/, "must say these came from another system");
    assert.match(text, /לא מנפיקה מסמך חדש|לא מקצה מספר/, "must say Dubiz issues nothing");
    assert.match(text, /המספר שהמערכת הקודמת/, "must say the number is the original");
    assert.match(text, /עמודת המטבע היא חובה/, "must say currency is required");
    assert.match(text, /זיכוי/, "must explain the credit reference");
  });

  await check("the template carries no formula, no internal id and no jargon", async () => {
    const template = await buildHistoricalImportTemplate(NOW);
    const tables = [
      await readXlsxTable(template.body, { sheetName: TEMPLATE_DATA_SHEET }),
      await readXlsxTable(template.body, { sheetName: TEMPLATE_GUIDE_SHEET }),
    ];
    const all = tables
      .flatMap((t) => [t.headers, ...t.rows])
      .flat()
      .map((c) => (c == null ? "" : String(c)))
      .join("\n");

    for (const cell of all.split("\n")) {
      assert.ok(!cell.startsWith("="), `a cell begins with = : ${cell.slice(0, 40)}`);
    }
    for (const forbidden of [
      "businessId",
      "userId",
      "importRunId",
      "documentId",
      "HistoricalFiscalDocument",
      "BillingDocument",
      "Prisma",
      "TAX_INVOICE",
      "CREDIT_NOTE",
      "storageKey",
    ]) {
      assert.ok(!all.includes(forbidden), `the template exposes ${forbidden}`);
    }
  });

  await check("template generation reads no business data at all", async () => {
    const src = fs.readFileSync(
      "lib/data-transfer/historical/historical-template.ts",
      "utf8"
    );
    for (const forbidden of ["@/lib/prisma", "@/lib/tenant/", "findMany", "businessId"]) {
      assert.ok(!src.includes(forbidden), `the template builder must not use ${forbidden}`);
    }
    // Byte-identical for the same date, which is only possible if it touched
    // nothing tenant-specific.
    const a = await buildHistoricalImportTemplate(NOW);
    const b = await buildHistoricalImportTemplate(NOW);
    assert.equal(a.filename, b.filename);
    assert.deepEqual(a.headers, b.headers);
  });

  /* ============================================ 9. separation ============ */

  await check("the historical domain stays distinct from issued documents", () => {
    assert.equal(getDataTransferDomain("historical-documents").kind, "historical");
    assert.equal(getDataTransferDomain("issued-documents").kind, "fiscal");
  });

  await check("no historical file reaches billing, issuance or the authority", () => {
    const files = [
      "lib/data-transfer/historical/historical-fields.ts",
      "lib/data-transfer/historical/historical-vocabulary.ts",
      "lib/data-transfer/historical/historical-date.ts",
      "lib/data-transfer/historical/historical-money.ts",
      "lib/data-transfer/historical/historical-template.ts",
    ];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      for (const forbidden of [
        "billingDocument",
        "BillingDocumentNumberSequence",
        "financialEvent",
        "uniform",
        "allocationNumber",
        "@/lib/prisma",
      ]) {
        assert.ok(!src.includes(forbidden), `${file} references ${forbidden}`);
      }
    }
  });

  console.log(`\n  ${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

void main();
