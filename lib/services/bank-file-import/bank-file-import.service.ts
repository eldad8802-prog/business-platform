/**
 * Bank file import (milestone B1) — analyze, then commit, an owner-uploaded bank statement. SERVER-ONLY.
 *
 *   analyze   reads the file (data-transfer readers: CSV in any encoding they detect, XLSX), finds the
 *             header, proposes a mapping, normalizes the lines and classifies each one against what
 *             Dubiz already holds. Writes NOTHING. Returns a signed token that binds this business, this
 *             user, this account, these exact bytes and this exact mapping — no row values.
 *   commit    the owner sends the same file, the token and a decision for every suspected line back. Under
 *             one transaction and a per-business lock: the run is opened (or found — a replay reports the
 *             first outcome), certain duplicates are excluded, suspected lines follow the owner's decision,
 *             the rest is inserted, the run is closed, one audit event is written. All of it or none of it.
 *
 * Where it writes: `ExternalTransaction` only, through the same columns, source (OWNER_UPLOAD) and line
 * identity as the payables upload (`uploadStatement`); `ImportRun` for the run summary, the file's hash
 * and the hash of the owner's decisions (the file itself is not kept); `PayablesAuditEvent` through
 * `writeAudit`. Nothing else. No existing line is ever changed or removed.
 *
 * Duplicates — the rule (owner, 2026-10-25): a real bank line is never lost to avoid a possible duplicate.
 *   - EXISTING  (certain): the line's identity WITH the chosen account already exists — the same account,
 *               the same facts, the same occurrence. Skipped; this is the existing identity mechanism.
 *   - SUSPECTED (uncertain): only its identity WITHOUT an account exists — a line uploaded earlier with no
 *               account chosen. That row says nothing about which account it came from, so it may be this
 *               line or a real, identical line of another account (the same fee on the same day). Never
 *               skipped silently: the owner decides IMPORT or SKIP for each one, there is no default, and a
 *               commit without a decision for every suspected line is refused.
 *   - the insert is ON CONFLICT DO NOTHING on (business, source, externalId);
 *   - commits for one business serialise on `bank-lines-ingest:<businessId>`.
 *
 * Guards (2026-11-03) — checked on analyze AND again on every commit, server-side:
 *   - FOREIGN_CURRENCY: shekel statements only. A currency column, a currency mark in a money cell, or a
 *     foreign currency in the titles refuses the file; nothing is converted (bank-file-core.ts, checkFileCurrency).
 *     CURRENCY_UNVERIFIABLE: a currency Dubiz cannot classify or confirm (an unknown currency value, an unknown
 *     number-format token, Excel's locale currency formats, number formats that cannot be read) — refused too.
 *   - ACCOUNT_NUMBER_MISMATCH: an account number the file prints that is not the chosen account's — the FULL
 *     account (bank, branch, account) compared by the account's keyed fingerprint when the file prints it, else
 *     the last four digits (compareAccountNumber). VERIFIED_FULL only for a full comparison; PARTIAL_MATCH (last
 *     four) and NOT_IN_FILE are never called verified, and the owner confirms the account either way.
 *   - ACCOUNT_CONFIRMATION_REQUIRED / _MISMATCH: the commit must name the account the owner saw on the preview,
 *     and it must be the account the token was issued for.
 *   - CROSS_ACCOUNT_CONFIRMATION_REQUIRED: lines this import would write that the business already holds under
 *     ANOTHER of its accounts (the file may be uploaded to the wrong account) are shown on the preview; the
 *     commit must confirm exactly how many, or it is refused.
 * The duplicate mechanism above is unchanged; the guards only refuse, they never write or skip a line.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";
import { readImportSource } from "@/lib/data-transfer/import/import-source";
import { IMPORT_MAX_ROWS, IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";
import {
  BANK_STATEMENT_RUN_DOMAIN,
  completeBankStatementRunInTx,
  findBankStatementRunInTx,
  lastBankStatementImportInTx,
  openBankStatementRunInTx,
  retryKeyOf,
} from "@/lib/data-transfer/import/execute/import-run-store";
import { signEnvelope, verifyEnvelope, type EnvelopeSpec } from "@/lib/data-transfer/import/preview/signed-envelope";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { fingerprintBankCoordinates, isBankCryptoConfigured, maskAccount } from "@/lib/services/payables/payables-bank-crypto";
import { fromMinorUnits } from "@/lib/services/payables/payables-core";
import { writeAudit } from "@/lib/services/payables/payables.service";
import {
  BANK_MAX_LINES,
  bankLineIdentities,
  bankLineIdentitiesUnder,
  checkFileCurrency,
  compareAccountNumber,
  fileAccountNumbers,
  bankMappingHash,
  checkBalanceChain,
  contentHashOf,
  countRepeatedLines,
  locateHeader,
  normalizeBankRows,
  proposeBankMapping,
  readBankCsvTable,
  resolveBankMapping,
  type AccountNumberCheck,
  type CurrencyCheck,
  type PrintedAccount,
  type BalanceCheck,
  type BankField,
  type BankLine,
  type BankMapping,
  type MappingProblem,
  type RowProblem,
} from "./bank-file-core";
import { checkXlsxMoneyFormats } from "./xlsx-number-formats";

export const BANK_IMPORT_DOMAIN = BANK_STATEMENT_RUN_DOMAIN;
const SOURCE = "OWNER_UPLOAD" as const;
const PREVIEW_ROWS = 200;
const ID_CHUNK = 1000;

const TOKEN_SPEC: EnvelopeSpec = {
  keyLabel: "dubiz:bank-file-import:v1",
  purpose: "bank-file-import",
  version: 1,
  ttlSeconds: IMPORT_PREVIEW_TTL_SECONDS,
};

export type BankImportErrorCode =
  | "FILE_UNREADABLE"
  | "HEADER_NOT_FOUND"
  | "MAPPING_INVALID"
  | "TOO_MANY_LINES"
  | "NO_LINES"
  | "ACCOUNT_REQUIRED"
  | "ACCOUNT_NOT_FOUND"
  | "TOKEN_INVALID"
  | "FILE_CHANGED"
  | "DECISIONS_INVALID"
  | "DECISIONS_REQUIRED"
  | "FOREIGN_CURRENCY"
  | "CURRENCY_UNVERIFIABLE"
  | "ACCOUNT_NUMBER_MISMATCH"
  | "ACCOUNT_CONFIRMATION_REQUIRED"
  | "ACCOUNT_CONFIRMATION_MISMATCH"
  | "CROSS_ACCOUNT_CONFIRMATION_REQUIRED";

export class BankImportError extends Error {
  constructor(
    public readonly code: BankImportErrorCode,
    public readonly status: number,
    public readonly detail: Record<string, string | number> = {}
  ) {
    super(code);
    this.name = "BankImportError";
  }
}

/** The owner's choice for one suspected line, keyed by its row number. */
export type SuspectDecision = "IMPORT" | "SKIP";
export type SuspectDecisions = Record<number, SuspectDecision>;

