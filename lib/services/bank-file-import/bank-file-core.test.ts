/**
 * Bank file import (milestone B1) — the pure core, proven without a database. Every file here is synthetic.
 * The heart of it is PARITY: on the same CSV, this path must read the same lines as the payables upload's
 * own parser (`parseStatementCsv`, called here, unchanged) and give them the same identities — that is what
 * makes one bank line one row whichever path brought it. The database-side proofs are in .bfi/battery.ts.
 *
 * Run: npx tsx lib/services/bank-file-import/bank-file-core.test.ts
 */
import ExcelJS from "exceljs";

import { readCsvTable, readXlsxTable, type SheetTable } from "@/lib/data-transfer/format";
import { parseStatementCsv, statementLineIdentities } from "@/lib/services/payables/payables-p46-core";
import {
  bankHeaderKey,
  bankLineIdentities,
  bankMappingHash,
  checkBalanceChain,
  countRepeatedLines,
  legacyColumns,
  locateHeader,
  normalizeBankRows,
  proposeBankMapping,
  readAmountCell,
  readBankCsvTable,
  readDateCell,
  resolveBankMapping,
  type BankLine,
} from "./bank-file-core";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}

const BIZ = 41;
const ACCOUNT = 7;

function linesOf(table: SheetTable): { lines: BankLine[]; errors: Array<{ rowNumber: number; field: string }>; locked: boolean } {
  const located = locateHeader(table);
  if (!located) throw new Error("header not found");
  const resolved = resolveBankMapping(located.headers, null);
  if (!resolved.ok) throw new Error("mapping refused: " + resolved.problem);
  const n = normalizeBankRows(located, resolved.mapping);
  return { lines: n.lines, errors: n.errors, locked: resolved.legacyLocked };
}

const view = (l: { lineNumber: number; bookedAt: Date; amountMinor: number; direction: string; description: string | null; reference: string | null; counterpartyName: string | null }) =>
  JSON.stringify([l.lineNumber, l.bookedAt.toISOString(), l.amountMinor, l.direction, l.description, l.reference, l.counterpartyName]);

/** The old parser and this path, on the same text: same lines, same skipped rows, same identities. */
function parity(name: string, csv: string): void {
  const old = parseStatementCsv(csv);
  const mine = linesOf(readBankCsvTable(Buffer.from(csv, "utf8")));
  check(`${name}: the old parser reads it (precondition)`, old.lines.length > 0, JSON.stringify(old.errors));
  check(`${name}: identity fields are locked to the old parser's columns`, mine.locked);
  check(
    `${name}: same lines`,
    JSON.stringify(old.lines.map(view)) === JSON.stringify(mine.lines.map(view)),
    `old=${JSON.stringify(old.lines.map(view))}\nnew=${JSON.stringify(mine.lines.map(view))}`
  );
  check(
    `${name}: same skipped rows`,
    JSON.stringify(old.errors.map((e) => [e.lineNumber, e.field])) === JSON.stringify(mine.errors.map((e) => [e.rowNumber, e.field])),
    `old=${JSON.stringify(old.errors)} new=${JSON.stringify(mine.errors)}`
  );
  for (const account of [null, ACCOUNT]) {
    const a = statementLineIdentities(BIZ, account, old.lines);
    const b = statementLineIdentities(BIZ, account, mine.lines);
    check(`${name}: same identities (${account === null ? "no account" : "with account"})`, JSON.stringify(a) === JSON.stringify(b));
  }
}

/* ───────────────────────────── parity corpus ───────────────────────────── */

console.log("Parity with the payables upload (parseStatementCsv)");

parity(
  "signed amount, English headers",
  ["date,amount,description,reference", "2026-10-01,-120.50,Electric co,A-1", "2026-10-02,3000,Customer transfer,", "2026-10-03,-45,Card fee,F9"].join("\n")
);

parity(
  "Hebrew debit / credit, CRLF, BOM, Hebrew quotes, quoted thousands",
  "﻿" +
    [
      "תאריך,תיאור,אסמכתא,חובה,זכות",
      '01/10/2026,העברה מ-לקוח בע"מ,1001,,"1,250.00"',
      '02/10/2026,"חיוב, כרטיס",1002,89.90,',
      "03/10/2026,עמלה,1003,(12.00),",
      "04/10/2026,החזר,1004,,40",
    ].join("\r\n")
);

