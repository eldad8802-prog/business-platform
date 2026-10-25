/**
 * Bank file import (milestone B1) — analyze, then commit, an owner-uploaded bank statement. SERVER-ONLY.
 *
 *   analyze   reads the file (data-transfer readers: CSV in any encoding they detect, XLSX), finds the
 *             header, proposes a mapping, normalizes the lines and classifies each one against what
 *             Dubiz already holds. Writes NOTHING. Returns a signed token that binds this business, this
 *             user, this account, these exact bytes and this exact mapping — no row values.
 *   commit    the owner sends the same file and the token back. Under one transaction and a per-business
 *             lock: the run is opened (or found — a replay reports the first outcome), the lines already
 *             known are excluded, the new ones are inserted, the run is closed, one audit event is written.
 *             All of it lands or none of it does.
 *
 * Where it writes: `ExternalTransaction` only, through the same columns, source (OWNER_UPLOAD) and line
 * identity as the payables upload (`uploadStatement`); `ImportRun` for the run summary and the file's
 * hash (the file itself is not kept); `PayablesAuditEvent` through `writeAudit`. Nothing else.
 *
 * Duplicates (see bank-file-core.ts for the identity itself):
 *   - every line is checked under BOTH identities — with the chosen account, and with none (an old upload
 *     made without picking an account) — and is skipped if either exists;
 *   - the insert is ON CONFLICT DO NOTHING on (business, source, externalId), so a line the old path
 *     inserts concurrently under the same identity is still one row;
 *   - commits for one business serialise on `bank-lines-ingest:<businessId>`.
 */
