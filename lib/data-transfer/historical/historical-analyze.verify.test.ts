/**
 * I-8B.2 — historical fiscal Analyze.
 *
 * NO database and NO network. Files are built in memory with the canonical
 * writers and handed straight to the analyzer, so what is under test is the
 * real path an upload takes.
 *
 * The emphasis is on the three places this differs from a tabular import, and
 * each is a place where being wrong is silent: which date a textual value
 * means, whether an amount survived as digits, and whether Analyze reached the
 * database at all.
 *
 * Run: npx tsx lib/data-transfer/historical/historical-analyze.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { analyzeHistoricalSource } from "@/lib/data-transfer/historical/historical-analyze";
import { HISTORICAL_HEADERS } from "@/lib/data-transfer/historical/historical-fields";
import { buildXlsxBuffer } from "@/lib/data-transfer/format/xlsx-writer";
import { writeCsvBuffer } from "@/lib/data-transfer/format/csv-writer";
import {
  TEMPLATE_DATA_SHEET,
  TEMPLATE_GUIDE_SHEET,
} from "@/lib/data-transfer/templates/template-builder";
import type { SheetCell } from "@/lib/data-transfer/format/table.types";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
} from "@/lib/data-transfer/import/import-config";

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

/* ------------------------------------------------------------ fixtures --- */

const H = [...HISTORICAL_HEADERS];

/** A row that is correct in every field, as an array in contract order. */
function goodRow(overrides: Partial<Record<string, SheetCell>> = {}): SheetCell[] {
  const base: Record<string, SheetCell> = {
    "סוג מסמך": "חשבונית מס",
    "מספר מסמך מקורי": "2024/0017",
    "תאריך המסמך": "2024-03-17",
    "סכום כולל": "1170.00",
    "סכום לפני מע״מ": "1000.00",
    "מע״מ": "170.00",
    מטבע: "ILS",
    "שם לקוח": "חברת דוגמה בע״מ",
    "מספר עוסק / ח.פ. לקוח": "512345678",
    "מערכת מקור": "ידני",
    "מספר מסמך שמזוכה": "",
  };
  return H.map((header) => (header in overrides ? overrides[header]! : base[header]));
}

async function xlsxOf(
  rows: SheetCell[][],
  options: { headers?: string[]; sheets?: string[] } = {}
): Promise<Buffer> {
  const headers = options.headers ?? H;
  const sheetNames = options.sheets ?? [TEMPLATE_DATA_SHEET];
  return buildXlsxBuffer(
    sheetNames.map((name, i) => ({
      name,
      columns: headers.map((h) => ({ header: h, type: "text" as const })),
      rows: i === 0 ? rows : [],
      rightToLeft: true,
    }))
  );
}

function csvOf(rows: SheetCell[][], headers: string[] = H): Buffer {
  return writeCsvBuffer(headers, rows);
}

const analyze = (bytes: Buffer, extra: Record<string, unknown> = {}) =>
  analyzeHistoricalSource({ filename: "history.xlsx", bytes, ...extra });

/** Every error code on a result, flattened. */
function errorCodes(result: Awaited<ReturnType<typeof analyzeHistoricalSource>>): string[] {
  if (!result.ok) return [];
  return result.rows.flatMap((r) => r.errors.map((e) => e.code));
}
function warningCodes(result: Awaited<ReturnType<typeof analyzeHistoricalSource>>): string[] {
  if (!result.ok) return [];
  return result.rows.flatMap((r) => r.warnings.map((w) => w.code));
}

