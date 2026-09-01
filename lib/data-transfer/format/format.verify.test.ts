/**
 * Data-transfer FORMAT layer — deterministic verifier.
 *
 * NO database, NO network, NO secrets. Every assertion is a pure function of
 * its inputs (the XLSX cases go through ExcelJS in memory), which is why this
 * file is wired into the BLOCKING CI-1 job — the same treatment the Leads W1
 * domain core and the IMPL-2 evidence-adapter boundary get.
 *
 * Run: npx tsx lib/data-transfer/format/format.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CSV_FORMULA_GUARD_PREFIX,
  UTF8_BOM_BYTES,
  escapeCsvField,
  guardCsvFormula,
  needsCsvFormulaGuard,
  writeCsvBuffer,
  writeCsvText,
} from "@/lib/data-transfer/format/csv-writer";
import {
  decodeTableBuffer,
  detectCsvDelimiter,
  parseDelimitedText,
  readCsvTable,
} from "@/lib/data-transfer/format/csv-reader";
import {
  buildXlsxBuffer,
  sanitizeSheetName,
} from "@/lib/data-transfer/format/xlsx-writer";
import {
  normalizeCellValue,
  readXlsxTable,
} from "@/lib/data-transfer/format/xlsx-reader";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/* ================================================ 1. CSV writer — basics == */

check("a CSV buffer opens with the UTF-8 BOM", () => {
  const buf = writeCsvBuffer(["א"], [["ב"]]);
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual([...UTF8_BOM_BYTES], [0xef, 0xbb, 0xbf]);
});

check("the Excel sep directive precedes the header row", () => {
  const text = writeCsvText(["a", "b"], [["1", "2"]]);
  assert.equal(text.split("\r\n")[0], "sep=;");
});

check("the sep directive can be switched off", () => {
  const text = writeCsvText(["a"], [["1"]], { excelSepDirective: false });
  assert.equal(text, '"a"\r\n"1"');
});

check("every field is quoted and inner quotes are doubled", () => {
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField(""), '""');
  assert.equal(escapeCsvField(null), '""');
  assert.equal(escapeCsvField(undefined), '""');
  assert.equal(escapeCsvField(42), '"42"');
});

check("delimiter, EOL and embedded newlines behave", () => {
  const text = writeCsvText(["a", "b"], [["x,y", "line1\nline2"]], {
    delimiter: ",",
    excelSepDirective: false,
    eol: "\n",
  });
  assert.equal(text, '"a","b"\n"x,y","line1\nline2"');
});

check("there is no trailing line ending", () => {
  const text = writeCsvText(["a"], [["1"], ["2"]], { excelSepDirective: false });
  assert.equal(text.endsWith('"2"'), true);
});

/* ============================ 2. SECURITY — CSV / formula injection ======= */

// The owner-mandated coverage: =, +, -, @, TAB, CR.
const INJECTION_TRIGGERS: Array<[string, string]> = [
  ["equals", "=1+1"],
  ["equals-hyperlink", '=HYPERLINK("http://evil","click")'],
  ["plus", "+1+1"],
  ["minus", "-2+3"],
  ["at", "@SUM(A1:A9)"],
  ["tab", "\t=cmd|' /C calc'!A0"],
  ["carriage-return", "\r=cmd|' /C calc'!A0"],
];

for (const [name, payload] of INJECTION_TRIGGERS) {
  check(`formula payload (${name}) is neutralized`, () => {
    assert.equal(needsCsvFormulaGuard(payload), true, name);
    const guarded = guardCsvFormula(payload);
    assert.equal(guarded, CSV_FORMULA_GUARD_PREFIX + payload);
    // And it survives into the rendered field, still quoted.
    assert.equal(escapeCsvField(payload), `"${guarded.replace(/"/g, '""')}"`);
    assert.equal(escapeCsvField(payload).startsWith(`"'`), true);
  });
}

