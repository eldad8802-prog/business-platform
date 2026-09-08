/**
 * Historical fiscal Execute — the first phase allowed to write a record.
 *
 * # What the token is, and what it is not
 *
 * It is an attestation that a specific owner approved a specific set of
 * decisions against a specific file and a specific database state. It is NOT a
 * source of truth about rows: the payload carries hashes and counts, never
 * values. So everything is re-derived here — parse, map, normalize, validate,
 * duplicate analysis, reversal analysis, decision validation — and the token is
 * checked against the result. What the owner approved is what runs, and it is
 * proven rather than assumed.
 *
 * # The three things that make this safe to replay
 *
 *   the run     unique on (businessId, contentHash, mappingHash, decisionsHash),
 *               so the same approved execution resolves to the run that exists
 *               instead of starting a second one.
 *   the marker  primary key (importRunId, sourceRowNumber), written in the SAME
 *               transaction as the record it describes. A record without its
 *               marker, or a marker without its record, cannot exist.
 *   the lock    a transaction-scoped advisory lock on the tenant + fiscal
 *               identity, so two concurrent executions of the same document
 *               cannot both read "nothing exists" and both insert.
 *
 * # INSERT only, and what that costs
 *
 * `HistoricalFiscalDocument` has no UPDATE policy and no UPDATE grant. That is
 * deliberate, and it decides the shape of this file: a credit's reversal link
 * is bound at INSERT or not at all. There is no insert-now-patch-later, which
 * means a credit whose in-file target has not been created yet is a FAILURE
 * here rather than something to reconcile afterwards. Analyze and Preview
 * already refuse that shape, so this is the backstop and not the gate.
 */

import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import {
  countRunRowsByStatus,
  loadExecutedRowNumbers,
  markRow,
  markFailedRow,
  markSkippedRow,
  openOrResumeRun,
  terminalizeRun,
} from "@/lib/data-transfer/import/execute/import-run-store";
import {
  buildHistoricalPreview,
  type HistoricalPreviewRow,
} from "@/lib/data-transfer/historical/historical-preview";
import {
  verifyHistoricalPreviewToken,
  type HistoricalPreviewFacts,
} from "@/lib/data-transfer/historical/historical-preview-token";
import { decisionsHashOf } from "@/lib/data-transfer/historical/historical-decisions";
import { lockHistoricalIdentity } from "@/lib/data-transfer/historical/historical-identity-lock";
import { fiscalDateToUtcDate } from "@/lib/data-transfer/historical/historical-date";
import { fiscalAmountToDecimal } from "@/lib/data-transfer/historical/historical-money";
import type { FiscalIdentity } from "@/lib/data-transfer/historical/historical-duplicates";
import type { HistoricalDecisions } from "@/lib/data-transfer/historical/historical-decisions";
import type { DateFormatContract } from "@/lib/data-transfer/historical/historical-date";
import type { ResolvedMapping } from "@/lib/data-transfer/import/mapping/mapping-proposer";

/* ------------------------------------------------------------- codes ---- */

export type HistoricalExecuteErrorCode =
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_MISMATCH"
  | "PREVIEW_STALE"
  | "DECISION_CHANGED"
  | "NOT_READY";

export type HistoricalRowResultCode =
  | "CREATED"
  | "SKIPPED"
  | "ALREADY_EXECUTED"
  | "DUPLICATE_CHANGED"
  | "REVERSAL_CHANGED"
  | "ROW_PERSISTENCE_FAILED";

export type HistoricalRowResult = {
  sourceRowNumber: number;
  result: HistoricalRowResultCode;
};

export type HistoricalExecuteResult =
  | { ok: false; code: HistoricalExecuteErrorCode | string; message: string }
  | {
      ok: true;
      /** Opaque to the owner; it identifies the run, not a business record. */
      runId: number;
      status: "COMPLETED" | "PARTIAL" | "FAILED";
      /** True when this call found an existing run and re-executed nothing. */
      replayed: boolean;
      totals: {
        totalRows: number;
        created: number;
        skipped: number;
        failed: number;
        alreadyExecuted: number;
      };
      rows: HistoricalRowResult[];
    };

export type HistoricalExecuteInput = {
  businessId: number;
  userId: number;
  filename: string;
  bytes: Buffer;
  sheetName?: string | null;
  dateFormat?: DateFormatContract;
  mapping?: ResolvedMapping | null;
  decisions: HistoricalDecisions;
  previewToken: string;
};