export type BankImportInput = {
  businessId: number;
  userId: number;
  accountId: number | null;
  filename: string;
  bytes: Buffer;
  sheetName?: string | null;
  mapping?: BankMapping | null;
};

type Prepared = {
  accountId: number;
  contentHash: string;
  mappingHash: string;
  sheetName: string | null;
  headerRow: number;
  headers: string[];
  mapping: BankMapping;
  legacyLocked: boolean;
  /** Account numbers the file itself prints (title rows / an account column); compared with the chosen account. */
  accountNumbers: string[];
  lines: BankLine[];
  errors: RowProblem[];
  warnings: RowProblem[];
  identities: { withAccount: string[]; withoutAccount: string[] };
};

/** The header was found but the mapping is not complete: what the owner needs to finish it. No token. */
export type BankMappingRequired = {
  status: "MAPPING_REQUIRED";
  sheetName: string | null;
  headerRow: number;
  headers: string[];
  /** What could be proposed (or what the owner sent): complete it, do not start over. */
  mapping: BankMapping;
  lockedFields: BankField[];
  /** Fields more than one column could be — never chosen automatically. */
  ambiguous: BankField[];
  /** Required fields still unmapped: the date, and the amount (signed, or debit / credit). */
  missing: Array<"date" | "amount">;
  /** Why the last mapping was not accepted, when the owner sent one. */
  problem: MappingProblem | null;
  field: BankField | null;
  /** Up to three values per column, so the owner recognises it. Their own data, never stored or logged. */
  samples: string[][];
};

