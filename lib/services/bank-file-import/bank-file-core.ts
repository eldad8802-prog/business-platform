/**
 * Bank file import (milestone B1) — the PURE core: a table read by the data-transfer readers becomes
 * bank statement lines. No Prisma, no tenant, no network; `bank-file-import.service.ts` does the I/O.
 *
 * # One identity for a bank line, whichever path brought it
 *
 * The payables screen already uploads CSV statements (`uploadStatement`, the "old path") and gives every
 * line the identity `statementLineIdentities` computes from what `parseStatementCsv` read. This path writes
 * to the same `ExternalTransaction` table with the same source (OWNER_UPLOAD), so a line must get the SAME
 * identity here as the old path would give it for the same file — otherwise one bank line becomes two rows.
 *
 * So the identity is never computed from the owner's mapping when the old path could have read the file:
 *
 *   - `legacyColumns` finds the columns exactly as `parseStatementCsv` does (its aliases, its header
 *     normalization, its left-to-right first match). When it succeeds, the identity fields — date, amount
 *     or debit/credit, description, reference — are LOCKED to those columns.
 *   - cells are read with the old parser's own `parseStatementDate` / `parseStatementAmount`, trimmed and
 *     cut to 300 characters as it does;
 *   - lines that fail are skipped, as there, so the occurrence counter among identical lines matches.
 *
 * Only fields outside the identity (value date, balance, counterparty) and files the old parser cannot read
 * at all are mapped freely. `bank-file-core.test.ts` runs the old parser on the same CSV files and asserts
 * the same lines and the same identities.
 *
 * Known, accepted divergence from the old parser (a file the old path mangles or refuses anyway): a space
 * before an opening quote, a quoted field spanning lines, a non-comma delimiter, a header that is not the
 * first line, a non-UTF-8 file read by a browser as UTF-8.
 */
import { createHash } from "node:crypto";

import { decodeTableBuffer, parseDelimitedText, type CsvDelimiter, type SheetCell, type SheetTable } from "@/lib/data-transfer/format";
import { normalizeHeaderForMatch } from "@/lib/data-transfer/import/mapping/header-normalize";
import {
  parseStatementAmount,
  parseStatementDate,
  statementLineIdentities,
  type StatementLine,
} from "@/lib/services/payables/payables-p46-core";

export type BankField =
  | "date"
  | "valueDate"
  | "amount"
  | "debit"
  | "credit"
  | "description"
  | "reference"
  | "counterparty"
  | "balance";

export const BANK_FIELDS: readonly BankField[] = [
  "date",
  "valueDate",
  "amount",
  "debit",
  "credit",
  "description",
  "reference",
  "counterparty",
  "balance",
];

/** The fields `statementLineIdentities` hashes (directly, or through the sign of the amount). */
export const IDENTITY_FIELDS: readonly BankField[] = ["date", "amount", "debit", "credit", "description", "reference"];

/** Field → column index. A field that is absent is not mapped. */
export type BankMapping = Partial<Record<BankField, number>>;

export const BANK_MAX_LINES = 10_000;
const HEADER_SEARCH_ROWS = 30;
const TEXT_MAX = 300;

/* ───────────────────────────── the old parser's view ───────────────────────────── */

/** Verbatim from `parseStatementCsv` (payables-p46-core.ts). The parity test fails if they drift apart. */
const LEGACY_HEADER_ALIASES: Record<string, string[]> = {
  date: ["date", "booked", "bookedat", "תאריך", "תאריך ערך", "תאריך פעולה"],
  amount: ["amount", "סכום"],
  debit: ["debit", "חובה", "חיוב"],
  credit: ["credit", "זכות", "זיכוי"],
  description: ["description", "details", "תיאור", "פרטים", "תיאור פעולה"],
  reference: ["reference", "ref", "אסמכתא", "אסמכתה"],
  counterparty: ["counterparty", "payee", "name", "מוטב", "שם", "לטובת"],
};