/* --------------------------------------------------------- run identity - */

/**
 * The ledger's `decisionsHash` column, for this domain.
 *
 * The ledger's uniqueness is (businessId, contentHash, mappingHash,
 * decisionsHash) — four columns, fixed by a schema this phase must not change.
 * Historical execution has more identity than that: the same file with the same
 * mapping and the same decisions is a DIFFERENT import when the date format
 * differs, because that choice decides which month a document falls in.
 *
 * So what goes in the `decisionsHash` column is the whole approved execution
 * contract: the decisions, the analysis identity that already folds in the date
 * format and the sheet, and the database evidence the owner approved against.
 * The column keeps its meaning — "which approved execution is this" — and the
 * unique key covers everything that could make two executions different.
 */
export function executionContractHash(input: {
  decisions: HistoricalDecisions;
  analysisHash: string;
  evidenceFingerprint: string;
}): string {
  return createHash("sha256")
    .update(
      [
        "historical-execution-contract:v1",
        `decisions:${decisionsHashOf(input.decisions)}`,
        `analysis:${input.analysisHash}`,
        `evidence:${input.evidenceFingerprint}`,
      ].join("\n")
    )
    .digest("hex");
}

/* ------------------------------------------------------------ helpers --- */

function fail(code: HistoricalExecuteErrorCode, message: string): HistoricalExecuteResult {
  return { ok: false, code, message };
}

/** The normalized value of one field, as Preview computed it. */
function valueOf(row: HistoricalPreviewRow, field: string): string | null {
  return row.values.find((v) => v.field === field)?.normalized ?? null;
}

function identityOf(row: HistoricalPreviewRow): FiscalIdentity | null {
  const source = valueOf(row, "מערכת מקור");
  const type = valueOf(row, "סוג מסמך");
  const number = valueOf(row, "מספר מסמך מקורי");
  if (!source || !type || !number) return null;
  return {
    sourceSystemCode: source,
    documentTypeCode: type,
    originalDocumentNumber: number,
  };
}

/* ------------------------------------------------------------ execute --- */

