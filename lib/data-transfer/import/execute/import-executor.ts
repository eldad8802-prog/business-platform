/**
 * Execution — the only place I-6 turns an approved preview into records.
 *
 * The flow, and why it is in this order:
 *
 *   1. verify the attestation            proves the file, mapping and decisions
 *                                        are the ones the owner approved
 *   2. RE-DERIVE every row from bytes    the client is never believed about
 *                                        what a row contains
 *   3. re-validate the decisions         a signature proves a decision was not
 *                                        altered, not that it was legitimate
 *   4. open or resume the run            replay lands on the existing run
 *   5. execute in batches                marker + record in one transaction
 *   6. terminalize with counts           an audit snapshot that outlives rows
 *
 * # The one ordering detail that matters inside a row
 *
 * The MARKER is inserted before the business write. Both are in the same
 * transaction, so atomicity is identical either way — but the order lets the
 * two possible unique-violations be told apart, which they otherwise could not
 * be, because a failed statement poisons the whole transaction and nothing
 * after it can run (measured; see `execution-semantics.ts`).
 *
 *   marker insert violates the PK   another execution already did this row
 *   business write violates unique  the data changed since the preview
 *
 * The first is not a failure at all and must not be counted as one. The second
 * is a real, reportable outcome for that row. Tracking which statement was in
 * flight is what separates them.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import { deriveImportRows } from "@/lib/data-transfer/import/derive-rows";
import {
  canonicalizeMapping,
  type ResolvedMapping,
} from "@/lib/data-transfer/import/mapping/mapping-proposer";
import {
  sha256Hex,
  verifyPreviewToken,
} from "@/lib/data-transfer/import/preview/preview-token";
import {
  decisionsHashOf,
  resolveDecisions,
  validateDecisions,
  type DecisionProblem,
  type RowDecisions,
} from "@/lib/data-transfer/import/execute/row-decisions";
import {
  classifyRowFailure,
  planBatches,
  rowsStillToExecute,
  runOutcomeFor,
  type RowErrorCode,
} from "@/lib/data-transfer/import/execute/execution-semantics";
import { writerFor } from "@/lib/data-transfer/import/execute/domain-writers";
import {
  findExistingRun,
  loadExecutedRowNumbers,
  loadRunRows,
  markFailedRow,
  markRow,
  openOrResumeRun,
  terminalizeRun,
} from "@/lib/data-transfer/import/execute/import-run-store";
import type { ValidatedRow } from "@/lib/data-transfer/import/validate/row-validate";

export type ExecuteInput = {
  businessId: number;
  userId: number;
  domainId: DataTransferDomainId;
  filename: string;
  bytes: Buffer;
  sheetName: string | null;
  mapping: ResolvedMapping;
  decisions: RowDecisions;
  previewToken: string;
};

export type ExecuteFailureRow = {
  rowNumber: number;
  code: RowErrorCode;
  message: string;
};

export type ExecuteResult =
  | {
      ok: true;
      importRunId: number;
      /**
       * EXECUTING means rows are still unaccounted for — every one of them lost
       * to a transient failure, and every one of them retryable by submitting
       * this same request again.
       */
      status: "COMPLETED" | "PARTIAL" | "FAILED" | "EXECUTING";
      /** True when the request resolved to a run that had already finished. */
      alreadyExecuted: boolean;
      /** Rows neither created, skipped nor failed. Non-zero only when EXECUTING. */
      unexecutedRows: number;
      counts: {
        totalRows: number;
        createdCount: number;
        skippedCount: number;
        failedCount: number;
      };
      failures: ExecuteFailureRow[];
    }
  | {
      ok: false;
      code: string;
      message: string;
      decisionProblems?: DecisionProblem[];
    };

/** A row queued for execution, with everything the writer needs. */
type PlannedRow = {
  rowNumber: number;
  action: "CREATE" | "SKIP";
  validated: ValidatedRow;
};