/**
 * The columns `parseStatementCsv` would pick for this header row, or null when it would refuse the file
 * (no date column, or no amount / debit / credit column).
 */
export function legacyColumns(headers: readonly SheetCell[]): BankMapping | null {
  const header = headers.map((h) =>
    String(h ?? "").trim().toLowerCase().replace(/[\s_]+/g, " ").trim()
  );
  const col: BankMapping = {};
  for (const [key, aliases] of Object.entries(LEGACY_HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h) || aliases.includes(h.replace(/ /g, "")));
    if (idx >= 0) col[key as BankField] = idx;
  }
  if (col.date === undefined) return null;
  if (col.amount === undefined && col.debit === undefined && col.credit === undefined) return null;
  return col;
}

/* ───────────────────────────── proposing a mapping ───────────────────────────── */

/**
 * Header labels per field, compared after `bankHeaderKey` (quotes, separators, case, and a trailing currency
 * mark — "יתרה ₪", "יתרה בש״ח" and "יתרה" are one label). EXACT match only: "סכום עמלה" is not "סכום", so a
 * fee, balance, reference or date column can never be read as the transaction amount by accident.
 */
const BANK_ALIASES: Record<BankField, string[]> = {
  date: ["תאריך", "תאריך פעולה", "תאריך עסקה", "תאריך רישום", "date", "booked", "booking date", "transaction date"],
  valueDate: ["תאריך ערך", "יום ערך", "value date", "valuedate"],
  amount: ["סכום", "סכום פעולה", "זכות/חובה", "חובה/זכות", "amount"],
  debit: ["חובה", "חיוב", "בחובה", "debit", "withdrawal"],
  credit: ["זכות", "זיכוי", "בזכות", "credit", "deposit"],
  description: ["תיאור", "תאור", "פרטים", "תיאור פעולה", "תאור פעולה", "תיאור התנועה", "תאור התנועה", "הפעולה", "description", "details"],
  reference: ["אסמכתא", "אסמכתה", "מס אסמכתא", "מספר אסמכתא", "reference", "ref"],
  counterparty: ["מוטב", "שם", "לטובת", "שם המוטב", "counterparty", "payee", "name"],
  balance: ["יתרה", "balance"],
};

/** Currency marks a bank appends to a column title. Removed only as whole trailing words (or the ₪ sign). */
const CURRENCY_SUFFIXES = new Set(["שח", "בשח", "בש ח", "nis", "ils", "בשקלים"]);