check("the guard fires on the FIRST character only, never mid-value", () => {
  for (const safe of ["a=b", "x+y", "3-4-5", "user@example.com", "בדיקה"]) {
    assert.equal(needsCsvFormulaGuard(safe), false, safe);
    assert.equal(guardCsvFormula(safe), safe, safe);
  }
});

check("plain numbers are EXEMPT so financial exports stay numeric", () => {
  // Regression guard for the exact failure this exemption exists to prevent:
  // guarding "-187.77" would have turned every negative amount in the
  // Accountant Export into text.
  for (const numeric of ["-187.77", "-0.5", "+5", "-1", "1e-3", "+1.5E+10", "-.25"]) {
    assert.equal(needsCsvFormulaGuard(numeric), false, numeric);
    assert.equal(escapeCsvField(numeric), `"${numeric}"`, numeric);
  }
  assert.equal(escapeCsvField(-187.77), '"-187.77"');
});

check("a lone dash is NOT a number and IS guarded", () => {
  assert.equal(needsCsvFormulaGuard("-"), true);
  assert.equal(needsCsvFormulaGuard("-abc"), true);
  assert.equal(needsCsvFormulaGuard("--1"), true);
});

check("an empty value is never guarded", () => {
  assert.equal(needsCsvFormulaGuard(""), false);
  assert.equal(guardCsvFormula(""), "");
});

/* ======================= 3. REGRESSION — Accountant Export byte layout ==== */

/**
 * The EXACT pre-fix implementation, reproduced here on purpose.
 *
 * This makes the regression differential instead of aspirational: the same
 * inputs go through the legacy renderer and the canonical writer, and we assert
 * byte-identity for ordinary accountant data and a SPECIFIC, minimal difference
 * for hostile data. Reproducing it (rather than importing the module) keeps
 * this verifier free of Prisma, storage and archiver — the precondition for
 * running it in the blocking CI job with no database.
 */
function legacyEscapeCsvField(value: string | number): string {
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}
function legacyAccountantCsvText(
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[]
): string {
  const SEP = ";";
  const lines: string[] = [
    "sep=;",
    headers.map(legacyEscapeCsvField).join(SEP),
  ];
  for (const row of rows) {
    lines.push(row.map(legacyEscapeCsvField).join(SEP));
  }
  return lines.join("\r\n");
}

/** The shipped Accountant Export column order (lib/reports/accountant-export-zip.ts). */
const ACCOUNTANT_HEADERS = [
  "תאריך עסקה",
  "ספק",
  "קטגוריה",
  "סכום",
  "כיוון",
  "סטטוס מסמך",
  "רמת ביטחון בנתונים",
  "קובץ מקור",
] as const;

/** Ordinary rows: exactly what a real month produces. */
const BENIGN_ROWS: (string | number)[][] = [
  ["15/01/2026", "סופר פארם", "ציוד משרדי", 187.77, "הוצאה", "מאושר", "גבוה", "approved/doc-11.pdf"],
  ["03/02/2026", 'חברת "אלפא" בע"מ', "שיווק", -250.5, "הכנסה", "ממתין", "85%", "pending/doc-12.jpg"],
  ["28/02/2026", "ספק ללא קובץ", "אחר", 0, "לא ידוע", "ממתין", "לא ידוע", ""],
];

check("REGRESSION: benign accountant rows are BYTE-IDENTICAL to the pre-fix output", () => {
  const legacy = legacyAccountantCsvText(ACCOUNTANT_HEADERS, BENIGN_ROWS);
  const current = writeCsvText(ACCOUNTANT_HEADERS, BENIGN_ROWS, {
    delimiter: ";",
    excelSepDirective: true,
    eol: "\r\n",
  });
  assert.equal(current, legacy);
});

check("REGRESSION: the accountant buffer is BOM + legacy text, byte for byte", () => {
  const legacy = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(legacyAccountantCsvText(ACCOUNTANT_HEADERS, BENIGN_ROWS), "utf8"),
  ]);
  const current = writeCsvBuffer(ACCOUNTANT_HEADERS, BENIGN_ROWS, {
    delimiter: ";",
    excelSepDirective: true,
    eol: "\r\n",
  });
  assert.equal(Buffer.compare(current, legacy), 0);
});