class MappingRequiredSignal extends Error {
  constructor(
    public readonly payload: BankMappingRequired,
    public readonly accountNumbers: string[]
  ) {
    super("MAPPING_REQUIRED");
  }
}

function mappingRequired(
  sheetName: string | null,
  located: ReturnType<typeof locateHeader> & object,
  resolved: { problem: MappingProblem; field?: BankField; mapping: BankMapping }
): BankMappingRequired {
  const proposal = proposeBankMapping(located.headers);
  const missing: Array<"date" | "amount"> = [];
  if (resolved.mapping.date === undefined) missing.push("date");
  if (resolved.mapping.amount === undefined && resolved.mapping.debit === undefined && resolved.mapping.credit === undefined) missing.push("amount");
  const samples = located.headers.map((_, col) =>
    located.rows
      .map((r) => r.cells[col])
      .filter((c) => c !== null && c !== undefined && String(c).trim() !== "")
      .slice(0, 3)
      .map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim()).slice(0, 40))
  );
  const solelyIncomplete = resolved.problem === "DATE_REQUIRED" || resolved.problem === "AMOUNT_REQUIRED";
  return {
    status: "MAPPING_REQUIRED",
    sheetName,
    headerRow: located.headerRow,
    headers: located.headers.map((h) => (h === null || h === undefined ? "" : String(h))),
    mapping: resolved.mapping,
    lockedFields: proposal.legacyLocked ? (["date", "amount", "debit", "credit", "description", "reference"] as BankField[]) : [],
    ambiguous: proposal.ambiguous,
    missing,
    problem: solelyIncomplete ? null : resolved.problem,
    field: solelyIncomplete ? null : resolved.field ?? null,
    samples,
  };
}

/** Read, locate, map, normalize. Pure apart from reading the bytes it was handed. */
async function prepare(input: BankImportInput): Promise<Prepared> {
  if (!input.accountId || !Number.isInteger(input.accountId) || input.accountId <= 0) {
    throw new BankImportError("ACCOUNT_REQUIRED", 400);
  }
  const source = await readImportSource({ filename: input.filename, bytes: input.bytes, sheetName: input.sheetName ?? null });
  if (!source.ok) {
    throw new BankImportError("FILE_UNREADABLE", 400, { reason: source.code, message: source.message });
  }
  // readImportSource has validated the upload (size, type, row limit, a real CSV / XLSX). A CSV is read again
  // without the import hub's trim to the first row's width, so a title line above the table loses nothing.
  const table = source.kind === "csv" ? readBankCsvTable(input.bytes, IMPORT_MAX_ROWS + 1) : source.table;
  const located = locateHeader(table);
  if (!located) throw new BankImportError("HEADER_NOT_FOUND", 400);

  // Shekels only (bank-file-core.ts, checkFileCurrency): a foreign-currency statement is refused before any
  // mapping is asked for — and again on every commit, which runs this same function on the same bytes.
  assertShekels(checkFileCurrency(table, located, null));
  const accountNumbers = fileAccountNumbers(table, located);

  const resolved = resolveBankMapping(located.headers, input.mapping ?? null);
  if (!resolved.ok) {
    // A readable table with a header row whose required fields are missing, doubled or ambiguous: not a broken
    // file — the owner completes the mapping (analyze answers MAPPING_REQUIRED). The old parser's locked
    // columns are the one thing that cannot be re-mapped.
    if (resolved.problem !== "IDENTITY_FIELD_LOCKED") {
      throw new MappingRequiredSignal(mappingRequired(source.sheetName, located, resolved), accountNumbers);
    }
    throw new BankImportError("MAPPING_INVALID", 400, { problem: resolved.problem, ...(resolved.field ? { field: resolved.field } : {}) });
  }
  assertShekels(checkFileCurrency(table, located, resolved.mapping));
  // Excel: the money cells' NUMBER FORMATS too (a "$#,##0.00" cell holds a plain number).
  if (source.kind === "xlsx") assertShekels(await checkXlsxMoneyFormats(input.bytes, source.sheetName, located, resolved.mapping));
  const normalized = normalizeBankRows(located, resolved.mapping);
  if (normalized.lines.length > BANK_MAX_LINES) {
    throw new BankImportError("TOO_MANY_LINES", 400, { max: BANK_MAX_LINES });
  }
  return {
    accountId: input.accountId,
    contentHash: contentHashOf(input.bytes),
    mappingHash: bankMappingHash({ mapping: resolved.mapping, accountId: input.accountId, sheetName: source.sheetName, headerRow: located.headerRow }),
    sheetName: source.sheetName,
    headerRow: located.headerRow,
    headers: located.headers.map((h) => (h === null || h === undefined ? "" : String(h))),
    mapping: resolved.mapping,
    legacyLocked: resolved.legacyLocked,
    accountNumbers,
    lines: normalized.lines,
    errors: normalized.errors,
    warnings: normalized.warnings,
    identities: bankLineIdentities(input.businessId, input.accountId, normalized.lines),
  };
}