/** The comparison form of a bank header: the shared header normalization, then any trailing currency mark. */
export function bankHeaderKey(raw: unknown): string {
  let key = normalizeHeaderForMatch(typeof raw === "string" ? raw.replace(/₪/g, " ") : String(raw ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  for (;;) {
    const words = key.split(" ");
    if (words.length < 2) break;
    const last = words[words.length - 1];
    const lastTwo = words.slice(-2).join(" ");
    if (CURRENCY_SUFFIXES.has(lastTwo) && words.length > 2) key = words.slice(0, -2).join(" ");
    else if (CURRENCY_SUFFIXES.has(last)) key = words.slice(0, -1).join(" ");
    else break;
  }
  return key;
}

const ALIAS_INDEX: Map<string, BankField> = (() => {
  const m = new Map<string, BankField>();
  for (const field of BANK_FIELDS) {
    for (const alias of BANK_ALIASES[field]) {
      const key = bankHeaderKey(alias);
      if (!m.has(key)) m.set(key, field);
    }
  }
  return m;
})();

/** Every column whose label is an alias of each field, left to right. */
function aliasMatches(headers: readonly SheetCell[]): Partial<Record<BankField, number[]>> {
  const out: Partial<Record<BankField, number[]>> = {};
  headers.forEach((h, idx) => {
    const field = ALIAS_INDEX.get(bankHeaderKey(h));
    if (field) (out[field] ??= []).push(idx);
  });
  return out;
}

/** First column (left to right) whose label is an alias of each field — used only to FIND the header row. */
function aliasColumns(headers: readonly SheetCell[]): BankMapping {
  const out: BankMapping = {};
  for (const [field, cols] of Object.entries(aliasMatches(headers)) as Array<[BankField, number[]]>) out[field] = cols[0];
  return out;
}

export type MappingProposal = {
  mapping: BankMapping;
  /** True when the old parser could read this header: the identity fields are fixed to its columns. */
  legacyLocked: boolean;
  /**
   * Fields the header names more than once (two columns that could each be it), or — for the amount — a
   * signed amount column AND debit / credit columns. None of them is chosen: the owner decides.
   */
  ambiguous: BankField[];
};

/**
 * The mapping to propose for a header row. Identity fields come from `legacyColumns` when it succeeds — the
 * old parser's own choice, kept verbatim so both upload paths give a line one identity; the rest (and
 * everything, when it does not) from the wider alias list, where a field is proposed only when exactly ONE
 * column names it. A file with only a value-date column uses it as the booking date too, exactly as the old
 * parser does.
 */
export function proposeBankMapping(headers: readonly SheetCell[]): MappingProposal {
  const legacy = legacyColumns(headers);
  const matches = aliasMatches(headers);
  const ambiguous = new Set<BankField>();
  const unique = (f: BankField): number | undefined => {
    const cols = matches[f] ?? [];
    if (cols.length > 1) ambiguous.add(f);
    return cols.length === 1 ? cols[0] : undefined;
  };
  const mapping: BankMapping = {};
  if (legacy) {
    for (const f of IDENTITY_FIELDS) if (legacy[f] !== undefined) mapping[f] = legacy[f];
    if (legacy.counterparty !== undefined) mapping.counterparty = legacy.counterparty;
    // The old parser's column stays (the payables upload reads the same file the same way, one identity), but
    // another column that could be the same field — or the amount besides debit / credit — is reported, so the
    // owner sees which one is used before anything is written.
    for (const f of IDENTITY_FIELDS) {
      const others = (matches[f] ?? []).filter((c) => c !== legacy[f]);
      if (others.length > 0) ambiguous.add(f === "debit" || f === "credit" ? "amount" : f);
    }
    const amountish = (["amount", "debit", "credit"] as const).filter((f) => (matches[f] ?? []).length > 0);
    if (amountish.includes("amount") && amountish.length > 1) ambiguous.add("amount");
  } else {
    for (const f of IDENTITY_FIELDS) {
      const col = unique(f);
      if (col !== undefined) mapping[f] = col;
    }
    // A signed amount column beside debit / credit columns: two readings of the same money. Pick neither.
    if (mapping.amount !== undefined && (mapping.debit !== undefined || mapping.credit !== undefined)) {
      delete mapping.amount;
      delete mapping.debit;
      delete mapping.credit;
      ambiguous.add("amount");
    }
    const valueDate = unique("valueDate");
    if (mapping.date === undefined && !ambiguous.has("date") && valueDate !== undefined) mapping.date = valueDate;
  }
  if (mapping.counterparty === undefined) {
    const col = unique("counterparty");
    if (col !== undefined) mapping.counterparty = col;
  }
  const valueDate = unique("valueDate");
  if (valueDate !== undefined) mapping.valueDate = valueDate;
  const balance = unique("balance");
  if (balance !== undefined) mapping.balance = balance;
  return { mapping, legacyLocked: legacy !== null, ambiguous: [...ambiguous] };
}

export type MappingProblem =
  | "DATE_REQUIRED"
  | "AMOUNT_REQUIRED"
  | "COLUMN_OUT_OF_RANGE"
  | "COLUMN_USED_TWICE"
  | "IDENTITY_FIELD_LOCKED";

/**
 * Apply the owner's changes to the proposal. Identity fields cannot move away from the old parser's
 * columns when it could read the file (that is what keeps both paths on one identity).
 */
export function resolveBankMapping(
  headers: readonly SheetCell[],
  override: BankMapping | null | undefined
): { ok: true; mapping: BankMapping; legacyLocked: boolean } | { ok: false; problem: MappingProblem; field?: BankField; mapping: BankMapping } {
  const proposal = proposeBankMapping(headers);
  const mapping: BankMapping = { ...proposal.mapping };
  if (override) {
    for (const field of BANK_FIELDS) {
      if (!(field in override)) continue;
      const value = override[field];
      if (proposal.legacyLocked && (IDENTITY_FIELDS as readonly string[]).includes(field)) {
        if (value !== proposal.mapping[field]) return { ok: false, problem: "IDENTITY_FIELD_LOCKED", field, mapping };
        continue;
      }
      if (value === undefined || value === null) delete mapping[field];
      else mapping[field] = value;
    }
  }
  const used = new Map<number, BankField>();
  for (const field of BANK_FIELDS) {
    const idx = mapping[field];
    if (idx === undefined) continue;
    if (!Number.isInteger(idx) || idx < 0 || idx >= headers.length) return { ok: false, problem: "COLUMN_OUT_OF_RANGE", field, mapping };
    // The old parser may read one column as two fields (a value-date column as the booking date); allow
    // exactly that pairing, refuse any other reuse.
    const prior = used.get(idx);
    if (prior && !(prior === "date" && field === "valueDate")) return { ok: false, problem: "COLUMN_USED_TWICE", field, mapping };
    used.set(idx, field);
  }
  if (mapping.date === undefined) return { ok: false, problem: "DATE_REQUIRED", field: "date", mapping };
  if (mapping.amount === undefined && mapping.debit === undefined && mapping.credit === undefined) {
    return { ok: false, problem: "AMOUNT_REQUIRED", field: "amount", mapping };
  }
  return { ok: true, mapping, legacyLocked: proposal.legacyLocked };
}

/** A stable digest of the mapping and everything else that decides what the file becomes. */
export function bankMappingHash(input: { mapping: BankMapping; accountId: number; sheetName: string | null; headerRow: number }): string {
  const fields = BANK_FIELDS.filter((f) => input.mapping[f] !== undefined).map((f) => `${f}=${input.mapping[f]}`);
  const canonical = ["bank_statement:v1", `account=${input.accountId}`, `sheet=${input.sheetName ?? ""}`, `header=${input.headerRow}`, ...fields].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/* ───────────────────────────── reading a CSV statement ───────────────────────────── */

/**
 * A CSV statement as a table, WITHOUT trimming rows to the first row's width. The data-transfer CSV reader
 * makes its first non-empty row the header and cuts every row to that width — right for the import hub, wrong
 * for a bank export that opens with an account line or a title above the real table (the columns past the
 * first would be lost before the header is even searched for). Same decoding (BOM, UTF-16, strict UTF-8 then
 * windows-1255) and the same RFC 4180 parser; rows are padded to the widest row instead. The delimiter is
 * chosen from the top rows (see `detectBankDelimiter`), not from the first line alone, which may be a title.
 */
export function readBankCsvTable(bytes: Buffer, maxRows?: number): SheetTable {
  const decoded = decodeTableBuffer(bytes);
  const delimiter = detectBankDelimiter(decoded.text);
  const parsed = parseDelimitedText(decoded.text, {
    ...(maxRows === undefined ? {} : { maxRows }),
    ...(delimiter ? { delimiter } : {}),
  });
  const width = parsed.rows.reduce((w, r) => Math.max(w, r.length), 0);
  const pad = (r: string[]) => Array.from({ length: width }, (_, c) => r[c] ?? "");
  const [first, ...rest] = parsed.rows;
  return {
    sheetName: null,
    headers: first ? pad(first).map((h) => h.trim()) : [],
    rows: rest.map(pad),
    truncated: parsed.truncated,
    delimiter: parsed.delimiter,
    encoding: decoded.encoding,
  };
}

const DELIMITERS: readonly CsvDelimiter[] = [",", ";", "	"];
const DELIMITER_SAMPLE_ROWS = 40;

/**
 * The delimiter that splits the top rows into the most rows of one common width (three columns or more). A
 * title line above the table has no delimiter at all, so judging by the first line alone (the import hub's
 * rule) would read a Tab file as one column. An explicit "sep=" line wins (null: let the parser honour it);
 * no candidate splits two rows alike ⇒ null, the import hub's own detection.
 */
export function detectBankDelimiter(text: string): CsvDelimiter | null {
  if (/^s*sep=/i.test(text)) return null;
  let best: CsvDelimiter | null = null;
  let bestScore = 1;
  for (const d of DELIMITERS) {
    const rows = parseDelimitedText(text, { delimiter: d, maxRows: DELIMITER_SAMPLE_ROWS }).rows;
    const widths = new Map<number, number>();
    for (const r of rows) if (r.length >= 3) widths.set(r.length, (widths.get(r.length) ?? 0) + 1);
    const score = Math.max(0, ...widths.values());
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/* ───────────────────────────── locating the header ───────────────────────────── */

export type LocatedTable = {
  /** 0-based index of the header row in the grid (the table's header row is grid row 0). */
  headerRow: number;
  headers: SheetCell[];
  /** Data rows with their 1-based row number in the grid — the number shown to the owner. */
  rows: Array<{ rowNumber: number; cells: SheetCell[] }>;
};

/**
 * Bank exports often start with a few lines about the account before the column titles. The grid is the
 * table's header row followed by its data rows, so a file whose first line is the header gives `headerRow` 0,
 * as the old parser expects. Three passes over the top rows, the first that finds a row wins:
 *   1. a row that names a date column and an amount column (the old parser's header, or the alias list);
 *   2. a row that names a date column, with at least three text titles — the amount is mapped by the owner;
 *   3. a row of at least three text titles (no number, no date) followed by a row holding a date — titles
 *      Dubiz does not know at all; every field is mapped by the owner.
 * Nothing found ⇒ null: not a bank statement table (or unreadable), never "a header we did not recognise".
 */
export function locateHeader(table: SheetTable): LocatedTable | null {
  const grid: SheetCell[][] = [table.headers, ...table.rows];
  const limit = Math.min(grid.length, HEADER_SEARCH_ROWS);
  const at = (i: number): LocatedTable => ({
    headerRow: i,
    headers: grid[i].map((c) => (typeof c === "string" ? c.trim() : c)),
    rows: grid.slice(i + 1).map((cells, j) => ({ rowNumber: i + j + 2, cells })),
  });
  const titles = (row: SheetCell[]) =>
    row.filter((c) => typeof c === "string" && c.trim() !== "" && readDateCell(c) === null && readAmountCell(c) === null).length;
  const isTitleRow = (row: SheetCell[]) =>
    row.every((c) => c === null || (typeof c === "string" && (c.trim() === "" || (readDateCell(c) === null && readAmountCell(c) === null))));

  for (let i = 0; i < limit; i += 1) {
    const candidate = grid[i];
    const legacy = legacyColumns(candidate);
    const alias = aliasColumns(candidate);
    const hasDate = legacy !== null || alias.date !== undefined || alias.valueDate !== undefined;
    const hasAmount = legacy !== null || alias.amount !== undefined || alias.debit !== undefined || alias.credit !== undefined;
    if (hasDate && hasAmount) return at(i);
  }
  for (let i = 0; i < limit; i += 1) {
    const alias = aliasColumns(grid[i]);
    if ((alias.date !== undefined || alias.valueDate !== undefined) && titles(grid[i]) >= 3 && isTitleRow(grid[i])) return at(i);
  }
  for (let i = 0; i + 1 < limit; i += 1) {
    if (titles(grid[i]) >= 3 && isTitleRow(grid[i]) && grid[i + 1].some((c) => readDateCell(c) !== null)) return at(i);
  }
  return null;
}

/* ───────────────────────────── reading cells ───────────────────────────── */

/** Excel's day 0 is 1899-12-30; serials in this range are dates between 1954 and 2119. */
function fromExcelSerial(n: number): Date | null {
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0));
}

/** A cell as a statement date at noon UTC, as `parseStatementDate` returns it. */
export function readDateCell(cell: SheetCell): Date | null {
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return null;
    return new Date(Date.UTC(cell.getUTCFullYear(), cell.getUTCMonth(), cell.getUTCDate(), 12, 0, 0));
  }
  if (typeof cell === "number") return fromExcelSerial(cell);
  if (typeof cell === "string") return parseStatementDate(cell.trim());
  return null;
}

/** A cell as signed minor units, as `parseStatementAmount` returns it; null when it is not money. */
export function readAmountCell(cell: SheetCell): number | null {
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return null;
    const minor = Math.round(cell * 100);
    // More than two decimals is not an amount a bank prints.
    if (Math.abs(cell * 100 - minor) > 1e-6) return null;
    return minor;
  }
  if (typeof cell === "string") return parseStatementAmount(cell);
  return null;
}

function readTextCell(cell: SheetCell): string | null {
  if (cell === null || cell === undefined) return null;
  const raw = cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell);
  const v = raw.trim();
  return v === "" ? null : v.slice(0, TEXT_MAX);
}