parity("value date only (the old parser reads it as the date)", ["תאריך ערך,סכום,פרטים", "05.10.26,-10,קפה", "06.10.26,250,העברה"].join("\n"));

parity(
  "value date left of the booking date (the old parser takes the leftmost)",
  ["תאריך ערך,תאריך,סכום,תיאור", "07/10/2026,06/10/2026,-77,ספק", "08/10/2026,07/10/2026,500,לקוח"].join("\n")
);

parity(
  "identical lines, bad rows and blank lines in between",
  [
    "date,amount,description",
    "2026-10-09,-20,Parking",
    "",
    "2026-10-09,-20,Parking",
    "not a date,-5,Broken",
    "2026-10-10,0,Zero",
    "2026-10-10,abc,Not money",
    "2026-10-11,-20,Parking",
    "2026-10-09,-20,Parking",
  ].join("\n")
);

parity(
  "counterparty, trailing minus, two-digit years, spaces in amounts",
  ["תאריך,סכום,מוטב,תיאור פעולה,אסמכתה", "12/10/26,120.00-,ועד בית,תשלום,77", "13/10/26,₪ 2,000.00,לקוח א,זיכוי,78"].join("\n")
);

/* ───────────────────────────── encodings and Excel ───────────────────────────── */

console.log("Encodings and Excel");

/** windows-1255 for the characters these fixtures use: ASCII, Hebrew letters, ₪. */
function encode1255(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c >= 0x05d0 && c <= 0x05ea) out.push(0xe0 + (c - 0x05d0));
    else if (c === 0x20aa) out.push(0xa4);
    else throw new Error("fixture uses a character outside the test encoder: " + ch);
  }
  return Buffer.from(out);
}

const HEB = ["תאריך,סכום,תיאור,אסמכתא", "14/10/2026,-300,שכירות,9001", "15/10/2026,1200,העברה מלקוח,9002"].join("\r\n");
{
  const utf8 = linesOf(readBankCsvTable(Buffer.from(HEB, "utf8")));
  const table1255 = readBankCsvTable(encode1255(HEB));
  const win = linesOf(table1255);
  check("windows-1255 is detected", table1255.encoding === "windows-1255", String(table1255.encoding));
  check("windows-1255 reads the same lines as UTF-8", JSON.stringify(utf8.lines.map(view)) === JSON.stringify(win.lines.map(view)));
  check(
    "windows-1255 gives the same identities as UTF-8",
    JSON.stringify(bankLineIdentities(BIZ, ACCOUNT, utf8.lines)) === JSON.stringify(bankLineIdentities(BIZ, ACCOUNT, win.lines))
  );
}

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("תנועות");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function excelTests(): Promise<void> {
  const csv = linesOf(readBankCsvTable(Buffer.from(HEB, "utf8")));
  const book = await xlsx([
    ["תאריך", "סכום", "תיאור", "אסמכתא"],
    [new Date(Date.UTC(2026, 9, 14)), -300, "שכירות", "9001"],
    [new Date(Date.UTC(2026, 9, 15)), 1200, "העברה מלקוח", "9002"],
  ]);
  const xl = linesOf(await readXlsxTable(book));
  check("an Excel export of the same statement reads the same lines", JSON.stringify(csv.lines.map(view)) === JSON.stringify(xl.lines.map(view)), JSON.stringify(xl.lines.map(view)));
  check(
    "an Excel export of the same statement gets the same identities (CSV then Excel adds nothing)",
    JSON.stringify(bankLineIdentities(BIZ, ACCOUNT, csv.lines)) === JSON.stringify(bankLineIdentities(BIZ, ACCOUNT, xl.lines))
  );

  const withPreamble = await xlsx([
    ["בנק לדוגמה בע\"מ"],
    ["חשבון: 12-345-678901", "", "תקופה: 10/2026"],
    [],
    ["תאריך", "תאריך ערך", "תיאור", "אסמכתא", "חובה", "זכות", "יתרה"],
    [new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 2)), "משכורת", "1", null, 10000, 15000],
    [new Date(Date.UTC(2026, 9, 3)), new Date(Date.UTC(2026, 9, 3)), "שכירות", "2", 4000, null, 11000],
    [new Date(Date.UTC(2026, 9, 5)), new Date(Date.UTC(2026, 9, 6)), "סופר", "3", 350.25, null, 10649.75],
  ]);
  const table = await readXlsxTable(withPreamble);
  const located = locateHeader(table);
  check("the header is found below the account preamble", located !== null && located.headers[0] === "תאריך", JSON.stringify(located?.headers));
  const p = located ? proposeBankMapping(located.headers) : null;
  check("value date and balance are proposed from their own columns", p?.mapping.valueDate === 1 && p?.mapping.balance === 6, JSON.stringify(p?.mapping));
  check("the booking date stays the booking date", p?.mapping.date === 0);
  if (located && p) {
    const n = normalizeBankRows(located, p.mapping);
    check("three lines, credit then two debits", n.lines.map((l) => l.direction).join(",") === "CREDIT,DEBIT,DEBIT");
    check("value date is read", n.lines[0].valueDate?.toISOString().slice(0, 10) === "2026-10-02");
    check("a fractional amount is exact in minor units", n.lines[2].amountMinor === 35025);
    check("the balance chain adds up", checkBalanceChain(n.lines).status === "OK", JSON.stringify(checkBalanceChain(n.lines)));
    check("row numbers count non-empty rows, preamble included (the first line is row 4)", n.lines[0].rowNumber === 4, String(n.lines[0].rowNumber));
  }
}