export async function executeHistoricalImport(
  input: HistoricalExecuteInput
): Promise<HistoricalExecuteResult> {
  /* ---- 1. the token, before anything is read or written ---- */
  const token = verifyHistoricalPreviewToken(input.previewToken);
  if (!token.ok) {
    return fail(
      token.reason === "EXPIRED" ? "TOKEN_EXPIRED" : "TOKEN_INVALID",
      token.reason === "EXPIRED"
        ? "התצוגה המקדימה פגה. יש להריץ אותה שוב"
        : "אישור התצוגה המקדימה אינו תקין"
    );
  }
  const facts: HistoricalPreviewFacts = token.facts;

  // Whose approval is this? A valid signature on somebody else's approval is
  // still somebody else's approval.
  if (facts.businessId !== input.businessId || facts.userId !== input.userId) {
    return fail("TOKEN_MISMATCH", "האישור אינו שייך למשתמש הזה");
  }
  if (facts.domain !== "historical-documents") {
    return fail("TOKEN_MISMATCH", "האישור אינו מתאים לייבוא היסטורי");
  }

  /* ---- 2. re-derive everything, from the bytes ---- */
  // The re-derivation READS the tenant's history, so it needs the same tenant
  // context the write path takes later. Establishing it here rather than in the
  // route is what makes the executor safe to call from anywhere: there is no
  // caller-supplied way to be in the wrong tenant, and under the restricted
  // runtime a missing context reads as "this business has no history" instead
  // of raising — which would turn every duplicate into a new record.
  const preview = await runWithTenantContext({ businessId: input.businessId }, () =>
    buildHistoricalPreview({
      businessId: input.businessId,
      userId: input.userId,
      filename: input.filename,
      bytes: input.bytes,
      sheetName: input.sheetName ?? null,
      dateFormat: input.dateFormat ?? null,
      mapping: input.mapping ?? null,
      decisions: input.decisions,
    })
  );
  if (!preview.ok) {
    return { ok: false, code: preview.code, message: preview.message };
  }

  /* ---- 3. does what we just derived match what was approved? ---- */
  if (
    preview.file.contentHash !== facts.contentHash ||
    preview.file.sheetName !== facts.sheetName ||
    (input.dateFormat ?? null) !== facts.dateFormat
  ) {
    return fail("TOKEN_MISMATCH", "האישור אינו מתאים לקובץ שנשלח");
  }
  if (decisionsHashOf(preview.decisions) !== facts.decisionsHash) {
    return fail("DECISION_CHANGED", "ההחלטות שנשלחו אינן אלה שאושרו");
  }
  if (preview.rows.length !== facts.rowCount && preview.summary.totalRows !== facts.rowCount) {
    return fail("TOKEN_MISMATCH", "מספר השורות אינו תואם לאישור");
  }
  // The database itself. A record inserted between approval and execution
  // changes what confirming means, and the owner approved the other world.
  if (preview.evidenceFingerprint !== facts.evidenceFingerprint) {
    return fail(
      "PREVIEW_STALE",
      "ההיסטוריה השתנתה מאז האישור. יש להריץ תצוגה מקדימה חדשה"
    );
  }
  if (!preview.readyForExecute) {
    return fail("NOT_READY", "התצוגה המקדימה אינה מוכנה לביצוע");
  }

  /* ---- 4. the run. Idempotent by construction ---- */
  const contractHash = executionContractHash({
    decisions: preview.decisions,
    analysisHash: facts.analysisHash,
    evidenceFingerprint: facts.evidenceFingerprint,
  });

  const allRows = preview.rowsTruncated
    ? await allPreviewRows(input, preview.decisions)
    : preview.rows;

  const run = await openOrResumeRun({
    businessId: input.businessId,
    userId: input.userId,
    domain: "historical-documents",
    contentHash: facts.contentHash,
    mappingHash: facts.mappingHash,
    decisionsHash: contractHash,
    sheetName: facts.sheetName,
    totalRows: allRows.length,
  });

  const alreadyDone = await loadExecutedRowNumbers(input.businessId, run.id);

  /* ---- 5. the rows, in SOURCE ORDER ---- */
  // Order matters: a credit binds to a target created earlier in this same
  // run, and there is no second pass to fix it up afterwards.
  const ordered = [...allRows].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
  const results: HistoricalRowResult[] = [];
  /** sourceRowNumber -> the historical id this run created for it. */
  const createdIds = new Map<number, number>();

  for (const row of ordered) {
    if (alreadyDone.has(row.sourceRowNumber)) {
      results.push({ sourceRowNumber: row.sourceRowNumber, result: "ALREADY_EXECUTED" });
      // A replayed CREATE still needs its id available to a later credit.
      const existing = await findRowCreatedByRun(input.businessId, run.id, row);
      if (existing !== null) createdIds.set(row.sourceRowNumber, existing);
      continue;
    }

    if (row.selectedDecision === "SKIP") {
      await markSkippedRow(input.businessId, {
        importRunId: run.id,
        sourceRowNumber: row.sourceRowNumber,
        action: "SKIP",
      });
      results.push({ sourceRowNumber: row.sourceRowNumber, result: "SKIPPED" });
      continue;
    }

    const outcome = await createOneRow({
      businessId: input.businessId,
      runId: run.id,
      row,
      createdIds,
      overriding: row.selectedDecision === "CREATE_ANYWAY",
    });
    results.push({ sourceRowNumber: row.sourceRowNumber, result: outcome.result });
    if (outcome.result === "CREATED" && outcome.id !== undefined) {
      createdIds.set(row.sourceRowNumber, outcome.id);
    }
    if (outcome.result !== "CREATED") {
      await markFailedRow(input.businessId, {
        importRunId: run.id,
        sourceRowNumber: row.sourceRowNumber,
        action: "CREATE",
        errorCode: outcome.result === "ROW_PERSISTENCE_FAILED" ? "SERVICE_ERROR" : "CONFLICT",
      });
    }
  }

  /* ---- 6. terminalize from the MARKERS, never from what we think we did ---- */
  const counts = await countRunRowsByStatus(input.businessId, run.id);
  const status: "COMPLETED" | "PARTIAL" | "FAILED" =
    counts.failedCount === 0
      ? "COMPLETED"
      : counts.createdCount + counts.skippedCount === 0
        ? "FAILED"
        : "PARTIAL";
  await terminalizeRun(input.businessId, run.id, status, counts);

  return {
    ok: true,
    runId: run.id,
    status,
    replayed: !run.created,
    totals: {
      totalRows: ordered.length,
      created: results.filter((r) => r.result === "CREATED").length,
      skipped: results.filter((r) => r.result === "SKIPPED").length,
      failed: results.filter(
        (r) =>
          r.result === "ROW_PERSISTENCE_FAILED" ||
          r.result === "DUPLICATE_CHANGED" ||
          r.result === "REVERSAL_CHANGED"
      ).length,
      alreadyExecuted: results.filter((r) => r.result === "ALREADY_EXECUTED").length,
    },
    rows: results,
  };
}

