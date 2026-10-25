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
 */
import { createHash } from "node:crypto";

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
import { fromMinorUnits } from "@/lib/services/payables/payables-core";
import { writeAudit } from "@/lib/services/payables/payables.service";
import {
  BANK_MAX_LINES,
  bankLineIdentities,
  bankMappingHash,
  checkBalanceChain,
  contentHashOf,
  countRepeatedLines,
  locateHeader,
  normalizeBankRows,
  proposeBankMapping,
  readBankCsvTable,
  resolveBankMapping,
  type BalanceCheck,
  type BankField,
  type BankLine,
  type BankMapping,
  type MappingProblem,
  type RowProblem,
} from "./bank-file-core";

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
  | "DECISIONS_REQUIRED";

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
  constructor(public readonly payload: BankMappingRequired) {
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

  const resolved = resolveBankMapping(located.headers, input.mapping ?? null);
  if (!resolved.ok) {
    // A readable table with a header row whose required fields are missing, doubled or ambiguous: not a broken
    // file — the owner completes the mapping (analyze answers MAPPING_REQUIRED). The old parser's locked
    // columns are the one thing that cannot be re-mapped.
    if (resolved.problem !== "IDENTITY_FIELD_LOCKED") {
      throw new MappingRequiredSignal(mappingRequired(source.sheetName, located, resolved));
    }
    throw new BankImportError("MAPPING_INVALID", 400, { problem: resolved.problem, ...(resolved.field ? { field: resolved.field } : {}) });
  }
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
    lines: normalized.lines,
    errors: normalized.errors,
    warnings: normalized.warnings,
    identities: bankLineIdentities(input.businessId, input.accountId, normalized.lines),
  };
}

async function assertAccount(tx: TenantTx, businessId: number, accountId: number): Promise<void> {
  const account = await tx.businessBankAccount.findFirst({
    where: { id: accountId, businessId, isActive: true },
    select: { id: true },
  });
  if (!account) throw new BankImportError("ACCOUNT_NOT_FOUND", 404);
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
  /** Totals of the NEW lines, in shekels (bank lines are ILS, as the payables upload records them). */
  newTotals: { currency: "ILS"; creditMinor: number; debitMinor: number };
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
      // The account is checked here too, so a mapping screen is never shown for an account that is not theirs.
      await withTenantTransaction((tx) => assertAccount(tx, input.businessId, input.accountId as number));
      return e.payload;
    }
    throw e;
  }
  if (prepared.lines.length === 0 && prepared.errors.length === 0) throw new BankImportError("NO_LINES", 400);

  const { statuses, previous } = await withTenantTransaction(async (tx) => {
    await assertAccount(tx, input.businessId, prepared.accountId);
    const known = await existingIds(tx, input.businessId, [...prepared.identities.withAccount, ...prepared.identities.withoutAccount]);
    const previous = await lastBankStatementImportInTx(tx, input.businessId, prepared.contentHash);
    return { statuses: classify(prepared, known), previous };
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

export async function commitBankFile(
  input: BankImportInput & { token: unknown; decisions?: SuspectDecisions | null }
): Promise<BankCommitResult> {
  const verified = verifyEnvelope<TokenFacts>(TOKEN_SPEC, input.token);
  if (!verified.ok) throw new BankImportError("TOKEN_INVALID", 400, { reason: verified.reason });
  const facts = verified.facts;
  if (facts.b !== input.businessId || facts.u !== input.userId || facts.a !== input.accountId) {
    throw new BankImportError("TOKEN_INVALID", 400, { reason: "BINDING" });
  }
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
      await assertAccount(tx, input.businessId, prepared.accountId);

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