/* ───────────────────────────── rows → lines ───────────────────────────── */

export type BankLine = StatementLine & {
  /** 1-based row in the grid (see `locateHeader`). */
  rowNumber: number;
  valueDate: Date | null;
  balanceMinor: number | null;
};

export type RowProblem = { rowNumber: number; field: "date" | "amount" | "valueDate" | "balance" };

export type NormalizedFile = {
  lines: BankLine[];
  /** Rows that were skipped (date or amount unreadable) — the field only, never the content. */
  errors: RowProblem[];
  /** Rows kept with an optional field dropped (value date or balance unreadable). */
  warnings: RowProblem[];
};

/**
 * Turn the located rows into lines. A row whose date or amount cannot be read is skipped and reported, as
 * the old parser does; an unreadable value date or balance only drops that field.
 */
export function normalizeBankRows(located: LocatedTable, mapping: BankMapping): NormalizedFile {
  const lines: BankLine[] = [];
  const errors: RowProblem[] = [];
  const warnings: RowProblem[] = [];
  const cell = (cells: SheetCell[], f: BankField): SheetCell =>
    mapping[f] !== undefined ? (cells[mapping[f] as number] ?? null) : null;

  for (const { rowNumber, cells } of located.rows) {
    // A row of empty cells is not a line (and the old parser never sees one).
    if (cells.every((c) => c === null || (typeof c === "string" && c.trim() === ""))) continue;

    const bookedAt = readDateCell(cell(cells, "date"));
    if (!bookedAt) {
      errors.push({ rowNumber, field: "date" });
      continue;
    }
    let signed: number | null = null;
    if (mapping.amount !== undefined) {
      signed = readAmountCell(cell(cells, "amount"));
    } else {
      const debit = mapping.debit !== undefined ? readAmountCell(cell(cells, "debit")) : null;
      const credit = mapping.credit !== undefined ? readAmountCell(cell(cells, "credit")) : null;
      if (debit && Math.abs(debit) > 0) signed = -Math.abs(debit);
      else if (credit && Math.abs(credit) > 0) signed = Math.abs(credit);
    }
    if (signed === null || signed === 0) {
      errors.push({ rowNumber, field: "amount" });
      continue;
    }

    let valueDate: Date | null = null;
    if (mapping.valueDate !== undefined) {
      const raw = cell(cells, "valueDate");
      if (raw !== null && !(typeof raw === "string" && raw.trim() === "")) {
        valueDate = readDateCell(raw);
        if (!valueDate) warnings.push({ rowNumber, field: "valueDate" });
      }
    }
    let balanceMinor: number | null = null;
    if (mapping.balance !== undefined) {
      const raw = cell(cells, "balance");
      if (raw !== null && !(typeof raw === "string" && raw.trim() === "")) {
        balanceMinor = readAmountCell(raw);
        if (balanceMinor === null) warnings.push({ rowNumber, field: "balance" });
      }
    }

    lines.push({
      lineNumber: rowNumber,
      rowNumber,
      bookedAt,
      amountMinor: Math.abs(signed),
      direction: signed < 0 ? "DEBIT" : "CREDIT",
      description: readTextCell(cell(cells, "description")),
      reference: readTextCell(cell(cells, "reference")),
      counterpartyName: readTextCell(cell(cells, "counterparty")),
      valueDate,
      balanceMinor,
    });
  }
  return { lines, errors, warnings };
}