/**
 * Preview returns a bounded window for display. Execution needs all of them, so
 * it re-derives with the window effectively removed by asking for the rows
 * again — the analysis is deterministic, so this produces the same rows.
 */
async function allPreviewRows(
  input: HistoricalExecuteInput,
  decisions: HistoricalDecisions
): Promise<HistoricalPreviewRow[]> {
  const full = await runWithTenantContext({ businessId: input.businessId }, () =>
    buildHistoricalPreview({
      businessId: input.businessId,
      userId: input.userId,
      filename: input.filename,
      bytes: input.bytes,
      sheetName: input.sheetName ?? null,
      dateFormat: input.dateFormat ?? null,
      mapping: input.mapping ?? null,
      decisions,
    })
  );
  if (!full.ok) return [];
  return full.rows;
}

/**
 * The historical record this run already created for a given source row.
 *
 * Needed on a partial retry: a credit whose target was created by an earlier
 * attempt must still bind to it, and execution memory is gone. The lookup is by
 * the run and the identity, both tenant-scoped.
 */
async function findRowCreatedByRun(
  businessId: number,
  runId: number,
  row: HistoricalPreviewRow
): Promise<number | null> {
  const identity = identityOf(row);
  if (!identity) return null;
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const found = await tx.historicalFiscalDocument.findFirst({
        where: {
          businessId,
          importRunId: runId,
          sourceSystemCode: identity.sourceSystemCode,
          documentTypeCode: identity.documentTypeCode,
          originalDocumentNumber: identity.originalDocumentNumber,
        },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      return found?.id ?? null;
    })
  );
}

type RowOutcome = { result: HistoricalRowResultCode; id?: number };

/**
 * Create one historical record, and its marker, in ONE transaction.
 *
 * Either both happen or neither does. A record whose marker is missing would be
 * re-created on the next attempt; a marker whose record is missing would hide a
 * row that never landed. The ledger exists to make both impossible, and taking
 * `tx` through is what keeps that true.
 */
async function createOneRow(params: {
  businessId: number;
  runId: number;
  row: HistoricalPreviewRow;
  createdIds: Map<number, number>;
  overriding: boolean;
}): Promise<RowOutcome> {
  const { businessId, runId, row, createdIds, overriding } = params;
  const identity = identityOf(row);
  if (!identity) return { result: "ROW_PERSISTENCE_FAILED" };

  try {
    return await runWithTenantContext({ businessId }, () =>
      withTenantTransaction(async (tx) => {
        // Serialise every writer of this identity, override included. An
        // override means "create a second record on purpose", not "skip the
        // serialisation that makes the count reliable".
        await lockHistoricalIdentity(tx, businessId, identity);

        // Under the lock, the world may have changed since approval.
        const conflict = await duplicateStateChanged(tx, businessId, identity, row, overriding);
        if (conflict) return { result: "DUPLICATE_CHANGED" } as RowOutcome;

        const reversal = await resolveReversalTarget(tx, businessId, row, createdIds);
        if (reversal === "UNRESOLVED") return { result: "REVERSAL_CHANGED" } as RowOutcome;

        const created = await tx.historicalFiscalDocument.create({
          data: {
            businessId,
            documentTypeCode: identity.documentTypeCode,
            sourceDocumentTypeRaw: rawOf(row, "סוג מסמך"),
            originalDocumentNumber: identity.originalDocumentNumber,
            originalIssueDate: dateOf(row),
            subtotalAmount: amountOf(row, "סכום לפני מע״מ"),
            vatAmount: amountOf(row, "מע״מ"),
            totalAmount: amountOf(row, "סכום כולל"),
            currency: valueOf(row, "מטבע"),
            customerNameSnapshot: valueOf(row, "שם לקוח"),
            customerTaxIdSnapshot: valueOf(row, "מספר עוסק / ח.פ. לקוח"),
            sourceSystemCode: identity.sourceSystemCode,
            sourceSystemNameRaw: rawOf(row, "מערכת מקור"),
            reversesOriginalNumberRaw: valueOf(row, "מספר מסמך שמזוכה"),
            reversesHistoricalDocumentId: reversal,
            importRunId: runId,
          },
          select: { id: true },
        });

        // CREATE_ANYWAY is a kind of CREATE in the ledger's vocabulary, which
        // has two actions and no migration in this phase. Nothing is lost: the
        // override is visible in the data as a second record with the same
        // identity, and the run's contract hash binds the decision set it was
        // approved under.
        await markRow(tx, {
          importRunId: runId,
          sourceRowNumber: row.sourceRowNumber,
          action: "CREATE",
          status: "CREATED",
        });

        return { result: "CREATED", id: created.id } as RowOutcome;
      })
    );
  } catch {
    // The transaction rolled back, so there is no record and no marker. The
    // caller writes the FAILED marker separately, which is safe precisely
    // because there is nothing left to be atomic with.
    return { result: "ROW_PERSISTENCE_FAILED" };
  }
}