/** FOREIGN ⇒ FOREIGN_CURRENCY; UNVERIFIABLE (a currency Dubiz cannot classify or confirm) ⇒ CURRENCY_UNVERIFIABLE. */
function assertShekels(check: CurrencyCheck): void {
  if (check.ok) return;
  throw new BankImportError(check.verdict === "FOREIGN" ? "FOREIGN_CURRENCY" : "CURRENCY_UNVERIFIABLE", 400, {
    signal: check.signal,
    currency: check.currency,
    ...(check.rowNumber !== null ? { row: check.rowNumber } : {}),
  });
}

/** The chosen account: label and last four for the screen; the fingerprint only to compare, never returned. */
type ChosenAccount = { id: number; label: string; accountLast4: string; fingerprint: string };

async function assertAccount(tx: TenantTx, businessId: number, accountId: number): Promise<ChosenAccount> {
  const account = await tx.businessBankAccount.findFirst({
    where: { id: accountId, businessId, isActive: true },
    select: { id: true, label: true, accountLast4: true, fingerprint: true },
  });
  if (!account) throw new BankImportError("ACCOUNT_NOT_FOUND", 404);
  return account;
}

/**
 * Is a full printed account (bank, branch, account — digits as text) the chosen account? Answered with the
 * account's keyed fingerprint (payables-bank-crypto.ts, fingerprintBankCoordinates, purpose
 * BUSINESS_BANK_ACCOUNT): the same identity the bank-account service uses to refuse an account entered twice.
 * Nothing is decrypted, and the printed number never leaves this function. null (cannot know) when the keys are
 * not configured or the printed account is not a valid one — the comparison then falls back to the last four
 * digits, which is never called verified.
 */
function fullAccountMatcher(businessId: number, account: ChosenAccount): (printed: PrintedAccount) => boolean | null {
  return (printed) => {
    if (!isBankCryptoConfigured()) return null;
    try {
      const fp = Buffer.from(fingerprintBankCoordinates(printed, businessId, "BUSINESS_BANK_ACCOUNT"), "utf8");
      const stored = Buffer.from(account.fingerprint, "utf8");
      return fp.length === stored.length && timingSafeEqual(fp, stored);
    } catch {
      return null;
    }
  };
}

/**
 * The account number the file prints must be the chosen account's (bank-file-core.ts, compareAccountNumber):
 * VERIFIED_FULL / PARTIAL_MATCH / NOT_IN_FILE pass (the owner confirms the account on every commit anyway);
 * MISMATCH is refused. Only last-four digits are ever returned — never a full number, in a response or a log.
 */
function assertAccountNumber(businessId: number, accountNumbers: string[], account: ChosenAccount): AccountNumberCheck {
  const check = compareAccountNumber(accountNumbers, account.accountLast4, fullAccountMatcher(businessId, account));
  if (check.status === "MISMATCH") {
    throw new BankImportError("ACCOUNT_NUMBER_MISMATCH", 409, {
      fileLast4: check.fileLast4,
      accountLast4: account.accountLast4,
      basis: check.basis,
    });
  }
  return check;
}

export type CrossAccountSignal = {
  /** Lines this import would write that the business already holds under ANOTHER of its accounts. */
  lines: number;
  accounts: Array<{ id: number; label: string; masked: string }>;
};

/**
 * Lines of this file that already exist under a DIFFERENT account of the same business (the identity is the
 * same facts with that account in place of the chosen one). A file uploaded to the wrong account makes every
 * line NEW under it — this is how that shows. Counted only for lines this import would write (NEW or
 * SUSPECTED); a line already held under the chosen account is a certain duplicate and is not written anyway.
 * Archived accounts count too: their lines are still held. Tenant-scoped like every read here.
 */