export async function executeImport(
  input: ExecuteInput
): Promise<ExecuteResult> {
  /* ---- 1. the attestation ------------------------------------------- */

  const token = verifyPreviewToken(input.previewToken);
  if (!token.ok) {
    return {
      ok: false,
      code: `TOKEN_${token.reason}`,
      message:
        token.reason === "EXPIRED"
          ? "תוקף הבדיקה פג. יש להריץ בדיקה מחדש."
          : "אישור הבדיקה אינו תקין. יש להריץ בדיקה מחדש.",
    };
  }

  const facts = token.facts;
  const contentHash = sha256Hex(input.bytes);
  const mappingHash = sha256Hex(canonicalizeMapping(input.mapping));
  const decisionsHash = decisionsHashOf(input.decisions);

  // Every one of these is recomputed here, never taken from the request.
  // The tenant check is first: a token minted for another business must not
  // even reach the file comparison.
  if (facts.businessId !== input.businessId) {
    return {
      ok: false,
      code: "TOKEN_WRONG_TENANT",
      message: "אישור הבדיקה אינו שייך לעסק הזה.",
    };
  }
  if (
    facts.domain !== input.domainId ||
    facts.contentHash !== contentHash ||
    facts.mappingHash !== mappingHash ||
    facts.decisionsHash !== decisionsHash ||
    (facts.sheetName ?? null) !== (input.sheetName ?? null)
  ) {
    return {
      ok: false,
      code: "TOKEN_MISMATCH",
      message: "הקובץ או הבחירות השתנו מאז הבדיקה. יש להריץ בדיקה מחדש.",
    };
  }

  /* ---- 2. re-derive, 3. re-validate --------------------------------- */

  const derived = await deriveImportRows({
    businessId: input.businessId,
    domainId: input.domainId,
    filename: input.filename,
    bytes: input.bytes,
    sheetName: input.sheetName,
    mapping: input.mapping,
  });
  if (!derived.ok) {
    return { ok: false, code: derived.code, message: derived.message };
  }
  if (derived.counts.totalRows !== facts.rowCount) {
    return {
      ok: false,
      code: "TOKEN_MISMATCH",
      message: "מספר השורות בקובץ השתנה מאז הבדיקה. יש להריץ בדיקה מחדש.",
    };
  }

  /* ---- 4. resolve the run BEFORE re-validating decisions -------------- */
  //
  // Order matters, and getting it wrong is a real bug that a real database
  // caught: validating first means a RETRY is judged against a world the run
  // itself changed. The second attempt at an inventory import was refused with
  // "you may not create a row whose SKU already exists" — about the row it had
  // just created. A lost response would have left the owner unable to confirm
  // anything, told to re-run a check that now shows every row as a duplicate.
  //
  // An existing run is proof that these exact decisions were already validated:
  // the run's identity IS (file, mapping, decisions), and only a validated set
  // is ever allowed to create one.

  const existing = await findExistingRun({
    businessId: input.businessId,
    contentHash,
    mappingHash,
    decisionsHash,
  });

  if (existing && existing.status !== "EXECUTING") {
    // A finished run already answered this exact request. Report what it did.
    return replayResult(input.businessId, existing.id, existing.status, {
      totalRows: derived.counts.totalRows,
      createdCount: existing.counts.createdCount ?? 0,
      skippedCount: existing.counts.skippedCount ?? 0,
      failedCount: existing.counts.failedCount ?? 0,
    });
  }

  if (!existing) {
    // First execution of this decision set: it has never been checked against
    // server truth, so it is checked now. Nothing may create a run without
    // passing here — which is what lets a resume trust an existing run.
    const decisionProblems = validateDecisions({
      domainId: input.domainId,
      rows: derived.rows,
      decisions: input.decisions,
    });
    if (decisionProblems.length > 0) {
      return {
        ok: false,
        code: "DECISIONS_INVALID",
        message: "אחת הבחירות אינה אפשרית עבור השורה שלה. יש להריץ בדיקה מחדש.",
        decisionProblems,
      };
    }
  }

  const decisions = resolveDecisions(
    input.domainId,
    derived.rows,
    input.decisions
  );

  // Still openOrResume rather than create: two requests can arrive together and
  // the unique index decides which one creates.
  const run = await openOrResumeRun({
    businessId: input.businessId,
    userId: input.userId,
    domain: input.domainId,
    contentHash,
    mappingHash,
    decisionsHash,
    sheetName: derived.sheetName,
    totalRows: derived.counts.totalRows,
  });

  if (!run.created && run.status !== "EXECUTING") {
    // Lost the create race to a request that has already finished.
    return replayResult(input.businessId, run.id, run.status, {
      totalRows: derived.counts.totalRows,
      createdCount: run.counts.createdCount ?? 0,
      skippedCount: run.counts.skippedCount ?? 0,
      failedCount: run.counts.failedCount ?? 0,
    });
  }

  /* ---- 5. execute ---------------------------------------------------- */

  const planned: PlannedRow[] = derived.rows
    .map((row) => {
      const validated = derived.validated.get(row.rowNumber);
      if (!validated) return null;
      return {
        rowNumber: row.rowNumber,
        action: decisions[row.rowNumber] ?? "SKIP",
        validated,
      };
    })
    .filter((row): row is PlannedRow => row !== null);

  const alreadyDone = await loadExecutedRowNumbers(input.businessId, run.id);
  const todo = rowsStillToExecute(planned, alreadyDone);

  const failures: ExecuteFailureRow[] = [];

  await runWithTenantContext({ businessId: input.businessId }, async () => {
    for (const batch of planBatches(todo)) {
      if (await tryBatch(input, run.id, batch)) continue;

      // The batch rolled back whole — no records and no markers — so each row
      // is re-attempted alone and its failure is attributed to it, not to its
      // neighbours.
      for (const row of batch) {
        const outcome = await runSingleRow(input, run.id, row);
        // "ALREADY_DONE" means a concurrent execution of the same run got there
        // first. Its marker is committed and will be counted below, so this
        // request neither re-counts it nor calls it a failure.
        if (typeof outcome !== "string") failures.push(outcome);
      }
    }
  });

  /* ---- 6. terminalize ------------------------------------------------ */

  // Counted from the MARKERS, not from this request's own tally. A resumed run
  // must report everything it has ever done, including the rows an earlier,
  // interrupted attempt committed — and a concurrent execution's rows too.
  const counts = await tallyFromMarkers(input.businessId, run.id);
  const outcome = runOutcomeFor({ ...counts, totalRows: derived.counts.totalRows });

  if (outcome.terminal) {
    await terminalizeRun(input.businessId, run.id, outcome.status, counts);
  }

  return {
    ok: true,
    importRunId: run.id,
    status: outcome.terminal ? outcome.status : "EXECUTING",
    alreadyExecuted: false,
    unexecutedRows: outcome.terminal ? 0 : outcome.unexecutedRows,
    counts: { totalRows: derived.counts.totalRows, ...counts },
    failures,
  };
}