check("REGRESSION: the negative amount stays a bare number in both renderers", () => {
  const current = writeCsvText(ACCOUNTANT_HEADERS, BENIGN_ROWS, {
    delimiter: ";",
    excelSepDirective: true,
    eol: "\r\n",
  });
  assert.equal(current.includes('"-250.5"'), true);
  assert.equal(current.includes(`"${CSV_FORMULA_GUARD_PREFIX}-250.5"`), false);
});

check("SECURITY PROOF: a hostile vendorName was executable before and is inert now", () => {
  const hostile: (string | number)[][] = [
    ["15/01/2026", '=HYPERLINK("http://evil","לחץ כאן")', "אחר", 10, "הוצאה", "מאושר", "גבוה", ""],
  ];
  const legacy = legacyAccountantCsvText(ACCOUNTANT_HEADERS, hostile);
  const current = writeCsvText(ACCOUNTANT_HEADERS, hostile, {
    delimiter: ";",
    excelSepDirective: true,
    eol: "\r\n",
  });

  // Before: quoted, but the cell still begins with "=" => Excel evaluates it.
  assert.equal(legacy.includes('";=HYPERLINK'), false);
  assert.equal(legacy.includes('"=HYPERLINK('), true);
  // After: the same cell begins with the text marker => Excel shows text.
  assert.equal(current.includes('"=HYPERLINK('), false);
  assert.equal(current.includes(`"${CSV_FORMULA_GUARD_PREFIX}=HYPERLINK(`), true);
  // Only that one field changed.
  assert.equal(
    current.replace(`"${CSV_FORMULA_GUARD_PREFIX}=HYPERLINK`, '"=HYPERLINK'),
    legacy
  );
});

check("STRUCTURAL: accountant-export-zip delegates and keeps no private CSV escaper", () => {
  // The file DOCUMENTS the removed function in its comments, so comments are
  // stripped before scanning — the same technique lead-core.test.ts uses.
  const raw = fs.readFileSync("lib/reports/accountant-export-zip.ts", "utf8");
  const blockComment = new RegExp(String.raw`/\*[\s\S]*?\*/`, "g");
  const lineComment = new RegExp(String.raw`^\s*//`);
  const src = raw
    .replace(blockComment, "")
    .split("\n")
    .filter((line) => !lineComment.test(line))
    .join("\n");

  assert.equal(
    src.includes("data-transfer/format/csv-writer"),
    true,
    "accountant export must import the canonical CSV writer"
  );
  assert.equal(
    /function\s+escapeCsvField/.test(src),
    false,
    "a private escapeCsvField reintroduces the unguarded path"
  );
  assert.equal(
    src.includes("0xef, 0xbb, 0xbf"),
    false,
    "a private BOM literal means the writer was bypassed"
  );
});

/* ================================================ 4. CSV reader — parsing = */

check("a quoted field may contain the delimiter, quotes and newlines", () => {
  const text = 'a;b\r\n"x;y";"line1\nline2"\r\n"he said ""hi""";z';
  const { rows, delimiter } = parseDelimitedText(text);
  assert.equal(delimiter, ";");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["x;y", "line1\nline2"],
    ['he said "hi"', "z"],
  ]);
});

check("CRLF, LF and lone-CR line endings all terminate a row", () => {
  assert.deepEqual(parseDelimitedText("a,b\r\n1,2\n3,4\r5,6").rows, [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
    ["5", "6"],
  ]);
});

check("delimiter detection ignores separators inside quotes", () => {
  // A ;-file whose first cell quotes "city, country" must not be read as CSV-comma.
  assert.equal(detectCsvDelimiter('"תל אביב, ישראל";"טלפון";"אימייל"'), ";");
  assert.equal(detectCsvDelimiter("a,b,c"), ",");
  assert.equal(detectCsvDelimiter("a\tb\tc"), "\t");
  // No candidate at all -> comma, and a single column still parses.
  assert.equal(detectCsvDelimiter("only-one-column"), ",");
});