async function crossAccountSignal(tx: TenantTx, businessId: number, prepared: Prepared, statuses: LineStatus[]): Promise<CrossAccountSignal> {
  const others = await tx.businessBankAccount.findMany({
    where: { businessId, id: { not: prepared.accountId } },
    select: { id: true, label: true, accountLast4: true },
    orderBy: { id: "asc" },
  });
  if (others.length === 0 || prepared.lines.length === 0) return { lines: 0, accounts: [] };
  const perAccount = others.map((a) => ({ account: a, ids: bankLineIdentitiesUnder(businessId, a.id, prepared.lines) }));
  const known = await existingIds(tx, businessId, perAccount.flatMap((p) => p.ids));
  const rows = new Set<number>();
  const accounts: CrossAccountSignal["accounts"] = [];
  for (const { account, ids } of perAccount) {
    let hit = false;
    ids.forEach((id, i) => {
      if (statuses[i] === "EXISTING" || !known.has(id)) return;
      rows.add(i);
      hit = true;
    });
    if (hit) accounts.push({ id: account.id, label: account.label, masked: maskAccount(account.accountLast4) });
  }
  return { lines: rows.size, accounts };
}

/** The externalIds among `ids` that this business already holds from an owner upload. */
async function existingIds(tx: TenantTx, businessId: number, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const rows = await tx.externalTransaction.findMany({
      where: { businessId, source: SOURCE, externalId: { in: unique.slice(i, i + ID_CHUNK) } },
      select: { externalId: true },
    });
    for (const r of rows) found.add(r.externalId);
  }
  return found;
}

export type LineStatus = "NEW" | "EXISTING" | "SUSPECTED";

/** See the module note: certain duplicates by the existing identity; a "no account" match is only a suspicion. */
function classify(prepared: Prepared, known: Set<string>): LineStatus[] {
  return prepared.lines.map((_, i) => {
    if (known.has(prepared.identities.withAccount[i])) return "EXISTING";
    if (known.has(prepared.identities.withoutAccount[i])) return "SUSPECTED";
    return "NEW";
  });
}

/** Canonical form of the decisions (sorted by row), hashed: audit evidence and the identity of a re-decision. */
export function decisionsHashOf(decisions: SuspectDecisions): string {
  const canonical = Object.keys(decisions)
    .map(Number)
    .sort((a, b) => a - b)
    .map((row) => `${row}=${decisions[row]}`)
    .join("\n");
  return createHash("sha256").update(`bank_statement:decisions:v1\n${canonical}`, "utf8").digest("hex");
}

/* ─────────────────────────────── analyze ─────────────────────────────── */

export type BankPreviewLine = {
  rowNumber: number;
  status: LineStatus;
  bookedAt: string;
  valueDate: string | null;
  direction: "DEBIT" | "CREDIT";
  amountMinor: number;
  description: string | null;
  reference: string | null;
  counterpartyName: string | null;
  balanceMinor: number | null;
};