/**
 * The run's true counts, read back from its markers.
 *
 * The markers are the only authority while a run is EXECUTING; the columns on
 * ImportRun are an audit snapshot written once, at terminalization, so that a
 * finished run can still report itself after its markers are cleaned up.
 */
async function tallyFromMarkers(
  businessId: number,
  importRunId: number
): Promise<{ createdCount: number; skippedCount: number; failedCount: number }> {
  const rows = await loadRunRows(businessId, importRunId);
  return {
    createdCount: rows.filter((r) => r.status === "CREATED").length,
    skippedCount: rows.filter((r) => r.status === "SKIPPED").length,
    failedCount: rows.filter((r) => r.status === "FAILED").length,
  };
}

/**
 * Tier 1 — one transaction for the whole batch.
 *
 * Returns false on ANY failure, having rolled everything in it back. It
 * deliberately does not report which row failed: after a failed statement the
 * transaction is unusable, so anything it could say about the remaining rows
 * would be a guess. Tier 2 finds out by re-running them individually.
 */
async function tryBatch(
  input: ExecuteInput,
  importRunId: number,
  batch: PlannedRow[]
): Promise<boolean> {
  if (batch.length === 0) return true;
  try {
    await withTenantTransaction(async (tx) => {
      for (const row of batch) {
        await markRow(tx, {
          importRunId,
          sourceRowNumber: row.rowNumber,
          action: row.action,
          status: row.action === "CREATE" ? "CREATED" : "SKIPPED",
        });
        if (row.action === "CREATE") {
          await writerFor(input.domainId)(
            tx,
            input.businessId,
            input.userId,
            row.validated
          );
        }
      }
    });
    return true;
  } catch {
    return false;
  }
}