check("the sep= directive is consumed as configuration, never as data", () => {
  const table = readCsvTable('sep=;\r\n"שם";"טלפון"\r\n"אבי";"0501234567"');
  assert.deepEqual(table.headers, ["שם", "טלפון"]);
  assert.deepEqual(table.rows, [["אבי", "0501234567"]]);
  assert.equal(table.delimiter, ";");
});

check("an unknown sep= directive is dropped but not trusted", () => {
  const table = readCsvTable("sep=|\na,b\n1,2");
  assert.deepEqual(table.headers, ["a", "b"]);
  assert.equal(table.delimiter, ",");
});

check("headers are trimmed but values are left byte-exact", () => {
  const table = readCsvTable("  שם  , טלפון \n  אבי  , 050 ");
  assert.deepEqual(table.headers, ["שם", "טלפון"]);
  assert.deepEqual(table.rows, [["  אבי  ", " 050 "]]);
});

check("ragged rows are padded and fully-empty rows are skipped", () => {
  const table = readCsvTable("a,b,c\n1,2\n\n,,\n4,5,6,7");
  assert.deepEqual(table.headers, ["a", "b", "c"]);
  assert.deepEqual(table.rows, [
    ["1", "2", ""],
    ["4", "5", "6"],
  ]);
});

check("a stray quote inside an unquoted field is kept literally", () => {
  assert.deepEqual(parseDelimitedText('a,b\n12" screen,x').rows, [
    ["a", "b"],
    ['12" screen', "x"],
  ]);
});

check("maxRows truncates loudly instead of silently dropping", () => {
  const table = readCsvTable("a\n1\n2\n3\n4", { maxRows: 2 });
  assert.equal(table.rows.length, 2);
  assert.equal(table.truncated, true);
  const full = readCsvTable("a\n1\n2\n3\n4", { maxRows: 10 });
  assert.equal(full.truncated, false);
  assert.equal(full.rows.length, 4);
});

check("an empty source yields an empty table, not a crash", () => {
  const table = readCsvTable("");
  assert.deepEqual(table.headers, []);
  assert.deepEqual(table.rows, []);
});