/** Has the duplicate picture moved since the owner approved this row? */
async function duplicateStateChanged(
  tx: TenantTx,
  businessId: number,
  identity: FiscalIdentity,
  row: HistoricalPreviewRow,
  overriding: boolean
): Promise<boolean> {
  const matches = await tx.historicalFiscalDocument.count({
    where: {
      businessId,
      sourceSystemCode: identity.sourceSystemCode,
      documentTypeCode: identity.documentTypeCode,
      originalDocumentNumber: identity.originalDocumentNumber,
    },
  });
  // An override was approved KNOWING a record exists, so more of them is the
  // expected world rather than a surprise. A plain CREATE was approved against
  // an empty one, and anything else means the owner approved a different
  // situation from the one in front of us.
  if (overriding) return false;
  return matches !== row.duplicate.database.matchCount;
}

/**
 * The id this credit binds to, `null` for a text-only reference, or the
 * sentinel that fails the row.
 *
 * There is no insert-now-patch-later: the column has no UPDATE path, so a
 * target that is not available at this moment is a failure rather than
 * something to reconcile afterwards.
 *
 * The target id is never taken from the request. Preview reports what a credit
 * resolves TO, in owner-safe terms and with no database id in it, and the id is
 * found here — inside the tenant transaction, by the identity Preview resolved.
 */
async function resolveReversalTarget(
  tx: TenantTx,
  businessId: number,
  row: HistoricalPreviewRow,
  createdIds: Map<number, number>
): Promise<number | null | "UNRESOLVED"> {
  switch (row.reversalTarget) {
    case "ROW_TO_BE_CREATED": {
      // A target created earlier in THIS run. Source order is what makes it
      // available, which is why the loop never reorders.
      const target = row.reversal.targetSourceRow;
      if (target === null) return "UNRESOLVED";
      const id = createdIds.get(target);
      return id === undefined ? "UNRESOLVED" : id;
    }
    case "EXISTING_RECORD": {
      const identity = identityOf(row);
      const reference = valueOf(row, "מספר מסמך שמזוכה");
      if (!identity || !reference) return "UNRESOLVED";

      // The same scope Preview resolved under: this tenant, this source
      // system, that document number, and a type that can be credited. If it is
      // no longer exactly one, the world moved after approval and the row says
      // so rather than binding to whichever came back first.
      const candidates = await tx.historicalFiscalDocument.findMany({
        where: {
          businessId,
          sourceSystemCode: identity.sourceSystemCode,
          originalDocumentNumber: reference,
          documentTypeCode: { in: ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT"] },
        },
        select: { id: true },
        take: 2,
      });
      return candidates.length === 1 ? candidates[0].id : "UNRESOLVED";
    }
    default:
      // TEXT_ONLY, ROW_NOT_BEING_CREATED and NOT_APPLICABLE all persist the raw
      // number with no relation — which is exactly what the model was built for.
      return null;
  }
}

/* -------------------------------------------------------- field access -- */

function rawOf(row: HistoricalPreviewRow, field: string): string | null {
  const value = row.values.find((v) => v.field === field)?.original ?? "";
  return value === "" ? null : value;
}

function dateOf(row: HistoricalPreviewRow): Date | null {
  const value = valueOf(row, "תאריך המסמך");
  return value === null ? null : fiscalDateToUtcDate(value);
}

function amountOf(row: HistoricalPreviewRow, field: string): Prisma.Decimal | null {
  const value = valueOf(row, field);
  return value === null ? null : fiscalAmountToDecimal(value);
}