type SingleRowOutcome =
  | "CREATED"
  | "SKIPPED"
  | "ALREADY_DONE"
  | ExecuteFailureRow;

/**
 * Tier 2 — one transaction for one row.
 *
 * `stage` is how a unique violation on the MARKER is told apart from one on the
 * business record. It cannot be done with two try/catch blocks inside the
 * transaction, because the first failure aborts it and the second statement
 * would never run.
 */
async function runSingleRow(
  input: ExecuteInput,
  importRunId: number,
  row: PlannedRow
): Promise<SingleRowOutcome> {
  let stage: "MARKER" | "WRITE" = "MARKER";
  try {
    await withTenantTransaction(async (tx) => {
      stage = "MARKER";
      await markRow(tx, {
        importRunId,
        sourceRowNumber: row.rowNumber,
        action: row.action,
        status: row.action === "CREATE" ? "CREATED" : "SKIPPED",
      });
      if (row.action === "CREATE") {
        stage = "WRITE";
        await writerFor(input.domainId)(
          tx,
          input.businessId,
          input.userId,
          row.validated
        );
      }
    });
    return row.action === "CREATE" ? "CREATED" : "SKIPPED";
  } catch (error) {
    const classified = classifyRowFailure(error);

    if (stage === "MARKER" && classified.code === "DUPLICATE_CHANGED") {
      // The marker's primary key, not a business constraint: this row is
      // already committed by a concurrent execution of the same run.
      return "ALREADY_DONE";
    }

    if (classified.kind === "DETERMINISTIC") {
      // Nothing committed, so the marker is written alone. It is final: the
      // same bytes under the same decisions fail the same way.
      await markFailedRow(input.businessId, {
        importRunId,
        sourceRowNumber: row.rowNumber,
        action: row.action,
        errorCode: classified.code,
      }).catch(() => {
        // If even the marker cannot be written the row simply stays absent,
        // which leaves it retryable — the safe direction.
      });
    }

    return {
      rowNumber: row.rowNumber,
      code: classified.code,
      message: classified.message,
    };
  }
}

/** Report a finished run without touching anything. */
async function replayResult(
  businessId: number,
  importRunId: number,
  status: "COMPLETED" | "PARTIAL" | "FAILED",
  counts: {
    totalRows: number;
    createdCount: number;
    skippedCount: number;
    failedCount: number;
  }
): Promise<ExecuteResult> {
  const rows = await loadRunRows(businessId, importRunId);
  return {
    ok: true,
    importRunId,
    status,
    alreadyExecuted: true,
    unexecutedRows: 0,
    counts,
    failures: rows
      .filter((r) => r.status === "FAILED")
      .map((r) => ({
        rowNumber: r.sourceRowNumber,
        code: (r.errorCode ?? "SERVICE_ERROR") as RowErrorCode,
        message: "השורה נכשלה בהרצה הקודמת",
      })),
  };
}