/* ───────────────────────────── mapping rules ───────────────────────────── */

function mappingTests(): void {
  console.log("Mapping");
  const headers = ["תאריך", "סכום", "תיאור", "אסמכתא", "יתרה", "הערות"];
  check("the old parser's columns are recognised", legacyColumns(headers)?.date === 0 && legacyColumns(headers)?.amount === 1);
  const moved = resolveBankMapping(headers, { description: 5 });
  check("an identity field cannot be moved away from the old parser's column", !moved.ok && moved.problem === "IDENTITY_FIELD_LOCKED");
  const free = resolveBankMapping(headers, { balance: null, counterparty: 5 });
  check("fields outside the identity can be changed", free.ok && free.mapping.balance === undefined && free.mapping.counterparty === 5, JSON.stringify(free));
  const twice = resolveBankMapping(headers, { counterparty: 1 });
  check("one column cannot be two fields", !twice.ok && twice.problem === "COLUMN_USED_TWICE");
  const out = resolveBankMapping(headers, { counterparty: 9 });
  check("a column that does not exist is refused", !out.ok && out.problem === "COLUMN_OUT_OF_RANGE");

  const unknown = ["תאריך עסקה", "סכום פעולה", "תאור פעולה", "יתרה בש\"ח"];
  check("headers the old parser does not know are not locked", legacyColumns(unknown) === null && !proposeBankMapping(unknown).legacyLocked);
  const prop = proposeBankMapping(unknown).mapping;
  check("…and are still proposed from the wider list", prop.date === 0 && prop.amount === 1 && prop.description === 2 && prop.balance === 3, JSON.stringify(prop));
  const owner = resolveBankMapping(["a", "b", "c"], { date: 0, amount: 2 });
  check("unrecognised headers can be mapped by hand", owner.ok && owner.mapping.amount === 2);
  check("without a date the mapping is refused", (() => { const r = resolveBankMapping(["a", "b"], { amount: 1 }); return !r.ok && r.problem === "DATE_REQUIRED"; })());

  const base = { mapping: { date: 0, amount: 1 }, accountId: ACCOUNT, sheetName: null, headerRow: 0 };
  check("the mapping hash is stable", bankMappingHash(base) === bankMappingHash({ ...base, mapping: { amount: 1, date: 0 } }));
  check("…and changes with the account", bankMappingHash(base) !== bankMappingHash({ ...base, accountId: 8 }));
  check("…and with the mapping", bankMappingHash(base) !== bankMappingHash({ ...base, mapping: { date: 0, amount: 1, balance: 2 } }));
  check("…and with the header row", bankMappingHash(base) !== bankMappingHash({ ...base, headerRow: 2 }));
}