import { Prisma } from "@prisma/client";
import { readImportSource } from "@/lib/data-transfer/import/import-source";
import { IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";
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
  | "FILE_CHANGED";

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

/** Read, locate, map, normalize. Pure apart from reading the bytes it was handed. */
async function prepare(input: BankImportInput): Promise<Prepared> {
  if (!input.accountId || !Number.isInteger(input.accountId) || input.accountId <= 0) {
    throw new BankImportError("ACCOUNT_REQUIRED", 400);
  }
  const source = await readImportSource({ filename: input.filename, bytes: input.bytes, sheetName: input.sheetName ?? null });
  if (!source.ok) {
    throw new BankImportError("FILE_UNREADABLE", 400, { reason: source.code, message: source.message });
  }
  const located = locateHeader(source.table);
  if (!located) throw new BankImportError("HEADER_NOT_FOUND", 400);

  const resolved = resolveBankMapping(located.headers, input.mapping ?? null);
  if (!resolved.ok) {
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

export type LineStatus = "NEW" | "EXISTING";

function classify(prepared: Prepared, known: Set<string>): LineStatus[] {
  return prepared.lines.map((_, i) =>
    known.has(prepared.identities.withAccount[i]) || known.has(prepared.identities.withoutAccount[i]) ? "EXISTING" : "NEW"
  );
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
  token: string;
  expiresAt: string;
  sheetName: string | null;
  headerRow: number;
  headers: string[];
  mapping: BankMapping;
  /** The identity fields are fixed to the columns the payables upload reads (see bank-file-core.ts). */
  lockedFields: BankField[];
  counts: { lines: number; new: number; existing: number; invalid: number; repeatedInFile: number; warnings: number };
  /** Totals of the NEW lines, in shekels (bank lines are ILS, as the payables upload records them). */
  newTotals: { currency: "ILS"; creditMinor: number; debitMinor: number };
  dateRange: { from: string; to: string } | null;
  balance: BalanceCheck;
  errors: RowProblem[];
  warnings: RowProblem[];
  /** When this exact file was already imported into this business before. */
  previouslyImportedAt: string | null;
  lines: BankPreviewLine[];
  truncatedLines: boolean;
};

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function analyzeBankFile(input: BankImportInput): Promise<BankPreview> {
  const prepared = await prepare(input);
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
    token,
    expiresAt: verified.ok ? verified.expiresAt.toISOString() : new Date().toISOString(),
    sheetName: prepared.sheetName,
    headerRow: prepared.headerRow,
    headers: prepared.headers,
    mapping: prepared.mapping,
    lockedFields: prepared.legacyLocked ? (["date", "amount", "debit", "credit", "description", "reference"] as BankField[]) : [],
    counts: {
      lines: prepared.lines.length,
      new: statuses.filter((s) => s === "NEW").length,
      existing: statuses.filter((s) => s === "EXISTING").length,
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
    lines: prepared.lines.slice(0, PREVIEW_ROWS).map((l, i) => ({
      rowNumber: l.rowNumber,
      status: statuses[i],
      bookedAt: day(l.bookedAt),
      valueDate: l.valueDate ? day(l.valueDate) : null,
      direction: l.direction,
      amountMinor: l.amountMinor,
      description: l.description,
      reference: l.reference,
      counterpartyName: l.counterpartyName,
      balanceMinor: l.balanceMinor,
    })),
    truncatedLines: prepared.lines.length > PREVIEW_ROWS,
  };
}

/* ─────────────────────────────── commit ─────────────────────────────── */

export type BankCommitResult = {
  importRunId: number;
  /** True when this file, account and mapping were already committed: nothing was done again. */
  replayed: boolean;
  inserted: number;
  existing: number;
  invalid: number;
  committedAt: string;
};

type TokenFacts = { b: number; u: number; a: number; ch: string; mh: string; n: number };

export async function commitBankFile(input: BankImportInput & { token: unknown }): Promise<BankCommitResult> {
  const verified = verifyEnvelope<TokenFacts>(TOKEN_SPEC, input.token);
  if (!verified.ok) throw new BankImportError("TOKEN_INVALID", 400, { reason: verified.reason });
  const facts = verified.facts;
  if (facts.b !== input.businessId || facts.u !== input.userId || facts.a !== input.accountId) {
    throw new BankImportError("TOKEN_INVALID", 400, { reason: "BINDING" });
  }
  const prepared = await prepare(input);
  if (prepared.contentHash !== facts.ch || prepared.mappingHash !== facts.mh || prepared.lines.length !== facts.n) {
    throw new BankImportError("FILE_CHANGED", 409);
  }

  const retryKey = retryKeyOf({ businessId: input.businessId, contentHash: prepared.contentHash, mappingHash: prepared.mappingHash });

  return withTenantTransaction(
    async (tx) => {
      // One bank-line ingest per business at a time (this path; see the old-path note in docs).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"bank-lines-ingest:" + String(input.businessId)}))`;
      await assertAccount(tx, input.businessId, prepared.accountId);

      const prior = await findBankStatementRunInTx(tx, retryKey);
      if (prior) {
        return {
          importRunId: prior.id,
          replayed: true,
          inserted: prior.createdCount ?? 0,
          existing: prior.skippedCount ?? 0,
          invalid: prior.failedCount ?? 0,
          committedAt: (prior.completedAt ?? prior.startedAt).toISOString(),
        };
      }

      const runId = await openBankStatementRunInTx(tx, {
        businessId: input.businessId,
        userId: input.userId,
        contentHash: prepared.contentHash,
        mappingHash: prepared.mappingHash,
        retryKey,
        sheetName: prepared.sheetName,
        totalRows: prepared.lines.length + prepared.errors.length,
      });
      const run = { id: runId };
      const importBatchId = `bnk-${run.id}`;

      const known = await existingIds(tx, input.businessId, [...prepared.identities.withAccount, ...prepared.identities.withoutAccount]);
      const statuses = classify(prepared, known);
      const fresh = prepared.lines
        .map((line, i) => ({ line, externalId: prepared.identities.withAccount[i], status: statuses[i] }))
        .filter((x) => x.status === "NEW");

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
      const completedAt = new Date();
      await completeBankStatementRunInTx(tx, run.id, { created: inserted, skipped: existing, failed: prepared.errors.length, completedAt });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.userId,
        eventType: "EXTERNAL_TRANSACTIONS_INGESTED",
        summary: `${inserted} new bank line(s) recorded from a bank file`,
        metadata: {
          source: SOURCE,
          path: "bank_file_import",
          importBatchId,
          importRunId: run.id,
          offered: prepared.lines.length,
          inserted,
          invalid: prepared.errors.length,
        },
      });
      return { importRunId: run.id, replayed: false, inserted, existing, invalid: prepared.errors.length, committedAt: completedAt.toISOString() };
    },
    { timeoutMs: 60_000 }
  );
}

export type { BankMapping, BankField, MappingProblem };