async function main(): Promise<void> {
  console.log("\nI-8B.2 — historical fiscal Analyze\n");

  /* ================================================== 1. file handling === */

  await check("the current limits are the ones the tabular import already enforces", () => {
    assert.equal(IMPORT_MAX_FILE_BYTES, 10 * 1024 * 1024);
    assert.equal(IMPORT_MAX_ROWS, 10_000);
  });

  await check("a valid XLSX is read, mapped and analyzed", async () => {
    const result = await analyze(await xlsxOf([goodRow()]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.file.format, "xlsx");
      assert.equal(result.file.sheetName, TEMPLATE_DATA_SHEET);
      assert.equal(result.file.rowCount, 1);
      assert.equal(result.summary.ready, 1);
      assert.equal(result.rows[0].state, "READY");
      assert.equal(result.rows[0].sourceRowNumber, 1);
    }
  });

  await check("a valid CSV with Hebrew is read the same way", async () => {
    const result = await analyzeHistoricalSource({
      filename: "history.csv",
      bytes: csvOf([goodRow()]),
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.file.format, "csv");
      assert.equal(result.file.sheetName, null);
      assert.equal(result.rows[0].state, "READY");
      const name = result.rows[0].values.find((v) => v.field === "שם לקוח");
      assert.equal(name?.normalized, "חברת דוגמה בע״מ");
    }
  });

  await check("an unsupported file type is refused", async () => {
    const result = await analyzeHistoricalSource({
      filename: "history.pdf",
      bytes: Buffer.from("%PDF-1.4"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "UNSUPPORTED_TYPE");
  });

  await check("an empty file is refused", async () => {
    const result = await analyzeHistoricalSource({
      filename: "history.csv",
      bytes: Buffer.alloc(0),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "EMPTY_FILE");
  });

  await check("a headers-only file analyzes to zero rows, not an error", async () => {
    const result = await analyze(await xlsxOf([]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.summary.totalRows, 0);
      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.mapping.blockers, []);
    }
  });

  await check("too many rows is refused by the existing ceiling", async () => {
    const rows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => goodRow());
    const result = await analyzeHistoricalSource({
      filename: "history.csv",
      bytes: csvOf(rows),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "TOO_MANY_ROWS");
  });

  await check("the canonical ייבוא sheet wins over the guide sheet", async () => {
    const bytes = await xlsxOf([goodRow()], {
      sheets: [TEMPLATE_DATA_SHEET, TEMPLATE_GUIDE_SHEET],
    });
    const result = await analyze(bytes);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.file.sheetName, TEMPLATE_DATA_SHEET);
  });

  await check("two plausible data sheets ASK rather than guess", async () => {
    const bytes = await buildXlsxBuffer([
      { name: "2023", columns: H.map((h) => ({ header: h })), rows: [goodRow()] },
      { name: "2024", columns: H.map((h) => ({ header: h })), rows: [goodRow()] },
    ]);
    const result = await analyze(bytes);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "SHEET_CHOICE_REQUIRED");
      assert.deepEqual(result.availableSheets, ["2023", "2024"]);
    }
    // And naming one resolves it deterministically.
    const chosen = await analyze(bytes, { sheetName: "2024" });
    assert.ok(chosen.ok);
    if (chosen.ok) assert.equal(chosen.file.sheetName, "2024");
  });

  /* ==================================================== 2. mapping ======= */

  await check("exact Hebrew headers map EXACT, every one of the eleven", async () => {
    const result = await analyze(await xlsxOf([goodRow()]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.mapping.entries.length, 11);
      for (const entry of result.mapping.entries) {
        assert.equal(entry.status, "EXACT", entry.field);
        assert.ok(entry.sourceIndex !== null, entry.field);
      }
      assert.deepEqual(result.mapping.unmappedSourceHeaders, []);
    }
  });

  await check("English aliases a real export uses are recognised", async () => {
    const headers = [
      "document type",
      "invoice number",
      "issue date",
      "total",
      "subtotal",
      "vat",
      "currency",
      "customer name",
      "customer tax id",
      "source system",
      "credited document",
    ];
    const result = await analyze(await xlsxOf([goodRow()], { headers }));
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.mapping.blockers, []);
      for (const entry of result.mapping.entries) {
        assert.equal(entry.status, "SUGGESTED", entry.field);
      }
      assert.equal(result.rows[0].state, "READY");
    }
  });

  await check("a dangerously broad header is NOT an alias", async () => {
    // "number" alone could be the customer number or the line number. It must
    // map to nothing rather than to the document number.
    const headers = [...H];
    headers[1] = "number";
    const result = await analyze(await xlsxOf([goodRow()], { headers }));
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(result.mapping.unmappedSourceHeaders.includes("number"));
      assert.ok(
        result.mapping.blockers.some(
          (b) => b.code === "MAPPING_REQUIRED_MISSING" && b.field === "מספר מסמך מקורי"
        )
      );
    }
    for (const broad of ["amount", "date", "סכום", "תאריך", "מספר"]) {
      const h = [...H];
      h[3] = broad;
      const r = await analyze(await xlsxOf([goodRow()], { headers: h }));
      assert.ok(r.ok);
      if (r.ok) assert.ok(r.mapping.unmappedSourceHeaders.includes(broad), broad);
    }
  });

  await check("a missing required column blocks before any row is judged", async () => {
    const headers = H.filter((h) => h !== "מטבע");
    const rows = [goodRow().filter((_, i) => H[i] !== "מטבע")];
    const result = await analyze(await xlsxOf(rows, { headers }));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.summary.stoppedAtMapping, true);
      assert.deepEqual(result.rows, []);
      assert.ok(
        result.mapping.blockers.some(
          (b) => b.code === "MAPPING_REQUIRED_MISSING" && b.field === "מטבע"
        )
      );
    }
  });

  await check("two columns claiming one field is a blocker, not a winner", async () => {
    const headers = [...H, "total"];
    const rows = [[...goodRow(), "1170.00"]];
    const result = await analyze(await xlsxOf(rows, { headers }));
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(
        result.mapping.blockers.some((b) => b.code === "MAPPING_DUPLICATE_TARGET"),
        "the duplicate must be reported"
      );
      assert.equal(result.summary.stoppedAtMapping, true);
    }
  });

  await check("an extra column nobody claims is simply not imported", async () => {
    const headers = [...H, "הערות פנימיות"];
    const rows = [[...goodRow(), "משהו"]];
    const result = await analyze(await xlsxOf(rows, { headers }));
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.mapping.unmappedSourceHeaders, ["הערות פנימיות"]);
      assert.deepEqual(result.mapping.blockers, []);
      assert.equal(result.rows[0].state, "READY");
    }
  });

  await check("an absent OPTIONAL column is not a blocker", async () => {
    const headers = H.filter((h) => h !== "שם לקוח");
    const rows = [goodRow().filter((_, i) => H[i] !== "שם לקוח")];
    const result = await analyze(await xlsxOf(rows, { headers }));
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.mapping.blockers, []);
      const entry = result.mapping.entries.find((e) => e.field === "שם לקוח");
      assert.equal(entry?.status, "UNMAPPED");
      assert.equal(entry?.requirement, "optional");
      assert.equal(result.rows[0].state, "READY");
    }
  });

  /* =============================================== 3. document type ====== */

  await check("all four types are accepted; a quote and an unknown are not", async () => {
    for (const [written, expected] of [
      ["חשבונית מס", "TAX_INVOICE"],
      ["קבלה", "RECEIPT"],
      ["חשבונית מס/קבלה", "TAX_INVOICE_RECEIPT"],
      ["חשבונית זיכוי", "CREDIT_NOTE"],
    ] as const) {
      const row = goodRow({
        "סוג מסמך": written,
        "מספר מסמך שמזוכה": expected === "CREDIT_NOTE" ? "2024/0011" : "",
      });
      const result = await analyze(await xlsxOf([row]));
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.rows[0].identity.documentTypeCode, expected, written);
      }
    }
    for (const bad of ["הצעת מחיר", "quote", "חשבונית עסקה"]) {
      const result = await analyze(await xlsxOf([goodRow({ "סוג מסמך": bad })]));
      assert.ok(errorCodes(result).includes("UNKNOWN_DOCUMENT_TYPE"), bad);
    }
  });

  /* ======================================================= 4. dates ====== */

  await check("a native Excel date cell keeps its calendar day", async () => {
    const bytes = await buildXlsxBuffer([
      {
        name: TEMPLATE_DATA_SHEET,
        columns: H.map((h) => ({ header: h, type: h === "תאריך המסמך" ? ("date" as const) : ("text" as const) })),
        rows: [goodRow({ "תאריך המסמך": new Date(Date.UTC(2024, 2, 17)) })],
      },
    ]);
    const result = await analyze(bytes);
    assert.ok(result.ok);
    if (result.ok) {
      const date = result.rows[0].values.find((v) => v.field === "תאריך המסמך");
      assert.equal(date?.normalized, "2024-03-17");
      assert.equal(result.rows[0].state, "READY");
    }
  });

  await check("an ambiguous textual date requires the owner to choose", async () => {
    const result = await analyze(await xlsxOf([goodRow({ "תאריך המסמך": "03/04/2024" })]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.dateInterpretation.requirement, "DATE_FORMAT_REQUIRED");
      assert.equal(result.dateInterpretation.deterministic, false);
      assert.deepEqual(result.dateInterpretation.choices, ["DMY", "MDY"]);
      assert.equal(result.rows[0].state, "ERROR");
      assert.ok(errorCodes(result).includes("AMBIGUOUS_DATE"));
    }
  });

  await check("the SAME file reads differently under the two formats", async () => {
    const bytes = await xlsxOf([goodRow({ "תאריך המסמך": "03/04/2024" })]);
    const dmy = await analyze(bytes, { dateFormat: "DMY" });
    const mdy = await analyze(bytes, { dateFormat: "MDY" });
    assert.ok(dmy.ok && mdy.ok);
    if (dmy.ok && mdy.ok) {
      const of = (r: typeof dmy) =>
        r.ok ? r.rows[0].values.find((v) => v.field === "תאריך המסמך")?.normalized : null;
      assert.equal(of(dmy), "2024-04-03");
      assert.equal(of(mdy), "2024-03-04");
      assert.equal(dmy.dateInterpretation.requirement, null);
      assert.equal(dmy.rows[0].state, "READY");
    }
  });

  await check("an unambiguous textual date needs no choice at all", async () => {
    const result = await analyze(await xlsxOf([goodRow({ "תאריך המסמך": "25/12/2024" })]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.dateInterpretation.requirement, null);
      assert.equal(result.dateInterpretation.deterministic, true);
      const date = result.rows[0].values.find((v) => v.field === "תאריך המסמך");
      assert.equal(date?.normalized, "2024-12-25");
    }
  });

  await check("an impossible leap date is a blocking error", async () => {
    const result = await analyze(await xlsxOf([goodRow({ "תאריך המסמך": "2023-02-29" })]));
    assert.ok(errorCodes(result).includes("INVALID_DATE"));
    if (result.ok) assert.equal(result.rows[0].state, "ERROR");
  });

  await check("a future date is a warning, not a refusal", async () => {
    const result = await analyze(await xlsxOf([goodRow({ "תאריך המסמך": "2099-01-01" })]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.rows[0].state, "WARNING");
      assert.ok(warningCodes(result).includes("FUTURE_ISSUE_DATE"));
      assert.deepEqual(result.rows[0].errors, []);
    }
  });

  /* ======================================================= 5. money ====== */

  await check("amounts survive as digits, thousands and shekel signs included", async () => {
    const row = goodRow({
      "סכום כולל": "₪1,170.00",
      "סכום לפני מע״מ": "1,000",
      "מע״מ": "170",
    });
    const result = await analyze(await xlsxOf([row]));
    assert.ok(result.ok);
    if (result.ok) {
      const of = (field: string) =>
        result.rows[0].values.find((v) => v.field === field)?.normalized;
      assert.equal(of("סכום כולל"), "1170.00");
      assert.equal(of("סכום לפני מע״מ"), "1000.00");
      assert.equal(of("מע״מ"), "170.00");
      assert.equal(result.rows[0].state, "READY");
    }
  });

  await check("the classic float hazards come through exactly", async () => {
    const row = goodRow({
      "סכום כולל": "8005.05",
      "סכום לפני מע״מ": "6841.07",
      "מע״מ": "1163.98",
    });
    const result = await analyze(await xlsxOf([row]));
    assert.ok(result.ok);
    if (result.ok) {
      const total = result.rows[0].values.find((v) => v.field === "סכום כולל");
      assert.equal(total?.normalized, "8005.05");
      // 6841.07 + 1163.98 is exactly 8005.05 in decimal, and 8005.049999... in
      // binary floating point. The Decimal comparison must call it equal.
      assert.ok(!warningCodes(result).includes("VAT_ARITHMETIC_MISMATCH"));
      assert.notEqual(6841.07 + 1163.98, 8005.05);
    }
  });

  await check("money errors are distinct and blocking", async () => {
    const cases: [string, string][] = [
      ["1,50", "AMBIGUOUS_DECIMAL_COMMA"],
      ["1170.355", "TOO_MANY_DECIMALS"],
      ["10000000000000000.00", "AMOUNT_OUT_OF_RANGE"],
      ["abc", "INVALID_AMOUNT"],
      ["", "MISSING_TOTAL"],
    ];
    for (const [written, code] of cases) {
      const result = await analyze(await xlsxOf([goodRow({ "סכום כולל": written })]));
      assert.ok(errorCodes(result).includes(code), `${written} -> ${code}`);
    }
  });

  await check("a VAT mismatch is a warning and NOTHING is repaired", async () => {
    const row = goodRow({
      "סכום כולל": "1170.00",
      "סכום לפני מע״מ": "1000.00",
      "מע״מ": "999.00",
    });
    const result = await analyze(await xlsxOf([row]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(warningCodes(result).includes("VAT_ARITHMETIC_MISMATCH"));
      assert.equal(result.rows[0].state, "WARNING");
      const of = (field: string) =>
        result.rows[0].values.find((v) => v.field === field)?.normalized;
      // All three survive exactly as the source recorded them.
      assert.equal(of("סכום כולל"), "1170.00");
      assert.equal(of("סכום לפני מע״מ"), "1000.00");
      assert.equal(of("מע״מ"), "999.00");
    }
  });

  await check("a missing subtotal is a warning and is never derived", async () => {
    const result = await analyze(
      await xlsxOf([goodRow({ "סכום לפני מע״מ": "", "מע״מ": "" })])
    );
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(warningCodes(result).includes("SUBTOTAL_MISSING"));
      const subtotal = result.rows[0].values.find((v) => v.field === "סכום לפני מע״מ");
      assert.equal(subtotal?.normalized, null, "a missing subtotal stays missing");
    }
  });

  await check("sign conventions are reported, never corrected", async () => {
    const credit = await analyze(
      await xlsxOf([
        goodRow({ "סוג מסמך": "חשבונית זיכוי", "סכום כולל": "1170.00", "מספר מסמך שמזוכה": "2024/0011" }),
      ])
    );
    assert.ok(warningCodes(credit).includes("CREDIT_NOTE_POSITIVE_AMOUNT"));
    if (credit.ok) {
      const total = credit.rows[0].values.find((v) => v.field === "סכום כולל");
      assert.equal(total?.normalized, "1170.00", "the sign must not be flipped");
    }

    const invoice = await analyze(await xlsxOf([goodRow({ "סכום כולל": "-1170.00" })]));
    assert.ok(warningCodes(invoice).includes("NON_CREDIT_NEGATIVE_AMOUNT"));
  });

  /* ==================================================== 6. currency ====== */

  await check("ILS is accepted; missing and foreign currencies are blocking", async () => {
    const ok = await analyze(await xlsxOf([goodRow({ מטבע: "₪" })]));
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.equal(ok.rows[0].values.find((v) => v.field === "מטבע")?.normalized, "ILS");
    }
    const missing = await analyze(await xlsxOf([goodRow({ מטבע: "" })]));
    assert.ok(errorCodes(missing).includes("MISSING_CURRENCY"));
    for (const foreign of ["USD", "EUR", "GBP"]) {
      const result = await analyze(await xlsxOf([goodRow({ מטבע: foreign })]));
      assert.ok(errorCodes(result).includes("UNSUPPORTED_CURRENCY"), foreign);
    }
  });

  /* ============================================ 7. customer snapshot ===== */

  await check("the customer snapshot is text, and nothing is looked up", async () => {
    const blank = await analyze(
      await xlsxOf([goodRow({ "שם לקוח": "", "מספר עוסק / ח.פ. לקוח": "" })])
    );
    assert.ok(blank.ok);
    if (blank.ok) assert.equal(blank.rows[0].state, "READY", "both are optional");

    const bad = await analyze(await xlsxOf([goodRow({ "מספר עוסק / ח.פ. לקוח": "12345" })]));
    assert.ok(errorCodes(bad).includes("INVALID_CUSTOMER_TAX_ID"));

    const src = fs.readFileSync("lib/data-transfer/historical/historical-analyze.ts", "utf8");
    for (const forbidden of ["customer.find", "customer.create", "customer.update", "@/lib/prisma"]) {
      assert.ok(!src.includes(forbidden), `Analyze must not reach ${forbidden}`);
    }
  });

  /* ==================================================== 8. document no === */

  await check("the document number is text — zeros, slashes and letters survive", async () => {
    for (const written of ["0017", "2024/0017", "INV-1001", "  2024/0017  "]) {
      const result = await analyze(await xlsxOf([goodRow({ "מספר מסמך מקורי": written })]));
      assert.ok(result.ok, written);
      if (result.ok) {
        assert.equal(
          result.rows[0].identity.originalDocumentNumber,
          written.trim(),
          written
        );
      }
    }
    const missing = await analyze(await xlsxOf([goodRow({ "מספר מסמך מקורי": "" })]));
    assert.ok(errorCodes(missing).includes("MISSING_DOCUMENT_NUMBER"));
  });

  /* ====================================================== 9. credits ===== */

  await check("a credit keeps its reference as TEXT and resolves nothing", async () => {
    const result = await analyze(
      await xlsxOf([
        goodRow({
          "סוג מסמך": "חשבונית זיכוי",
          // A credit whose three amounts agree, so the only thing under test
          // here is the reference — not the arithmetic warning.
          "סכום כולל": "-1170.00",
          "סכום לפני מע״מ": "-1000.00",
          "מע״מ": "-170.00",
          "מספר מסמך שמזוכה": "2024/0011",
        }),
      ])
    );
    assert.ok(result.ok);
    if (result.ok) {
      const ref = result.rows[0].values.find((v) => v.field === "מספר מסמך שמזוכה");
      assert.equal(ref?.normalized, "2024/0011");
      assert.equal(result.rows[0].state, "READY");
      // No resolved id is produced anywhere in the response.
      assert.ok(!JSON.stringify(result).includes("reversesHistoricalDocumentId"));
    }

    const without = await analyze(
      await xlsxOf([
        goodRow({
          "סוג מסמך": "חשבונית זיכוי",
          "סכום כולל": "-1170.00",
          "סכום לפני מע״מ": "-1000.00",
          "מע״מ": "-170.00",
        }),
      ])
    );
    assert.ok(warningCodes(without).includes("CREDIT_NOTE_WITHOUT_REFERENCE"));
  });

  /* ================================================ 10. row identity ===== */

  await check("identity material is prepared, and carries no business id", async () => {
    const result = await analyze(await xlsxOf([goodRow()]));
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.rows[0].identity, {
        sourceSystemCode: "manual",
        documentTypeCode: "TAX_INVOICE",
        originalDocumentNumber: "2024/0017",
      });
    }
  });

  /* ================================================ 11. determinism ====== */

  await check("same bytes, sheet, mapping and date format → same analysis", async () => {
    const bytes = await xlsxOf([goodRow()]);
    const a = await analyze(bytes, { dateFormat: "DMY" });
    const b = await analyze(bytes, { dateFormat: "DMY" });
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) {
      assert.equal(a.analysisHash, b.analysisHash);
      assert.equal(a.file.contentHash, b.file.contentHash);
      assert.equal(a.mapping.mappingHash, b.mapping.mappingHash);
      assert.deepEqual(a.rows, b.rows);
    }
  });

  await check("changing the DATE FORMAT changes the analysis identity", async () => {
    const bytes = await xlsxOf([goodRow()]);
    const unset = await analyze(bytes);
    const dmy = await analyze(bytes, { dateFormat: "DMY" });
    const mdy = await analyze(bytes, { dateFormat: "MDY" });
    assert.ok(unset.ok && dmy.ok && mdy.ok);
    if (unset.ok && dmy.ok && mdy.ok) {
      // The bytes are identical, so the content hash must NOT move.
      assert.equal(dmy.file.contentHash, mdy.file.contentHash);
      // The identity must, because the choice decides which month a row is in.
      assert.notEqual(dmy.analysisHash, mdy.analysisHash);
      assert.notEqual(unset.analysisHash, dmy.analysisHash);
    }
  });

  await check("changing the mapping or the sheet changes the identity", async () => {
    const bytes = await xlsxOf([goodRow()]);
    const auto = await analyze(bytes);
    const narrowed = await analyze(bytes, { mapping: { 0: "סוג מסמך" } });
    assert.ok(auto.ok && narrowed.ok);
    if (auto.ok && narrowed.ok) {
      assert.notEqual(auto.mapping.mappingHash, narrowed.mapping.mappingHash);
      assert.notEqual(auto.analysisHash, narrowed.analysisHash);
    }

    const twoSheets = await buildXlsxBuffer([
      { name: "2023", columns: H.map((h) => ({ header: h })), rows: [goodRow()] },
      { name: "2024", columns: H.map((h) => ({ header: h })), rows: [goodRow()] },
    ]);
    const first = await analyze(twoSheets, { sheetName: "2023" });
    const second = await analyze(twoSheets, { sheetName: "2024" });
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) {
      assert.notEqual(first.analysisHash, second.analysisHash);
    }
  });

  /* ================================================== 12. zero writes ==== */

  await check("Analyze cannot write, and cannot read business data either", () => {
    const files = [
      "lib/data-transfer/historical/historical-analyze.ts",
      "app/api/data-transfer/import/historical/analyze/route.ts",
    ];
    const forbidden = [
      "@/lib/prisma",
      "PrismaClient",
      "withTenantTransaction",
      "runWithTenantContext",
      "runTenantJob",
      ".create(",
      ".createMany(",
      ".update(",
      ".updateMany(",
      ".delete(",
      ".deleteMany(",
      ".upsert(",
      ".findMany(",
      ".findUnique(",
      ".findFirst(",
      "importRun",
      "historicalFiscalDocument",
      "billingDocument",
    ];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      for (const needle of forbidden) {
        assert.ok(!src.includes(needle), `${file} must not contain ${needle}`);
      }
    }
    // `Prisma.Decimal` is the only Prisma surface Analyze uses, and it is
    // arithmetic, not a client.
    const analyzeSrc = fs.readFileSync(
      "lib/data-transfer/historical/historical-analyze.ts",
      "utf8"
    );
    assert.ok(analyzeSrc.includes("Prisma.Decimal"));
    assert.ok(!analyzeSrc.includes("new PrismaClient"));
  });

  /* ============================================= 13. capability gate ===== */

  await check("Analyze is granted alone — there is no historical preview or execute", () => {
    assert.ok(
      fs.existsSync("app/api/data-transfer/import/historical/analyze/route.ts"),
      "the analyze route must exist"
    );
    for (const forbidden of [
      "app/api/data-transfer/import/historical/preview/route.ts",
      "app/api/data-transfer/import/historical/execute/route.ts",
    ]) {
      assert.ok(!fs.existsSync(forbidden), `${forbidden} must not exist yet`);
    }
    // And the generic routes still refuse the domain, because the historical
    // domain is still absent from the list they gate on.
    const registry = fs.readFileSync(
      "lib/data-transfer/export/export-registry.ts",
      "utf8"
    );
    assert.ok(!registry.includes("historical"));
  });

  await check("the route derives the tenant from the session, never from the request", () => {
    const src = fs.readFileSync(
      "app/api/data-transfer/import/historical/analyze/route.ts",
      "utf8"
    );
    assert.ok(src.includes("getCurrentUser(req)"));
    assert.ok(src.includes("authRequiredResponse(req)"));
    // No path by which a caller could name a business.
    assert.ok(!src.includes('form.get("businessId")'));
    assert.ok(!src.includes("searchParams.get(\"businessId\")"));
    assert.ok(!/businessId\s*[:=]\s*(form|body|params|headers)/.test(src));
  });

  /* ============================================ 14. data minimization ==== */

  await check("error codes are structural and carry no value from the file", async () => {
    const result = await analyze(
      await xlsxOf([
        goodRow({ "סכום כולל": "", "שם לקוח": "לקוח סודי מאוד", "מספר מסמך מקורי": "SECRET-1" }),
      ])
    );
    assert.ok(result.ok);
    if (result.ok) {
      const codes = result.rows.flatMap((r) => [
        ...r.errors.map((e) => e.code),
        ...r.warnings.map((w) => w.code),
      ]);
      for (const code of codes) {
        assert.ok(/^[A-Z_]+$/.test(code), `${code} must be a structural code`);
        assert.ok(!code.includes("לקוח"));
        assert.ok(!code.includes("SECRET"));
      }
    }
  });

  await check("the response exposes no internal identifier", async () => {
    const result = await analyze(await xlsxOf([goodRow()]));
    const json = JSON.stringify(result);
    for (const forbidden of ["businessId", "userId", "storageKey", "prisma", "SELECT ", "stack"]) {
      assert.ok(!json.includes(forbidden), `the response exposes ${forbidden}`);
    }
  });

  console.log(`\n  ${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    failures.forEach((f) => console.log(`  FAILED: ${f}`));
    process.exitCode = 1;
  }
}

void main();