/* ───────────────────────────── balance chain ───────────────────────────── */

export type BalanceCheck =
  | { status: "NOT_AVAILABLE" }
  | { status: "OK"; order: "OLDEST_FIRST" | "NEWEST_FIRST"; checked: number }
  | { status: "BROKEN"; order: "OLDEST_FIRST" | "NEWEST_FIRST"; checked: number; breaks: number[] };

/**
 * previous balance ± amount = balance, line after line. Banks list oldest-first or newest-first, so both
 * orders are tried and the one with fewer breaks is reported. A break names the row where the running
 * balance stops adding up — a missing, duplicated or misread line nearby.
 */
export function checkBalanceChain(lines: readonly BankLine[]): BalanceCheck {
  const withBalance = lines.filter((l) => l.balanceMinor !== null);
  if (withBalance.length < 2) return { status: "NOT_AVAILABLE" };
  const signed = (l: BankLine) => (l.direction === "CREDIT" ? l.amountMinor : -l.amountMinor);

  const oldestFirst: number[] = [];
  const newestFirst: number[] = [];
  for (let i = 1; i < withBalance.length; i += 1) {
    const prev = withBalance[i - 1];
    const cur = withBalance[i];
    if ((prev.balanceMinor as number) + signed(cur) !== cur.balanceMinor) oldestFirst.push(cur.rowNumber);
    if ((cur.balanceMinor as number) + signed(prev) !== prev.balanceMinor) newestFirst.push(prev.rowNumber);
  }
  const order = newestFirst.length < oldestFirst.length ? "NEWEST_FIRST" : "OLDEST_FIRST";
  const breaks = order === "NEWEST_FIRST" ? newestFirst : oldestFirst;
  const checked = withBalance.length - 1;
  return breaks.length === 0 ? { status: "OK", order, checked } : { status: "BROKEN", order, checked, breaks };
}

/* ───────────────────────────── identities ───────────────────────────── */

/**
 * Both identities of every line: under the chosen account (what this path writes) and with no account
 * (what the old path wrote when the owner did not pick one). The same function the old path uses.
 */
export function bankLineIdentities(
  businessId: number,
  accountId: number,
  lines: readonly BankLine[]
): { withAccount: string[]; withoutAccount: string[] } {
  return {
    withAccount: statementLineIdentities(businessId, accountId, [...lines]),
    withoutAccount: statementLineIdentities(businessId, null, [...lines]),
  };
}

/** How many lines repeat an earlier line of the same file exactly (kept as separate lines, as today). */
export function countRepeatedLines(lines: readonly BankLine[]): number {
  const seen = new Set<string>();
  let repeated = 0;
  for (const l of lines) {
    const key = [
      l.bookedAt.toISOString().slice(0, 10),
      l.direction,
      l.amountMinor,
      l.reference ?? "",
      (l.description ?? "").replace(/\s+/g, " ").toLowerCase(),
    ].join("|");
    if (seen.has(key)) repeated += 1;
    else seen.add(key);
  }
  return repeated;
}

export function contentHashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