/* ───────────────────────────── cells, balance, repeats ───────────────────────────── */

function cellTests(): void {
  console.log("Cells, balance chain, repeated lines");
  check("an Excel serial date is a date", readDateCell(46296)?.toISOString().slice(0, 10) === "2026-10-01", String(readDateCell(46296)?.toISOString()));
  check("a small number is not a date", readDateCell(12) === null);
  check("a number with three decimals is not money", readAmountCell(1.234) === null);
  check("a negative number is a negative amount", readAmountCell(-12.5) === -1250);

  const mk = (row: number, dir: "CREDIT" | "DEBIT", amount: number, balance: number | null): BankLine => ({
    lineNumber: row, rowNumber: row, bookedAt: new Date(Date.UTC(2026, 9, row, 12)), amountMinor: amount, direction: dir,
    description: null, reference: null, counterpartyName: null, valueDate: null, balanceMinor: balance,
  });
  const oldest = [mk(2, "CREDIT", 1000, 11000), mk(3, "DEBIT", 300, 10700), mk(4, "DEBIT", 200, 10500)];
  check("oldest-first balances add up", (() => { const r = checkBalanceChain(oldest); return r.status === "OK" && r.order === "OLDEST_FIRST"; })());
  const newest = [mk(2, "DEBIT", 200, 10500), mk(3, "DEBIT", 300, 10700), mk(4, "CREDIT", 1000, 11000)];
  check("newest-first balances add up", (() => { const r = checkBalanceChain(newest); return r.status === "OK" && r.order === "NEWEST_FIRST"; })());
  const missing = [mk(2, "CREDIT", 1000, 11000), mk(4, "DEBIT", 200, 10500)];
  const broken = checkBalanceChain(missing);
  check("a missing line breaks the chain at the next row", broken.status === "BROKEN" && broken.breaks.includes(4), JSON.stringify(broken));
  check("no balance column: not available", checkBalanceChain([mk(2, "CREDIT", 1, null)]).status === "NOT_AVAILABLE");

  check("identical lines are counted as repeats", countRepeatedLines([mk(2, "DEBIT", 20, null), mk(2, "DEBIT", 20, null), mk(3, "DEBIT", 20, null)]) === 1);

  const table = readBankCsvTable(Buffer.from("תאריך,סכום,תאריך ערך,יתרה\n01/10/2026,100,99/99/2026,abc\n", "utf8"));
  const located = locateHeader(table);
  if (located) {
    const r = normalizeBankRows(located, proposeBankMapping(located.headers).mapping);
    check("an unreadable value date or balance keeps the line and drops the field", r.lines.length === 1 && r.lines[0].valueDate === null && r.lines[0].balanceMinor === null && r.warnings.length === 2, JSON.stringify(r.warnings));
  } else check("header found for the warnings fixture", false);
}

/* ───────────── a real bank's layout, rebuilt with synthetic values (owner audit, 2026-10-25) ─────────────
 * UTF-16LE with a BOM, Tab-separated, eight Hebrew titles with a currency mark, newest first, a value date that
 * differs, thousands separators, negative balances, references with a leading zero and a slash, a description
 * holding a double quote. Every value below is invented; nothing comes from the owner's file. */

const REAL_HEADERS = ["תאריך", "יום ערך", "תיאור התנועה", "זכות/חובה ₪", "יתרה ₪", "אסמכתה", "עמלה", "ערוץ ביצוע"];
const REAL_ROWS: string[][] = [
  // date, value date, description, signed amount, balance after, reference, fee track, channel — newest first
  ["09/03/2026", "08/03/2026", "חיוב כרטיס 1111", "-1,234.56", "-87.55", "0412", "", "סניף"],
  ["07/03/2026", "07/03/2026", 'עמלת פעולה- מט", לפי 2 יח\'', "-6.25", "1,147.01", "411", "ערוץ ישיר", "סניף"],
  ["05/03/2026", "06/03/2026", "משכורת חודשית", "2,500.00", "1,153.26", "410/7781", "ערוץ ישיר", "יזום מחשב"],
  ["02/03/2026", "01/03/2026", "העברה לספק", "-1,346.74", "-1,346.74", "409", "", "אינטרנט"],
];

