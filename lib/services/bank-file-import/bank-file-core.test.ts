/**
 * Bank file import (milestone B1) — the pure core, proven without a database. Every file here is synthetic.
 * The heart of it is PARITY: on the same CSV, this path must read the same lines as the payables upload's
 * own parser (`parseStatementCsv`, called here, unchanged) and give them the same identities — that is what
 * makes one bank line one row whichever path brought it. The database-side proofs are in .bfi/battery.ts.
 *
 * Run: npx tsx lib/services/bank-file-import/bank-file-core.test.ts
 */
import { createHash, createHmac } from "node:crypto";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { readCsvTable, readXlsxTable, type SheetTable } from "@/lib/data-transfer/format";
import { parseStatementCsv, statementLineIdentities } from "@/lib/services/payables/payables-p46-core";
import {
  accountDigits,
  bankHeaderKey,
  checkFileCurrency,
  classifyBuiltinNumberFormat,
  classifyNumberFormatCode,
  compareAccountNumber,
  distinctPrintedAccounts,
  ilsEvidenceIn,
  parsePrintedAccount,
  detectBankDelimiter,
  fileAccountNumbers,
  foreignCurrencyIn,
  isShekelValue,
  requireIlsEvidence,
  shekelMarkIn,
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
import { checkXlsxMoneyFormats } from "./xlsx-number-formats";
import { readXlsxTable } from "@/lib/data-transfer/format";
import { canonicalizeBankCoordinates, fingerprintBankCoordinates } from "@/lib/services/payables/payables-bank-crypto";

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
  check("a sep= line wins, even after leading whitespace (the parser honours it)", detectBankDelimiter("sep=;\na;b;c\n1;2;3") === null && detectBankDelimiter("  sep=;\na;b;c\n1;2;3") === null && detectBankDelimiter("a\tb\tc\n1\t2\t3\n4\t5\t6") === "\t");
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

/* ───────────── guards: shekels only, and the file's own account number (2026-11-03) ───────────── */

/** Locate, map and run the currency guard on a synthetic file, as the service does (titles first, then cells). */
function currencyOf(rows: string[][], bytes?: Buffer) {
  const table = readBankCsvTable(bytes ?? utf16(rows));
  const located = locateHeader(table);
  if (!located) return { located: false as const };
  const before = checkFileCurrency(table, located, null);
  const resolved = resolveBankMapping(located.headers, null);
  const after = resolved.ok ? checkFileCurrency(table, located, resolved.mapping) : null;
  const evidence = resolved.ok ? ilsEvidenceIn(table, located, resolved.mapping) : null;
  // What the service decides: no foreign mark, AND positive evidence of shekels.
  const accepted = before.ok && after?.ok === true && requireIlsEvidence(evidence).ok;
  return { located: true as const, before, after, evidence, accepted, accounts: fileAccountNumbers(table, located) };
}

function currencyGuardTests(): void {
  console.log("Foreign currency: refused, never converted; the shekel layout passes unchanged");
  const real = currencyOf([REAL_HEADERS, ...REAL_ROWS]);
  check(
    "REGRESSION: the real Hebrew shekel layout (₪ titles, a description holding מט\") passes the currency guard, before and after mapping",
    real.located && real.before.ok && real.after?.ok === true,
    JSON.stringify(real)
  );
  check("REGRESSION: …and it is ACCEPTED, on positive evidence: ₪ in the title of the mapped amount column (MONEY_HEADER_MARK)",
    real.located && real.accepted && real.evidence === "MONEY_HEADER_MARK", JSON.stringify(real.located && real.evidence));
  const shekelTitles = currencyOf([["דוח תנועות בחשבון עו\"ש בש\"ח"], ["תאריך", "תיאור", 'זכות/חובה ש"ח', 'יתרה בש"ח'], ["01/03/2026", "המרת מט\"ח", "-5.00", "10.00"]]);
  check('ש"ח in the titles and "המרת מט"ח" in a DESCRIPTION are never a foreign signal', shekelTitles.located && shekelTitles.before.ok && shekelTitles.after?.ok === true && shekelTitles.accepted, JSON.stringify(shekelTitles));

  console.log("Positive evidence of shekels: the absence of a foreign mark is not evidence (owner, 2026-11-03 round 2)");
  const plainReal = currencyOf([REAL_HEADERS.map((h) => h.replace(" ₪", "")), ...REAL_ROWS]);
  check("the real layout with its ₪ marks REMOVED: nothing foreign is found, but it is NOT accepted as shekels (no evidence ⇒ UNVERIFIABLE)",
    plainReal.located && plainReal.before.ok && plainReal.after?.ok === true && plainReal.evidence === null && !plainReal.accepted, JSON.stringify(plainReal));
  const refused = requireIlsEvidence(null);
  check("…the refusal is UNVERIFIABLE with the signal NO_ILS_EVIDENCE (the service answers CURRENCY_UNVERIFIABLE)",
    !refused.ok && refused.verdict === "UNVERIFIABLE" && refused.signal === "NO_ILS_EVIDENCE");
  const dollarRows = [["תאריך", "תיאור", "סכום", "יתרה"], ["01/03/2026", "ספק", "-$5.00", "$10.00"], ["02/03/2026", "לקוח", "$7.00", "$17.00"]];
  const dollarFile = currencyOf(dollarRows);
  const strippedDollar = currencyOf(dollarRows.map((r) => r.map((c) => c.replace(/\$/g, ""))));
  check("a dollar statement ($ in every money cell) is refused as FOREIGN …", dollarFile.located && !dollarFile.accepted && dollarFile.after?.ok === false);
  check("…and the SAME file with every $ stripped is NOT accepted as shekels (UNVERIFIABLE, no evidence)",
    strippedDollar.located && strippedDollar.after?.ok === true && strippedDollar.evidence === null && !strippedDollar.accepted, JSON.stringify(strippedDollar));
  const usdRows = [["תאריך", "תיאור", "סכום", "מטבע"], ["01/03/2026", "ספק", "-5.00", "USD"], ["02/03/2026", "ספק", "-6.00", "USD"]];
  const strippedUsd = currencyOf(usdRows.map((r, i) => (i === 0 ? r : [r[0], r[1], r[2], ""])));
  check("a currency column whose USD values were blanked: NOT accepted (an empty currency column is not evidence)", strippedUsd.located && strippedUsd.evidence === null && !strippedUsd.accepted, JSON.stringify(strippedUsd));
  const strippedTitle = currencyOf([["דוח תנועות - חשבון"], ["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00"]]);
  check("a title row whose foreign-currency words were removed: NOT accepted", strippedTitle.located && strippedTitle.evidence === null && !strippedTitle.accepted);
  const ilsColumnOnly = currencyOf([["תאריך", "תיאור", "סכום", "מטבע"], ["01/03/2026", "ספק", "-5.00", "ILS"], ["02/03/2026", "ספק", "-6.00", ""]]);
  check("evidence CURRENCY_COLUMN: a currency column of shekel values (blanks allowed)", ilsColumnOnly.located && ilsColumnOnly.accepted && ilsColumnOnly.evidence === "CURRENCY_COLUMN", JSON.stringify(ilsColumnOnly));
  const titleOnly = currencyOf([['דוח תנועות בחשבון בש"ח'], ["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00"]]);
  check('evidence TITLE_MARK: a title row naming the shekel ("בש"ח")', titleOnly.located && titleOnly.accepted && titleOnly.evidence === "TITLE_MARK", JSON.stringify(titleOnly));
  const cellMark = currencyOf([["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "₪ -5.00"], ["02/03/2026", "ספק", "₪ 6.00"]]);
  check("evidence AMOUNT_MARK: the ₪ sign inside the money cells", cellMark.located && cellMark.accepted && cellMark.evidence === "AMOUNT_MARK", JSON.stringify(cellMark));
  const descOnly = currencyOf([["תאריך", "תיאור", "סכום"], ["01/03/2026", 'החזר 5 ש"ח', "-5.00"]]);
  check('a shekel mark only in a DESCRIPTION is not evidence (descriptions are never read for currency)', descOnly.located && descOnly.evidence === null && !descOnly.accepted);
  const unmappedMark = currencyOf([["תאריך", "תיאור", "סכום", "עמלה ₪"], ["01/03/2026", "ספק", "-5.00", ""]]);
  check("a shekel mark on a column that is NOT a mapped money column (a fee column) is not evidence", unmappedMark.located && unmappedMark.evidence === null && !unmappedMark.accepted, JSON.stringify(unmappedMark));
  check("shekel marks: ₪, ש\"ח, ש״ח, בש\"ח, שקלים, ILS, NIS — and not inside a word (שחר, Tennis, NISSAN)",
    ["₪", 'ש"ח', "ש״ח", 'בש"ח', "בשקלים", "ILS", "nis"].every(shekelMarkIn) && !["שחר", "Tennis", "NISSAN", "משחק"].some(shekelMarkIn));

  const usdCol = currencyOf([["תאריך", "תיאור", "סכום", "מטבע"], ["01/03/2026", "ספק", "-5.00", "USD"], ["02/03/2026", "ספק", "-6.00", "USD"]]);
  check("a currency column holding USD: refused (CURRENCY_COLUMN, USD), before any mapping", usdCol.located && !usdCol.before.ok && usdCol.before.signal === "CURRENCY_COLUMN" && usdCol.before.currency === "USD", JSON.stringify(usdCol));
  const eurCol = currencyOf([["תאריך", "תיאור", "סכום", "סוג מטבע"], ["01/03/2026", "ספק", "-5.00", "אירו"]]);
  check("סוג מטבע = אירו: refused as EUR", eurCol.located && !eurCol.before.ok && eurCol.before.currency === "EUR", JSON.stringify(eurCol));
  const oddCol = currencyOf([["תאריך", "תיאור", "סכום", "Currency"], ["01/03/2026", "ספק", "-5.00", "XYZ"]]);
  check("an unknown currency value (XYZ) is refused as UNVERIFIABLE, never guessed", oddCol.located && !oddCol.before.ok && oddCol.before.verdict === "UNVERIFIABLE" && oddCol.before.currency === "XYZ", JSON.stringify(oddCol));
  const chfCol = currencyOf([["תאריך", "תיאור", "סכום", "מטבע"], ["01/03/2026", "ספק", "-5.00", "CHF"]]);
  check("a known foreign code (CHF) in a currency column is refused as FOREIGN", chfCol.located && !chfCol.before.ok && chfCol.before.verdict === "FOREIGN" && chfCol.before.currency === "CHF");
  const mixedCol = currencyOf([["תאריך", "תיאור", "סכום", "מטבע"], ["01/03/2026", "ספק", "-5.00", "ILS"], ["02/03/2026", "ספק", "-6.00", "USD"], ["03/03/2026", "ספק", "-7.00", "ILS"]]);
  check("mixed currencies in one file (ILS rows and a USD row): refused, at the USD row", mixedCol.located && !mixedCol.before.ok && mixedCol.before.currency === "USD" && mixedCol.before.rowNumber === 3, JSON.stringify(mixedCol));
  const mixedCells = currencyOf([["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00 ₪"], ["02/03/2026", "ספק", "-$6.00"]]);
  check("mixed marks in the amount cells (₪ and $): refused", mixedCells.located && mixedCells.after?.ok === false);
  const ilsCol = currencyOf([["תאריך", "תיאור", "סכום", "מטבע"], ["01/03/2026", "ספק", "-5.00", "ILS"], ["02/03/2026", "ספק", "-6.00", 'ש"ח'], ["03/03/2026", "ספק", "-7.00", "₪"], ["04/03/2026", "ספק", "-8.00", "NIS"], ["05/03/2026", "ספק", "-9.00", ""]]);
  check("a currency column of ILS / ש\"ח / ₪ / NIS / empty passes", ilsCol.located && ilsCol.before.ok && ilsCol.after?.ok === true && ilsCol.accepted, JSON.stringify(ilsCol));

  const dollarCells = currencyOf([["תאריך", "תיאור", "סכום", "יתרה"], ["01/03/2026", "ספק", "-$5.00", "$10.00"]]);
  check("$ inside amount cells: refused after mapping (AMOUNT_MARK, USD)", dollarCells.located && dollarCells.before.ok && dollarCells.after?.ok === false && (dollarCells.after as { signal: string }).signal === "AMOUNT_MARK", JSON.stringify(dollarCells));
  const euroBalance = currencyOf([["תאריך", "תיאור", "סכום", "יתרה"], ["01/03/2026", "ספק", "-5.00", "10.00 €"]]);
  check("€ in a balance cell: refused", euroBalance.located && euroBalance.after?.ok === false);
  const usdTitle = currencyOf([["דוח תנועות - חשבון מט\"ח דולר"], ["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00"]]);
  check("a title row above the header naming a foreign-currency account: refused (TITLE_MARK)", usdTitle.located && !usdTitle.before.ok && usdTitle.before.signal === "TITLE_MARK", JSON.stringify(usdTitle));
  const gbpHeader = currencyOf([["תאריך", "תיאור", "סכום GBP"], ["01/03/2026", "ספק", "-5.00"]]);
  check("a column title with GBP: refused", gbpHeader.located && !gbpHeader.before.ok && gbpHeader.before.currency === "GBP");

  check("words: אירוע / דולפין / USDT-like codes inside a word are not currencies", foreignCurrencyIn("אירוע") === null && foreignCurrencyIn("דולפין") === null && foreignCurrencyIn("XUSDX") === null);
  check("words: בדולרים, ביורו, ליש\"ט, מט\"ח are", foreignCurrencyIn("בדולרים") === "USD" && foreignCurrencyIn("ביורו") === "EUR" && foreignCurrencyIn('ליש"ט') === "GBP" && foreignCurrencyIn('חשבון מט"ח') === "FX");
  check("the shekel in its spellings is the shekel", ["ILS", "nis", 'ש"ח', "ש״ח", "₪", "שקל", "שקלים", "376"].every((v) => isShekelValue(v)) && !isShekelValue("USD") && !isShekelValue("840"));
}

function accountNumberTests(): void {
  console.log("The file's own account number against the chosen account (last four digits)");
  const titled = currencyOf([['מספר חשבון: 12-345-678901'], ["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00"]]);
  check("a title cell 'מספר חשבון: 12-345-678901' is read", titled.located && JSON.stringify(titled.accounts) === JSON.stringify(["12-345-678901"]), JSON.stringify(titled));
  const split = currencyOf([["מס' חשבון", "345-678901"], ["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00"]]);
  check("a label cell followed by a number cell is read", split.located && JSON.stringify(split.accounts) === JSON.stringify(["345-678901"]), JSON.stringify(split));
  const column = currencyOf([["תאריך", "מספר חשבון", "תיאור", "סכום"], ["01/03/2026", "678901", "ספק", "-5.00"], ["02/03/2026", "678901", "ספק", "-6.00"]]);
  check("an account column: its distinct value is read", column.located && JSON.stringify(column.accounts) === JSON.stringify(["678901"]), JSON.stringify(column));
  const balance = currencyOf([["יתרה בחשבון 1,234.56"], ["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00"]]);
  check("'יתרה בחשבון 1,234.56' is a balance, not an account number", balance.located && balance.accounts.length === 0, JSON.stringify(balance));
  const withDate = currencyOf([["חשבון: 678901 01/03/2026-31/03/2026"], ["תאריך", "תיאור", "סכום"], ["01/03/2026", "ספק", "-5.00"]]);
  check("a period printed after the number is not read into it", withDate.located && JSON.stringify(withDate.accounts) === JSON.stringify(["678901"]), JSON.stringify(withDate));
  const real = currencyOf([REAL_HEADERS, ...REAL_ROWS]);
  check("the real layout prints no account number: nothing to compare (NOT_IN_FILE)", real.located && real.accounts.length === 0 && compareAccountNumber(real.accounts, "8901").status === "NOT_IN_FILE");

  check("masked digits: only those after the mask count", accountDigits("****8901") === "8901" && accountDigits("12-xx-8") === null);
  check("PARTIAL_MATCH (no full comparison available): the full number ends with the account's last four", compareAccountNumber(["12-345-678901"], "8901").status === "PARTIAL_MATCH");
  check("PARTIAL_MATCH: a masked number", compareAccountNumber(["****8901"], "8901").status === "PARTIAL_MATCH");
  check("PARTIAL_MATCH: a sub-account / check suffix after the account is dropped", compareAccountNumber(["678901/23"], "8901").status === "PARTIAL_MATCH" && compareAccountNumber(["678901-001"], "8901").status === "PARTIAL_MATCH");
  const mismatch = compareAccountNumber(["12-345-678999"], "8901");
  check("MISMATCH: another account's number, with the file's last four", mismatch.status === "MISMATCH" && mismatch.fileLast4 === "8999", JSON.stringify(mismatch));
  const two = compareAccountNumber(["678901", "555444"], "8901");
  check("MULTIPLE_ACCOUNTS: two account numbers in one file — refused whichever account was chosen", two.status === "MULTIPLE_ACCOUNTS" && two.accounts === 2, JSON.stringify(two));
  check("MULTIPLE_ACCOUNTS: even when every value ends like the chosen account's but the full accounts differ (12-345-012345 / 12-345-12345)",
    compareAccountNumber(["12-345-012345", "12-345-12345"], "2345").status === "MULTIPLE_ACCOUNTS");
  check("MULTIPLE_ACCOUNTS: an account column with two different accounts", (() => {
    const c = currencyOf([["תאריך", "מספר חשבון", "תיאור", "סכום ₪"], ["01/03/2026", "678901", "ספק", "-5.00"], ["02/03/2026", "555444", "ספק", "-6.00"]]);
    return c.located && compareAccountNumber(c.accounts, "8901").status === "MULTIPLE_ACCOUNTS";
  })());
  check("one account printed several ways is ONE account: full + masked + with a suffix",
    distinctPrintedAccounts(["12-345-678901", "****8901", "678901/23", "12/345/678901"]) === 1 && compareAccountNumber(["12-345-678901", "****8901"], "8901").status === "PARTIAL_MATCH");
  check("NOT_IN_FILE: no readable number (fewer than four digits) blocks nothing", compareAccountNumber(["123"], "8901").status === "NOT_IN_FILE" && compareAccountNumber([], "8901").status === "NOT_IN_FILE");
}

/* ───────────── full account verification (bank, branch, account — digits as text) ───────────── */

function fullAccountTests(): void {
  console.log("Full account: VERIFIED_FULL only on a full comparison; last four is never a verification");
  check("a printed full account is read as text, leading zeros kept", JSON.stringify(parsePrintedAccount("12-345-012345")) === JSON.stringify({ bankCode: "12", branchCode: "345", accountNumber: "012345" }));
  check("not a full account: masked, branch-account only, one run of digits, wrong group lengths",
    parsePrintedAccount("12-345-****45") === null && parsePrintedAccount("345-012345") === null && parsePrintedAccount("12345012345") === null && parsePrintedAccount("1-345-012345") === null);
  // A strict matcher on the stored (bank, branch, account) strings — what the fingerprint answers in the service.
  const stored = { bankCode: "12", branchCode: "345", accountNumber: "12345" };
  const strict = (a: { bankCode: string; branchCode: string; accountNumber: string }) => a.bankCode === stored.bankCode && a.branchCode === stored.branchCode && a.accountNumber === stored.accountNumber;
  check("VERIFIED_FULL: the full printed account is the stored one", compareAccountNumber(["12-345-12345"], "2345", strict).status === "VERIFIED_FULL");
  const zero = compareAccountNumber(["12-345-012345"], "2345", strict);
  check("leading zeros matter: \"012345\" is NOT \"12345\" — MISMATCH on the full account although the last four agree", zero.status === "MISMATCH" && zero.basis === "FULL", JSON.stringify(zero));
  const branch = compareAccountNumber(["12-346-12345"], "2345", strict);
  check("another branch, the same account digits: MISMATCH (FULL)", branch.status === "MISMATCH" && branch.basis === "FULL");
  check("PARTIAL_MATCH: only the last four could be compared (masked in the file)", compareAccountNumber(["****2345"], "2345", strict).status === "PARTIAL_MATCH");
  check("PARTIAL_MATCH: the full comparison is unavailable (null)", compareAccountNumber(["12-345-12345"], "2345", () => null).status === "PARTIAL_MATCH");
  const last4 = compareAccountNumber(["****9999"], "2345", strict);
  check("MISMATCH (LAST4): the last four disagree", last4.status === "MISMATCH" && last4.basis === "LAST4");
  check("VERIFIED_FULL needs EVERY printed value verified: a full match plus a masked value is only PARTIAL_MATCH",
    compareAccountNumber(["12-345-12345", "****2345"], "2345", strict).status === "PARTIAL_MATCH");
  check("NOT_IN_FILE: nothing readable", compareAccountNumber([], "2345", strict).status === "NOT_IN_FILE");

  // The service's matcher is the account's keyed fingerprint. Synthetic keys, this process only.
  process.env.PAYABLES_BANK_FINGERPRINT_KEY = Buffer.alloc(32, 9).toString("base64");
  const fp = (a: { bankCode: string; branchCode: string; accountNumber: string }) => fingerprintBankCoordinates(a, BIZ, "BUSINESS_BANK_ACCOUNT");
  const storedFp = fp(stored);
  const byFingerprint = (a: { bankCode: string; branchCode: string; accountNumber: string }) => fp(a) === storedFp;
  check("fingerprint: the same account (as text) is equal", compareAccountNumber(["12-345-12345"], "2345", byFingerprint).status === "VERIFIED_FULL");
  check("fingerprint: \"012345\" and \"12345\" are different accounts (MISMATCH)", compareAccountNumber(["12-345-012345"], "2345", byFingerprint).status === "MISMATCH");
  check("fingerprint: another business's identical digits are another account", fingerprintBankCoordinates(stored, BIZ + 1, "BUSINESS_BANK_ACCOUNT") !== storedFp);
  // The file side reaches the SAME canonical form as the stored side: parsePrintedAccount keeps the digits as text,
  // and fingerprintBankCoordinates canonicalises both (canonicalizeBankCoordinates) before the HMAC.
  const printed = parsePrintedAccount("12/345/12345");
  check("fingerprint: a printed account with other separators fingerprints exactly as the stored account (one canonical form)",
    printed !== null && fp(printed) === storedFp && fp(canonicalizeBankCoordinates({ bankCode: "12", branchCode: "345", accountNumber: "12345" })) === storedFp);
  check("fingerprint: it is KEYED (HMAC-SHA-256), not a plain hash — not the SHA-256 of its input, and another key gives another value",
    (() => {
      const input = ["payables-bank-fp:v1", "BUSINESS_BANK_ACCOUNT", String(BIZ), "12", "345", "12345"].join("\n");
      const plain = createHash("sha256").update(input, "utf8").digest("hex");
      const hmac = createHmac("sha256", Buffer.alloc(32, 9)).update(input, "utf8").digest("hex");
      process.env.PAYABLES_BANK_FINGERPRINT_KEY = Buffer.alloc(32, 8).toString("base64");
      const other = fp(stored);
      process.env.PAYABLES_BANK_FINGERPRINT_KEY = Buffer.alloc(32, 9).toString("base64");
      return storedFp !== plain && storedFp === hmac && other !== storedFp;
    })());
  check("fingerprint: leading zeros are never padded or dropped — a bank or branch of the wrong length is refused, not guessed",
    (() => { try { fp({ bankCode: "9", branchCode: "345", accountNumber: "12345" }); return false; } catch { return true; } })());
  delete process.env.PAYABLES_BANK_FINGERPRINT_KEY;
  check("fingerprint key missing: no fingerprint is computed (it throws; the service then says full verification is unavailable)",
    (() => { try { fp(stored); return false; } catch { return true; } })());
  process.env.PAYABLES_BANK_FINGERPRINT_KEY = "too-short";
  check("fingerprint key malformed (too short): no fingerprint is computed either",
    (() => { try { fp(stored); return false; } catch { return true; } })());
  delete process.env.PAYABLES_BANK_FINGERPRINT_KEY;
}

/* ───────────── Excel number formats (the currency of a plain number) ───────────── */

/** A synthetic statement whose amount and balance cells are NUMBERS carrying the given number formats. */
async function xlsxWithFormats(amountFormats: Array<string | null>, balanceFormat: string | null = null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("תנועות");
  ws.addRow(["דוח תנועות"]);
  ws.addRow(["תאריך", "תיאור", "סכום", "יתרה"]);
  amountFormats.forEach((fmt, i) => {
    const row = ws.addRow([new Date(Date.UTC(2026, 2, i + 1)), `ספק ${i + 1}`, -(10 + i), 1000 - i]);
    if (fmt !== null) row.getCell(3).numFmt = fmt;
    if (balanceFormat !== null) row.getCell(4).numFmt = balanceFormat;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function formatsOf(bytes: Buffer) {
  const table = await readXlsxTable(bytes);
  const located = locateHeader(table);
  if (!located) return { ok: false as const, why: "no header" };
  const resolved = resolveBankMapping(located.headers, null);
  if (!resolved.ok) return { ok: false as const, why: resolved.problem };
  return { ok: true as const, check: await checkXlsxMoneyFormats(bytes, table.sheetName, located, resolved.mapping) };
}

/** Rewrite every custom number format of a workbook into a BUILT-IN id (no format code in the file). */
async function asBuiltinFormat(bytes: Buffer, id: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const styles = await zip.file("xl/styles.xml")!.async("string");
  const rewritten = styles.replace(/<numFmts\b[\s\S]*?<\/numFmts>/, "").replace(/numFmtId="16\d"/g, `numFmtId="${id}"`);
  zip.file("xl/styles.xml", rewritten);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function numberFormatTests(): Promise<void> {
  console.log("Excel number formats: a plain number's currency is in its format");
  const cls = (code: string | null) => classifyNumberFormatCode(code);
  check("plain formats are PLAIN: General, 0.00, #,##0.00, a negative in red, a locale-only token",
    ["General", "0.00", "#,##0.00", "#,##0.00;[Red]-#,##0.00", "[$-40D]#,##0.00", "#,##0.00 \"CR\""].every((c) => cls(c).kind === "PLAIN"),
    JSON.stringify(["General", "0.00", "#,##0.00", "#,##0.00;[Red]-#,##0.00", "[$-40D]#,##0.00"].map(cls)));
  check("shekel formats are ILS: \"₪\", [$₪-40D], #,##0.00 ₪, [$ILS]",
    ['"₪"#,##0.00', "[$₪-40D] #,##0.00", "#,##0.00 ₪", "[$ILS] #,##0.00"].every((c) => cls(c).kind === "ILS"),
    JSON.stringify(['"₪"#,##0.00', "[$₪-40D] #,##0.00", "#,##0.00 ₪", "[$ILS] #,##0.00"].map(cls)));
  const foreign = ["[$$-409]#,##0.00", "$#,##0", '"$"#,##0.00', "[$USD] #,##0.00", "€ #,##0.00", "[$EUR] #,##0", "[$€-x-euro2] #,##0.00", "£#,##0", "\\$#,##0"];
  check("foreign formats are FOREIGN: $, [$$-409], [$USD], €, [$EUR], £, an escaped \\$",
    foreign.every((c) => cls(c).kind === "FOREIGN"), JSON.stringify(foreign.map(cls)));
  check("an unknown bracket token or a currency-code literal is UNVERIFIABLE: [$XYZ], [Foo], \"XYZ\"",
    ["[$XYZ] #,##0.00", "[Foo]#,##0", '#,##0.00 "XYZ"'].every((c) => cls(c).kind === "UNVERIFIABLE"));
  check("built-in ids: 0–4 PLAIN; 5–8, 42, 44 (locale currency) UNVERIFIABLE; an undefined id UNVERIFIABLE",
    [0, 2, 4, 14].every((i) => classifyBuiltinNumberFormat(i).kind === "PLAIN") && [5, 7, 8, 42, 44].every((i) => classifyBuiltinNumberFormat(i).kind === "UNVERIFIABLE") && classifyBuiltinNumberFormat(100).kind === "UNVERIFIABLE");

  const plain = await formatsOf(await xlsxWithFormats([null, "#,##0.00", "0.00"]));
  check("XLSX: plain numbers with General / #,##0.00 / 0.00 are not foreign …", plain.ok && plain.check.ok, JSON.stringify(plain));
  check("…but a plain format is NOT evidence of shekels: no evidence, so the file is refused (UNVERIFIABLE)",
    plain.ok && plain.check.ok && plain.check.evidence === undefined && !requireIlsEvidence(plain.check.evidence ?? null).ok);
  const ils = await formatsOf(await xlsxWithFormats(['"₪"#,##0.00', "[$₪-40D] #,##0.00"], "#,##0.00 ₪"));
  check("XLSX: shekel-formatted amounts and balances pass, with evidence NUMBER_FORMAT", ils.ok && ils.check.ok && ils.check.evidence === "NUMBER_FORMAT", JSON.stringify(ils));
  // The owner's case: a dollar Excel statement whose currency format was replaced by "General" (built-in id 0).
  const dollarXlsx = await xlsxWithFormats(["$#,##0.00", "$#,##0.00"], "$#,##0.00");
  const asGeneral = await formatsOf(await asBuiltinFormat(dollarXlsx, 0));
  const dollarAsIs = await formatsOf(dollarXlsx);
  check("XLSX: the dollar statement as exported is refused (FOREIGN) …", dollarAsIs.ok && !dollarAsIs.check.ok && dollarAsIs.check.verdict === "FOREIGN");
  check("…and the SAME workbook with its $ format replaced by General is NOT accepted as shekels (no evidence ⇒ UNVERIFIABLE)",
    asGeneral.ok && asGeneral.check.ok && asGeneral.check.evidence === undefined && !requireIlsEvidence(asGeneral.check.evidence ?? null).ok, JSON.stringify(asGeneral));
  for (const fmt of ["$#,##0.00", "[$USD] #,##0.00", "€ #,##0.00", "[$$-409]#,##0.00"]) {
    const r = await formatsOf(await xlsxWithFormats([fmt, fmt]));
    check(`XLSX: plain numbers formatted "${fmt}" are refused (FOREIGN, NUMBER_FORMAT)`, r.ok && !r.check.ok && r.check.verdict === "FOREIGN" && r.check.signal === "NUMBER_FORMAT", JSON.stringify(r));
  }
  const mixed = await formatsOf(await xlsxWithFormats(['"₪"#,##0.00', '"₪"#,##0.00', "$#,##0.00"]));
  check("XLSX: mixed currencies — two ₪ rows and one $ row — refused at the $ row", mixed.ok && !mixed.check.ok && mixed.check.verdict === "FOREIGN" && mixed.check.rowNumber === 5, JSON.stringify(mixed));
  const balanceUsd = await formatsOf(await xlsxWithFormats([null], "[$USD] #,##0.00"));
  check("XLSX: a USD-formatted BALANCE is refused too", balanceUsd.ok && !balanceUsd.check.ok);
  const unknownToken = await formatsOf(await xlsxWithFormats(["[$XYZ] #,##0.00"]));
  check("XLSX: an unknown currency token in the format is UNVERIFIABLE (refused)", unknownToken.ok && !unknownToken.check.ok && unknownToken.check.verdict === "UNVERIFIABLE", JSON.stringify(unknownToken));
  const locale = await formatsOf(await asBuiltinFormat(await xlsxWithFormats(["$#,##0.00"]), 7));
  check("XLSX: a BUILT-IN currency format (id 7, the viewer's locale currency) is UNVERIFIABLE — ExcelJS alone would report no format at all",
    locale.ok && !locale.check.ok && locale.check.verdict === "UNVERIFIABLE", JSON.stringify(locale));
  const builtinPlain = await formatsOf(await asBuiltinFormat(await xlsxWithFormats(["#,##0.00"]), 4));
  check("XLSX: a built-in plain format (id 4) passes", builtinPlain.ok && builtinPlain.check.ok, JSON.stringify(builtinPlain));
  const broken = await checkXlsxMoneyFormats(Buffer.from("not a zip"), null, { headerRow: 0, headers: ["תאריך", "סכום"], rows: [{ rowNumber: 2, cells: [new Date(), 5] }] }, { date: 0, amount: 1 });
  check("XLSX: formats that cannot be read are UNVERIFIABLE, never assumed plain", !broken.ok && broken.verdict === "UNVERIFIABLE");
}

(async () => {
  realFormatTests();
  fullAccountTests();
  await numberFormatTests();
  currencyGuardTests();
  accountNumberTests();
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