check("a final row without a trailing newline is not lost", () => {
  assert.deepEqual(parseDelimitedText("a,b\n1,2").rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

/* ============================================= 5. CSV reader — encoding === */

check("a UTF-8 BOM is stripped and reported", () => {
  const buf = Buffer.concat([UTF8_BOM_BYTES, Buffer.from("שם,טלפון\nאבי,050", "utf8")]);
  const decoded = decodeTableBuffer(buf);
  assert.equal(decoded.encoding, "utf-8");
  assert.equal(decoded.text.startsWith("שם"), true);
  const table = readCsvTable(buf);
  assert.deepEqual(table.headers, ["שם", "טלפון"]);
  assert.equal(table.encoding, "utf-8");
});

check("UTF-8 without a BOM is detected by strict decoding", () => {
  const buf = Buffer.from("שם,טלפון\nאבי,050", "utf8");
  assert.equal(decodeTableBuffer(buf).encoding, "utf-8");
});

check("UTF-16 LE and BE BOMs are honoured", () => {
  const le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("שם,טלפון", "utf16le"),
  ]);
  const decodedLe = decodeTableBuffer(le);
  assert.equal(decodedLe.encoding, "utf-16le");
  assert.equal(decodedLe.text, "שם,טלפון");

  const utf16leBody = Buffer.from("שם", "utf16le");
  const beBody = Buffer.alloc(utf16leBody.length);
  for (let i = 0; i < utf16leBody.length; i += 2) {
    beBody[i] = utf16leBody[i + 1];
    beBody[i + 1] = utf16leBody[i];
  }
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
  const decodedBe = decodeTableBuffer(be);
  assert.equal(decodedBe.encoding, "utf-16be");
  assert.equal(decodedBe.text, "שם");
});

check("a legacy windows-1255 Hebrew CSV is recovered, not mangled", () => {
  // windows-1255 maps Hebrew to 0xE0-0xFA: shin=0xF9, final-mem=0xED,
  // tet=0xE8, lamed=0xEC, pe=0xF4, vav=0xE5, final-nun=0xEF. Those bytes are
  // invalid UTF-8, so strict decoding must REJECT them and the code-page
  // fallback must produce real Hebrew rather than U+FFFD replacements.
  const buf = Buffer.from([
    0xf9, 0xed, // שם
    0x2c, //      ,
    0xe8, 0xec, 0xf4, 0xe5, 0xef, // טלפון
  ]);
  const decoded = decodeTableBuffer(buf);
  assert.equal(decoded.encoding, "windows-1255");
  assert.equal(decoded.text.includes("�"), false);
  assert.deepEqual(decoded.text.split(","), ["שם", "טלפון"]);
});

/* ============================================== 6. CSV round-trip contract = */

check("write -> read round-trips ordinary values exactly", () => {
  const headers = ["שם", "טלפון", "הערה"];
  const rows = [
    ["אבי כהן", "0501234567", 'שורה1\nשורה2 עם "ציטוט"'],
    ["דנה;לוי", "", "x,y"],
  ];
  const table = readCsvTable(writeCsvBuffer(headers, rows));
  assert.deepEqual(table.headers, headers);
  assert.deepEqual(table.rows, rows);
});

check("a guarded value round-trips WITH its marker — documented, not silent", () => {
  // The reader deliberately does not strip the apostrophe: stripping would
  // corrupt any value that legitimately begins with one, which is far more
  // common than a value that legitimately begins with "=".
  const table = readCsvTable(writeCsvBuffer(["a"], [["=1+1"]]));
  assert.deepEqual(table.rows, [[`${CSV_FORMULA_GUARD_PREFIX}=1+1`]]);
});

/* =================================================== 7. XLSX writer ======= */

check("sheet names are sanitized to what Excel accepts", () => {
  assert.equal(sanitizeSheetName("a[b]c:d*e?f/g\\h"), "a b c d e f g h");
  assert.equal(sanitizeSheetName(""), "Sheet1");
  assert.equal(sanitizeSheetName("x".repeat(40)).length, 31);
});

// tsx compiles this file to CJS (the repo is not "type": "module"), so the
// async cases live inside main() rather than at top level.
async function main(): Promise<void> {
await checkAsync("XLSX round-trips text, numbers and dates with their types", async () => {
  const when = new Date(Date.UTC(2026, 0, 15));
  const buffer = await buildXlsxBuffer({
    name: "לקוחות",
    columns: [
      { header: "שם", type: "text" },
      { header: "סכום", type: "currency" },
      { header: "כמות", type: "integer" },
      { header: "תאריך", type: "date" },
    ],
    rows: [["אבי כהן", 187.77, 3, when]],
  });

  const table = await readXlsxTable(buffer);
  assert.equal(table.sheetName, "לקוחות");
  assert.deepEqual(table.headers, ["שם", "סכום", "כמות", "תאריך"]);
  assert.equal(table.rows.length, 1);

  const [name, amount, qty, date] = table.rows[0];
  assert.equal(name, "אבי כהן");
  assert.equal(amount, 187.77);
  assert.equal(qty, 3);
  assert.equal(date instanceof Date, true);
  assert.equal((date as Date).getTime(), when.getTime());
});

await checkAsync("SECURITY: XLSX stores a formula-looking string as TEXT", async () => {
  // XLSX needs no guard because this writer never emits a { formula } cell.
  // If a future edit changes that, this assertion fails.
  const buffer = await buildXlsxBuffer({
    name: "s",
    columns: [{ header: "h", type: "text" }],
    rows: [["=1+1"], ['=HYPERLINK("http://evil","x")']],
  });
  const table = await readXlsxTable(buffer);
  assert.deepEqual(table.rows, [["=1+1"], ['=HYPERLINK("http://evil","x")']]);
});

await checkAsync("the sheet is RTL, header-frozen, bold and auto-filtered", async () => {
  const buffer = await buildXlsxBuffer({
    name: "s",
    columns: [{ header: "שם" }, { header: "עיר" }],
    rows: [["אבי", "חיפה"]],
  });
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];

  assert.equal(ws.views[0].rightToLeft, true);
  assert.equal(ws.views[0].state, "frozen");
  assert.equal(ws.views[0].ySplit, 1);
  assert.equal(ws.getRow(1).getCell(1).font?.bold, true);
  assert.equal(ws.autoFilter != null, true);
  assert.equal((ws.getColumn(1).width ?? 0) >= 10, true);
});

await checkAsync("a numeric column keeps a non-numeric value instead of fabricating 0", async () => {
  const buffer = await buildXlsxBuffer({
    name: "s",
    columns: [{ header: "סכום", type: "number" }],
    rows: [["לא-מספר"], [12.5], [null]],
  });
  const table = await readXlsxTable(buffer);
  assert.deepEqual(table.rows, [["לא-מספר"], [12.5]]);
});

await checkAsync("maxRows truncates an XLSX read loudly", async () => {
  const buffer = await buildXlsxBuffer({
    name: "s",
    columns: [{ header: "a" }],
    rows: [["1"], ["2"], ["3"]],
  });
  const table = await readXlsxTable(buffer, { maxRows: 2 });
  assert.equal(table.rows.length, 2);
  assert.equal(table.truncated, true);
});

/* =================================================== 8. XLSX cell coercion  */

check("every ExcelJS cell shape reduces to a primitive", () => {
  assert.equal(normalizeCellValue(null), null);
  assert.equal(normalizeCellValue(undefined), null);
  assert.equal(normalizeCellValue("x"), "x");
  assert.equal(normalizeCellValue(5), 5);
  assert.equal(normalizeCellValue(true), true);

  const d = new Date(Date.UTC(2026, 1, 3));
  assert.equal(normalizeCellValue(d), d);

  // Rich text -> concatenated text.
  assert.equal(
    normalizeCellValue({ richText: [{ text: "אבי" }, { text: " כהן" }] }),
    "אבי כהן"
  );
  // Formula -> its cached RESULT, never the formula source.
  assert.equal(normalizeCellValue({ formula: "1+1", result: 2 }), 2);
  assert.equal(normalizeCellValue({ sharedFormula: "A1", result: "ok" }), "ok");
  assert.equal(normalizeCellValue({ formula: "A1" }), null);
  // An error cell is MISSING data, not the text "#REF!".
  assert.equal(normalizeCellValue({ error: "#REF!" }), null);
  // Hyperlink -> its display text.
  assert.equal(
    normalizeCellValue({ hyperlink: "http://x", text: "לחץ" }),
    "לחץ"
  );
  assert.equal(normalizeCellValue({ hyperlink: "http://x" }), "http://x");
});

check("an unforeseen object never leaks an object shape into the preview", () => {
  const value = normalizeCellValue({ something: "unexpected" });
  assert.equal(typeof value, "string");
});

/* ================================================= 9. layer boundary ====== */

check("BOUNDARY: the format layer imports no Prisma, tenant or storage code", () => {
  // This is what lets the verifier run in the blocking CI job with no database.
  const dir = "lib/data-transfer/format";
  const forbidden = [
    "@/lib/prisma",
    "@prisma/client",
    "@/lib/tenant/",
    "@/lib/storage",
    "next/server",
  ];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".verify.test.ts")) continue;
    const src = fs.readFileSync(`${dir}/${file}`, "utf8");
    for (const needle of forbidden) {
      assert.equal(
        src.includes(needle),
        false,
        `${file} must not import ${needle}`
      );
    }
  }
});

console.log(`\nDATA-TRANSFER FORMAT VERIFY PASS — ${passed} checks green.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