function utf16(rows: string[][]): Buffer {
  const text = rows.map((r) => r.join("\t")).join("\n") + "\n";
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function realFormatTests(): void {
  console.log("A real bank's layout (synthetic values): UTF-16LE + BOM, Tab, Hebrew titles with ₪");
  const table = readBankCsvTable(utf16([REAL_HEADERS, ...REAL_ROWS]));
  check("UTF-16LE with a BOM is detected", table.encoding === "utf-16le", String(table.encoding));
  check("Tab is detected as the delimiter", table.delimiter === "\t");
  const located = locateHeader(table);
  check("the header row is found", located !== null && located.headerRow === 0);
  const proposal = proposeBankMapping(REAL_HEADERS);
  check(
    "every column the file means is recognised: date, value date, description, signed amount, balance, reference",
    JSON.stringify(proposal.mapping) === JSON.stringify({ date: 0, amount: 3, description: 2, reference: 5, valueDate: 1, balance: 4 }),
    JSON.stringify(proposal.mapping)
  );
  check("fee track and channel are not mapped to anything", !Object.values(proposal.mapping).includes(6) && !Object.values(proposal.mapping).includes(7));
  check("nothing is ambiguous, nothing locked to the old parser (it cannot read this file)", proposal.ambiguous.length === 0 && !proposal.legacyLocked);
  if (!located) return;
  const n = normalizeBankRows(located, proposal.mapping);
  check("all lines read, none skipped, no warnings", n.lines.length === 4 && n.errors.length === 0 && n.warnings.length === 0, JSON.stringify(n.errors));
  check("negative amounts are debits, positive are credits", n.lines.map((l) => l.direction).join(",") === "DEBIT,DEBIT,CREDIT,DEBIT");
  check("thousands separators and cents are exact", n.lines[0].amountMinor === 123456 && n.lines[3].amountMinor === 134674);
  check("booking date and value date are kept apart", n.lines[2].bookedAt.toISOString().slice(0, 10) === "2026-03-05" && n.lines[2].valueDate?.toISOString().slice(0, 10) === "2026-03-06");
  check("negative balances are read", n.lines[0].balanceMinor === -8755 && n.lines[3].balanceMinor === -134674);
  check("references keep a leading zero and a slash", n.lines[0].reference === "0412" && n.lines[2].reference === "410/7781");
  check("a description holding a double quote is read whole", n.lines[1].description === 'עמלת פעולה- מט", לפי 2 יח\'');
  check("newest-first balances add up", (() => { const c = checkBalanceChain(n.lines); return c.status === "OK" && c.order === "NEWEST_FIRST"; })(), JSON.stringify(checkBalanceChain(n.lines)));

  const plain = REAL_HEADERS.map((h) => h.replace(" ₪", ""));
  check("the same titles without a currency mark map the same way", JSON.stringify(proposeBankMapping(plain).mapping) === JSON.stringify(proposal.mapping));
  const shekel = ["תאריך", "יום ערך", "תיאור התנועה", 'זכות/חובה ש"ח', 'יתרה בש"ח', "אסמכתה"];
  check('a ש"ח / בש"ח suffix maps the same way', JSON.stringify(proposeBankMapping(shekel).mapping) === JSON.stringify(proposal.mapping), JSON.stringify(proposeBankMapping(shekel).mapping));
  check("the currency mark is dropped only as a trailing word", bankHeaderKey("יתרה ₪") === "יתרה" && bankHeaderKey('סכום בש"ח') === "סכום" && bankHeaderKey("שח") === "שח");
}

function mappingSafetyTests(): void {
  console.log("Mapping safety: never a balance or fee as the amount, never an arbitrary choice");
  const noAmount = ["תאריך", "יתרה ₪", "עמלה", "אסמכתה", "סכום עמלה"];
  const p1 = proposeBankMapping(noAmount);
  check("balance, fee, reference and 'סכום עמלה' are never proposed as the amount", p1.mapping.amount === undefined && p1.mapping.debit === undefined && p1.mapping.credit === undefined, JSON.stringify(p1.mapping));
  check("…the balance column is still the balance", p1.mapping.balance === 1);
  const r1 = resolveBankMapping(noAmount, null);
  check("…so the mapping is not complete: AMOUNT_REQUIRED (the owner maps it)", !r1.ok && r1.problem === "AMOUNT_REQUIRED");
  const located1 = locateHeader(readBankCsvTable(utf16([noAmount, ["01/03/2026", "120.00", "", "1", ""]])));
  check("…and the header is still found, so the owner reaches the mapping step", located1 !== null && located1.headerRow === 0);

  const twoAmounts = ["תאריך עסקה", "סכום פעולה", "זכות/חובה", "תיאור"];
  const p2 = proposeBankMapping(twoAmounts);
  check("two amount columns: neither is chosen, the amount is ambiguous", p2.mapping.amount === undefined && p2.ambiguous.includes("amount"), JSON.stringify(p2));
  const legacyTwo = ["תאריך", "סכום", "זכות/חובה", "תיאור"];
  const p2b = proposeBankMapping(legacyTwo);
  check("…with a header the payables upload reads: its column stays (one identity), and the ambiguity is reported", p2b.legacyLocked && p2b.mapping.amount === 1 && p2b.ambiguous.includes("amount"), JSON.stringify(p2b));
  const both = ["תאריך עסקה", "סכום פעולה", "חובה", "זכות"];
  const p3 = proposeBankMapping(both);
  check("a signed amount beside debit / credit columns: none is chosen", p3.mapping.amount === undefined && p3.mapping.debit === undefined && p3.mapping.credit === undefined && p3.ambiguous.includes("amount"), JSON.stringify(p3));
  const twoDates = ["תאריך", "תאריך פעולה", "זכות/חובה"];
  const p4 = proposeBankMapping(twoDates);
  check("two date columns: neither is chosen", p4.mapping.date === undefined && p4.ambiguous.includes("date"), JSON.stringify(p4));
  const twoBalances = ["תאריך", "זכות/חובה", "יתרה", "יתרה ₪"];
  check("two balance columns: neither is chosen (optional field left to the owner)", proposeBankMapping(twoBalances).mapping.balance === undefined);

  const r2 = resolveBankMapping(REAL_HEADERS, { amount: 4 });
  check("the owner cannot map the balance column as the amount too (one column, one field)", !r2.ok && r2.problem === "COLUMN_USED_TWICE");
  const r3 = resolveBankMapping(REAL_HEADERS, { date: null });
  check("without a date nothing can be committed", !r3.ok && r3.problem === "DATE_REQUIRED");
  const r4 = resolveBankMapping(twoAmounts, { amount: 2 });
  check("after the owner chooses, the ambiguous amount resolves", r4.ok && r4.mapping.amount === 2);

  const unknown = ["תאריך", "פירוט", "תנועה", "מצב חשבון"];
  const lu = locateHeader(readBankCsvTable(utf16([unknown, ["01/03/2026", "x", "-5.00", "10.00"]])));
  check("a known date and unknown other titles: the header is found (mapping required)", lu !== null && lu.headerRow === 0);
  const strange = ["עמודה א", "עמודה ב", "עמודה ג"];
  const ls = locateHeader(readBankCsvTable(utf16([["דוח תנועות"], strange, ["01/03/2026", "קפה", "-5.00"]])));
  check("titles Dubiz does not know at all, followed by a dated row: the header is found below the preamble", ls !== null && ls.headerRow === 1, JSON.stringify(ls?.headerRow));
  const preamble = utf16([["דוח תנועות"], strange, ["01/03/2026", "קפה", "-5.00"]]);
  check("the import hub reader cuts a title-line file to one column; the bank reader keeps all three", readCsvTable(preamble).rows.every((r) => r.length === 1) && readBankCsvTable(preamble).rows.every((r) => r.length === 3));
  const noTable = locateHeader(readBankCsvTable(utf16([["סתם טקסט"], ["עוד טקסט"]])));
  check("no table at all: no header (not a bank statement), never a guess", noTable === null);
}

(async () => {
  realFormatTests();
  mappingSafetyTests();
  await excelTests();
  mappingTests();
  cellTests();
  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