export type BankPreview = {
  status: "READY";
  token: string;
  expiresAt: string;
  sheetName: string | null;
  headerRow: number;
  headers: string[];
  mapping: BankMapping;
  /** The identity fields are fixed to the columns the payables upload reads (see bank-file-core.ts). */
  lockedFields: BankField[];
  /** Fields another column could also be: the one used is shown, and the owner may change it (unless locked). */
  ambiguous: BankField[];
  counts: { lines: number; new: number; existing: number; suspected: number; invalid: number; repeatedInFile: number; warnings: number };
  /** Totals of the NEW lines, in shekels: a statement in any other currency is refused (FOREIGN_CURRENCY). */
  newTotals: { currency: "ILS"; creditMinor: number; debitMinor: number };
  /**
   * The account this preview was made for — the one the commit must confirm (confirmedAccountId) — and what the
   * file's own account number said about it (VERIFIED_FULL only when the full account was compared, PARTIAL_MATCH
   * when only its last four digits were, NOT_IN_FILE when the file prints none; a mismatch is
   * refused, ACCOUNT_NUMBER_MISMATCH).
   */
  account: { id: number; label: string; masked: string; numberCheck: "VERIFIED_FULL" | "PARTIAL_MATCH" | "NOT_IN_FILE" };
  /** Lines already held under another account of the business: the commit must confirm their number. */
  crossAccount: CrossAccountSignal;
  dateRange: { from: string; to: string } | null;
  balance: BalanceCheck;
  errors: RowProblem[];
  warnings: RowProblem[];
  /** When this exact file was already imported into this business before. */
  previouslyImportedAt: string | null;
  /** EVERY suspected line (each needs a decision), whatever the preview window. */
  suspected: BankPreviewLine[];
  lines: BankPreviewLine[];
  truncatedLines: boolean;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

function previewLine(l: BankLine, status: LineStatus): BankPreviewLine {
  return {
    rowNumber: l.rowNumber,
    status,
    bookedAt: day(l.bookedAt),
    valueDate: l.valueDate ? day(l.valueDate) : null,
    direction: l.direction,
    amountMinor: l.amountMinor,
    description: l.description,
    reference: l.reference,
    counterpartyName: l.counterpartyName,
    balanceMinor: l.balanceMinor,
  };
}

export type BankAnalysis = BankPreview | BankMappingRequired;

export async function analyzeBankFile(input: BankImportInput): Promise<BankAnalysis> {
  let prepared: Prepared;
  try {
    prepared = await prepare(input);
  } catch (e) {
    if (e instanceof MappingRequiredSignal) {
      // The account is checked here too, so a mapping screen is never shown for an account that is not theirs
      // — nor for a file that prints another account's number.
      await withTenantTransaction(async (tx) => assertAccountNumber(input.businessId, e.accountNumbers, await assertAccount(tx, input.businessId, input.accountId as number)));
      return e.payload;
    }
    throw e;
  }
  if (prepared.lines.length === 0 && prepared.errors.length === 0) throw new BankImportError("NO_LINES", 400);

  const { statuses, previous, account, numberCheck, crossAccount } = await withTenantTransaction(async (tx) => {
    const account = await assertAccount(tx, input.businessId, prepared.accountId);
    const numberCheck = assertAccountNumber(input.businessId, prepared.accountNumbers, account);
    const known = await existingIds(tx, input.businessId, [...prepared.identities.withAccount, ...prepared.identities.withoutAccount]);
    const previous = await lastBankStatementImportInTx(tx, input.businessId, prepared.contentHash);
    const statuses = classify(prepared, known);
    const crossAccount = await crossAccountSignal(tx, input.businessId, prepared, statuses);
    return { statuses, previous, account, numberCheck, crossAccount };
  });

  let creditMinor = 0;
  let debitMinor = 0;
  prepared.lines.forEach((l, i) => {
    if (statuses[i] !== "NEW") return;
    if (l.direction === "CREDIT") creditMinor += l.amountMinor;
    else debitMinor += l.amountMinor;
  });
  const dates = prepared.lines.map((l) => l.bookedAt.getTime());
  const token = signEnvelope(TOKEN_SPEC, {
    b: input.businessId,
    u: input.userId,
    a: prepared.accountId,
    ch: prepared.contentHash,
    mh: prepared.mappingHash,
    n: prepared.lines.length,
  });
  const verified = verifyEnvelope<object>(TOKEN_SPEC, token);

  return {
    status: "READY",
    token,
    expiresAt: verified.ok ? verified.expiresAt.toISOString() : new Date().toISOString(),
    sheetName: prepared.sheetName,
    headerRow: prepared.headerRow,
    headers: prepared.headers,
    mapping: prepared.mapping,
    lockedFields: prepared.legacyLocked ? (["date", "amount", "debit", "credit", "description", "reference"] as BankField[]) : [],
    ambiguous: proposeBankMapping(prepared.headers).ambiguous,
    counts: {
      lines: prepared.lines.length,
      new: statuses.filter((s) => s === "NEW").length,
      existing: statuses.filter((s) => s === "EXISTING").length,
      suspected: statuses.filter((s) => s === "SUSPECTED").length,
      invalid: prepared.errors.length,
      repeatedInFile: countRepeatedLines(prepared.lines),
      warnings: prepared.warnings.length,
    },
    newTotals: { currency: "ILS", creditMinor, debitMinor },
    account: {
      id: account.id,
      label: account.label,
      masked: maskAccount(account.accountLast4),
      numberCheck: numberCheck.status === "MISMATCH" ? "NOT_IN_FILE" : numberCheck.status,
    },
    crossAccount,
    dateRange: dates.length ? { from: day(new Date(Math.min(...dates))), to: day(new Date(Math.max(...dates))) } : null,
    balance: checkBalanceChain(prepared.lines),
    errors: prepared.errors.slice(0, 50),
    warnings: prepared.warnings.slice(0, 50),
    previouslyImportedAt: previous ? previous.toISOString() : null,
    suspected: prepared.lines.flatMap((l, i) => (statuses[i] === "SUSPECTED" ? [previewLine(l, "SUSPECTED")] : [])),
    lines: prepared.lines.slice(0, PREVIEW_ROWS).map((l, i) => previewLine(l, statuses[i])),
    truncatedLines: prepared.lines.length > PREVIEW_ROWS,
  };
}

/* ─────────────────────────────── commit ─────────────────────────────── */

export type BankCommitResult = {
  importRunId: number;
  /** True when this file, account, mapping and decisions were already committed: nothing was done again. */
  replayed: boolean;
  inserted: number;
  existing: number;
  suspectedImported: number;
  suspectedSkipped: number;
  invalid: number;
  committedAt: string;
};

type TokenFacts = { b: number; u: number; a: number; ch: string; mh: string; n: number };

export type BankCommitInput = BankImportInput & {
  token: unknown;
  decisions?: SuspectDecisions | null;
  /**
   * The account the owner saw and confirmed on the preview (preview.account.id). Required: the server refuses a
   * commit without it, or with one that is not the account the token was issued for.
   */
  confirmedAccountId?: number | null;
  /** The number of cross-account lines the owner saw and confirmed (preview.crossAccount.lines), when any. */
  confirmedCrossAccountLines?: number | null;
};

export async function commitBankFile(input: BankCommitInput): Promise<BankCommitResult> {
  const verified = verifyEnvelope<TokenFacts>(TOKEN_SPEC, input.token);
  if (!verified.ok) throw new BankImportError("TOKEN_INVALID", 400, { reason: verified.reason });
  const facts = verified.facts;
  if (facts.b !== input.businessId || facts.u !== input.userId || facts.a !== input.accountId) {
    throw new BankImportError("TOKEN_INVALID", 400, { reason: "BINDING" });
  }
  // The explicit confirmation of the target account: the analyzed account (bound in the token), not just the
  // one the form carries now.
  if (input.confirmedAccountId === null || input.confirmedAccountId === undefined) {
    throw new BankImportError("ACCOUNT_CONFIRMATION_REQUIRED", 400);
  }
  if (input.confirmedAccountId !== facts.a) throw new BankImportError("ACCOUNT_CONFIRMATION_MISMATCH", 409);
  let prepared: Prepared;
  try {
    prepared = await prepare(input);
  } catch (e) {
    // A token is only ever issued for a complete mapping; an incomplete one cannot be committed.
    if (e instanceof MappingRequiredSignal) throw new BankImportError("MAPPING_INVALID", 400, { problem: "MAPPING_REQUIRED" });
    throw e;
  }
  if (prepared.contentHash !== facts.ch || prepared.mappingHash !== facts.mh || prepared.lines.length !== facts.n) {
    throw new BankImportError("FILE_CHANGED", 409);
  }
  const decisions: SuspectDecisions = input.decisions ?? {};
  const decisionsHash = decisionsHashOf(decisions);
  // A re-decision (the same file, later importing a line skipped before) is a new run; the same decisions again
  // are a replay. An ordinary import with nothing suspected hashes exactly as before.
  const retryKey = retryKeyOf({
    businessId: input.businessId,
    contentHash: prepared.contentHash,
    mappingHash: prepared.mappingHash,
    overrideActionHash: Object.keys(decisions).length ? decisionsHash : null,
  });

  return withTenantTransaction(
    async (tx) => {
      // One bank-line ingest per business at a time (this path).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"bank-lines-ingest:" + String(input.businessId)}))`;
      const account = await assertAccount(tx, input.businessId, prepared.accountId);
      const numberCheck = assertAccountNumber(input.businessId, prepared.accountNumbers, account);

      const prior = await findBankStatementRunInTx(tx, retryKey);
      if (prior) {
        return {
          importRunId: prior.id,
          replayed: true,
          inserted: prior.createdCount ?? 0,
          existing: prior.skippedCount ?? 0,
          suspectedImported: 0,
          suspectedSkipped: 0,
          invalid: prior.failedCount ?? 0,
          committedAt: (prior.completedAt ?? prior.startedAt).toISOString(),
        };
      }

      // Classified again under the lock: what the owner decided must match what is suspected NOW.
      const known = await existingIds(tx, input.businessId, [...prepared.identities.withAccount, ...prepared.identities.withoutAccount]);
      const statuses = classify(prepared, known);
      const suspectedRows = prepared.lines.filter((_, i) => statuses[i] === "SUSPECTED").map((l) => l.rowNumber);
      const decidedRows = Object.keys(decisions).map(Number);
      const missing = suspectedRows.filter((r) => decisions[r] !== "IMPORT" && decisions[r] !== "SKIP");
      if (missing.length) throw new BankImportError("DECISIONS_REQUIRED", 409, { missing: missing.length });
      if (decidedRows.some((r) => !suspectedRows.includes(r))) throw new BankImportError("DECISIONS_INVALID", 409);
      // Lines already held under another account: imported only when the owner confirmed exactly that many.
      const crossAccount = await crossAccountSignal(tx, input.businessId, prepared, statuses);
      if (crossAccount.lines > 0 && input.confirmedCrossAccountLines !== crossAccount.lines) {
        throw new BankImportError("CROSS_ACCOUNT_CONFIRMATION_REQUIRED", 409, { lines: crossAccount.lines });
      }

      const runId = await openBankStatementRunInTx(tx, {
        businessId: input.businessId,
        userId: input.userId,
        contentHash: prepared.contentHash,
        mappingHash: prepared.mappingHash,
        decisionsHash,
        retryKey,
        sheetName: prepared.sheetName,
        totalRows: prepared.lines.length + prepared.errors.length,
      });
      const importBatchId = `bnk-${runId}`;

      const fresh = prepared.lines
        .map((line, i) => ({ line, externalId: prepared.identities.withAccount[i], status: statuses[i] }))
        .filter((x) => x.status === "NEW" || (x.status === "SUSPECTED" && decisions[x.line.rowNumber] === "IMPORT"));

      const result = fresh.length
        ? await tx.externalTransaction.createMany({
            data: fresh.map(({ line, externalId }) => ({
              businessId: input.businessId,
              source: SOURCE,
              externalId,
              sourceBankAccountId: prepared.accountId,
              direction: line.direction,
              amount: new Prisma.Decimal(fromMinorUnits(line.amountMinor)),
              bookedAt: line.bookedAt,
              valueDate: line.valueDate,
              counterpartyName: line.counterpartyName,
              reference: line.reference,
              description: line.description,
              importBatchId,
              createdByUserId: input.userId,
            })),
            // ON CONFLICT DO NOTHING against (business, source, externalId).
            skipDuplicates: true,
          })
        : { count: 0 };

      const inserted = result.count;
      const existing = prepared.lines.length - inserted;
      const importedRows = suspectedRows.filter((r) => decisions[r] === "IMPORT");
      const skippedRows = suspectedRows.filter((r) => decisions[r] === "SKIP");
      const completedAt = new Date();
      await completeBankStatementRunInTx(tx, runId, { created: inserted, skipped: existing, failed: prepared.errors.length, completedAt });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.userId,
        eventType: "EXTERNAL_TRANSACTIONS_INGESTED",
        summary: `${inserted} new bank line(s) recorded from a bank file`,
        metadata: {
          source: SOURCE,
          path: "bank_file_import",
          importBatchId,
          importRunId: runId,
          offered: prepared.lines.length,
          inserted,
          invalid: prepared.errors.length,
          // The owner's explicit decisions on suspected duplicates — row numbers only, never values.
          suspected: suspectedRows.length,
          suspectedImportedRows: importedRows,
          suspectedSkippedRows: skippedRows,
          decisionsHash,
          // The owner confirmed the target account, and how many lines the business already held under another.
          confirmedAccountId: prepared.accountId,
          accountNumberInFile: numberCheck.status,
          crossAccountLines: crossAccount.lines,
        },
      });
      return {
        importRunId: runId,
        replayed: false,
        inserted,
        existing,
        suspectedImported: importedRows.length,
        suspectedSkipped: skippedRows.length,
        invalid: prepared.errors.length,
        committedAt: completedAt.toISOString(),
      };
    },
    { timeoutMs: 60_000 }
  );
}

export type { BankMapping, BankField, MappingProblem };
