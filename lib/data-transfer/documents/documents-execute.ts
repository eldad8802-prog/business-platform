/**
 * Documents import — the only place a confirmed batch becomes real documents.
 *
 * =====================================================================
 * THE INVARIANT
 *
 *   The same confirmed execution identity never creates a second Document,
 *   however many times Execute is retried — INCLUDING a deliberate duplicate
 *   override, where duplicate detection is switched off on purpose.
 * =====================================================================
 *
 * # Why the ledger alone does not establish that, and what does
 *
 * A document lives in two durability systems: object storage and PostgreSQL.
 * I-6's ledger is safe because a row marker and the record it describes commit
 * in ONE transaction, so "record without marker" is not a state the database
 * can hold. Reaching for the same ledger from a domain that also writes object
 * storage does NOT inherit that property for free. Written naively —
 *
 *     await ingestDocument(...)          // Document committed
 *     await markRow(...)                 // separate transaction
 *
 * — the gap between the two lines is exactly the failure the whole increment
 * exists to prevent. A crash there leaves a Document with no marker, a retry
 * sees an unexecuted position, and creates it again. Duplicate detection would
 * usually mask it. For CREATE_ANYWAY it would not mask it at all, because the
 * owner has explicitly turned that check off — so the second copy would be
 * created silently and the ledger would never know.
 *
 * The fix is not a check, it is an ordering. `ingestDocument` accepts a
 * `withinTransaction` hook that runs as the first statement of the transaction
 * that creates the Document row, and this module passes the marker write into
 * it. Marker and Document row therefore commit together or roll back together.
 *
 * The full sequence for one CREATE, and what each failure leaves behind:
 *
 *   storage write            fails  -> no object, no row, no marker  RETRYABLE
 *   TX { marker, Document }  fails  -> object deleted by the service's own
 *                                      orphan cleanup; no row, no marker
 *                                                                    RETRYABLE
 *   TX commits                      -> row AND marker, indivisibly   DONE
 *   after() scheduling       fails  -> row and marker stand; extraction is
 *                                      what is missing, not ingestion
 *   response lost                   -> retry finds the marker, does nothing
 *
 * There is no ordering of those steps that produces "Document created, marker
 * missing". That is the proof, and it does not depend on duplicate detection,
 * which is why it holds for CREATE_ANYWAY too.
 *
 * # Per file, not per batch
 *
 * I-6 attempts a batch of rows in one transaction and falls back to one
 * transaction per row on failure. That tier exists to amortise transaction cost
 * over up to 10,000 rows. Here a batch is at most 20 files and each one carries
 * an object-storage round trip that dominates everything else, so batching buys
 * no measurable throughput while costing the ability to attribute a failure to
 * the file that caused it. Each file gets its own transaction, and file 20
 * failing leaves files 1-19 durably ingested.
 *
 * # What this module does not do
 *
 * It does not hash, store, create, schedule extraction or clean up orphans.
 * Every one of those belongs to `ingestDocument`, and reproducing any of them
 * here would be the second ingestion engine this domain is explicitly not
 * allowed to grow.
 */

import {
  ingestDocument as canonicalIngestDocument,
  type IngestDocumentResult,
} from "@/lib/services/documents/document-ingestion.service";
import {
  documentsBatchContentHash,
  documentsMappingHash,
  DOCUMENTS_IMPORT_MAX_FILES,
  DOCUMENTS_IMPORT_MAX_BATCH_BYTES,
} from "@/lib/data-transfer/documents/documents-import-config";
import {
  classifyStagedFiles,
  documentDecisionsHash,
  findExistingHashes as canonicalFindExistingHashes,
  isCreateAction,
  isDecisionPermitted,
  stageDocumentFiles,
  type DocumentDecisions,
  type IncomingFile,
} from "@/lib/data-transfer/documents/batch-analyze";
import { verifyPreviewToken } from "@/lib/data-transfer/import/preview/preview-token";
import {
  classifyRowFailure,
  runOutcomeFor,
  type RowErrorCode,
} from "@/lib/data-transfer/import/execute/execution-semantics";
import {
  countRunRowsByStatus as canonicalCountRunRowsByStatus,
  findExistingRun as canonicalFindExistingRun,
  loadExecutedRowNumbers as canonicalLoadExecutedRowNumbers,
  loadFailedRunRows as canonicalLoadFailedRunRows,
  markFailedRow as canonicalMarkFailedRow,
  markRow,
  markSkippedRow as canonicalMarkSkippedRow,
  openOrResumeRun as canonicalOpenOrResumeRun,
  terminalizeRun as canonicalTerminalizeRun,
} from "@/lib/data-transfer/import/execute/import-run-store";

export type ExecuteDocumentsInput = {
  /** Server-derived from the session. Absent from the request body. */
  businessId: number;
  userId: number;
  /** The files, re-uploaded, in the order they were previewed. */
  files: readonly IncomingFile[];
  decisions: DocumentDecisions;
  previewToken: string;
  sessionId?: string | null;
};

export type DocumentFailureRow = {
  /** 1-based position in the batch. */
  position: number;
  filename: string;
  code: RowErrorCode;
  message: string;
};

export type DocumentResultRow = {
  position: number;
  filename: string;
  outcome: "CREATED" | "SKIPPED" | "FAILED";
  /** Owner-facing Hebrew. Never a technical code. */
  message: string;
};

export type ExecuteDocumentsResult =
  | {
      ok: true;
      importRunId: number;
      status: "COMPLETED" | "PARTIAL" | "FAILED" | "EXECUTING";
      /** True when this request resolved to a run that had already finished. */
      alreadyExecuted: boolean;
      unexecutedFiles: number;
      counts: {
        totalFiles: number;
        createdCount: number;
        skippedCount: number;
        failedCount: number;
      };
      files: DocumentResultRow[];
      failures: DocumentFailureRow[];
    }
  | { ok: false; code: string; message: string; position?: number };

/**
 * Everything this module reaches outside itself.
 *
 * The defaults ARE the canonical implementations and a structural test asserts
 * so. They are injectable for one reason: the failure this increment is built
 * to prevent — a Document committed without its marker — cannot be demonstrated
 * against a real database without deliberately corrupting one. With ports, a
 * test can drive every crash point and assert what the ledger holds afterwards.
 */
export type ExecutePorts = {
  ingest: typeof canonicalIngestDocument;
  findExistingHashes: typeof canonicalFindExistingHashes;
  findExistingRun: typeof canonicalFindExistingRun;
  openOrResumeRun: typeof canonicalOpenOrResumeRun;
  loadExecutedRowNumbers: typeof canonicalLoadExecutedRowNumbers;
  markSkippedRow: typeof canonicalMarkSkippedRow;
  markFailedRow: typeof canonicalMarkFailedRow;
  countRunRowsByStatus: typeof canonicalCountRunRowsByStatus;
  terminalizeRun: typeof canonicalTerminalizeRun;
  loadFailedRunRows: typeof canonicalLoadFailedRunRows;
};

export const CANONICAL_PORTS: ExecutePorts = {
  ingest: canonicalIngestDocument,
  findExistingHashes: canonicalFindExistingHashes,
  findExistingRun: canonicalFindExistingRun,
  openOrResumeRun: canonicalOpenOrResumeRun,
  loadExecutedRowNumbers: canonicalLoadExecutedRowNumbers,
  markSkippedRow: canonicalMarkSkippedRow,
  markFailedRow: canonicalMarkFailedRow,
  countRunRowsByStatus: canonicalCountRunRowsByStatus,
  terminalizeRun: canonicalTerminalizeRun,
  loadFailedRunRows: canonicalLoadFailedRunRows,
};

function reject(
  code: string,
  message: string,
  position?: number
): ExecuteDocumentsResult {
  return { ok: false, code, message, position };
}

const RETRY_LATER = "יש להריץ בדיקה מחדש.";

export async function executeDocumentImport(
  input: ExecuteDocumentsInput,
  ports: ExecutePorts = CANONICAL_PORTS
): Promise<ExecuteDocumentsResult> {
  /* ---- 1. limits, before anything is believed ------------------------ */

  if (input.files.length === 0) {
    return reject("NO_FILES", "לא נבחרו קבצים.");
  }
  if (input.files.length > DOCUMENTS_IMPORT_MAX_FILES) {
    return reject(
      "TOO_MANY_FILES",
      `אפשר לקלוט עד ${DOCUMENTS_IMPORT_MAX_FILES} קבצים בבת אחת.`
    );
  }
  const totalBytes = input.files.reduce((sum, f) => sum + f.buffer.length, 0);
  if (totalBytes > DOCUMENTS_IMPORT_MAX_BATCH_BYTES) {
    const mb = Math.round(DOCUMENTS_IMPORT_MAX_BATCH_BYTES / 1024 / 1024);
    return reject("BATCH_TOO_LARGE", `סך הקבצים גדול מדי (עד ${mb}MB).`);
  }

  /* ---- 2. the attestation -------------------------------------------- */

  const token = verifyPreviewToken(input.previewToken);
  if (!token.ok) {
    return reject(
      `TOKEN_${token.reason}`,
      token.reason === "EXPIRED"
        ? `תוקף הבדיקה פג. ${RETRY_LATER}`
        : `אישור הבדיקה אינו תקין. ${RETRY_LATER}`
    );
  }
  const facts = token.facts;

  // Tenant first: a token minted for another business must not even reach the
  // file comparison, let alone tell the holder whether their bytes matched.
  if (facts.businessId !== input.businessId) {
    return reject("TOKEN_WRONG_TENANT", "אישור הבדיקה אינו שייך לעסק הזה.");
  }
  if (facts.userId !== input.userId) {
    return reject("TOKEN_WRONG_USER", `אישור הבדיקה אינו שייך למשתמש הזה. ${RETRY_LATER}`);
  }
  if (facts.domain !== "documents") {
    return reject("TOKEN_WRONG_DOMAIN", `אישור הבדיקה שייך לייבוא אחר. ${RETRY_LATER}`);
  }
  if (facts.mappingHash !== documentsMappingHash()) {
    return reject("TOKEN_WRONG_MAPPING", `אישור הבדיקה שייך לייבוא אחר. ${RETRY_LATER}`);
  }
  if ((facts.sheetName ?? null) !== null) {
    return reject("TOKEN_WRONG_MAPPING", `אישור הבדיקה שייך לייבוא אחר. ${RETRY_LATER}`);
  }

  /* ---- 3. re-derive every file fact from the bytes -------------------- */
  //
  // The SAME staging function the preview used — one implementation, so the two
  // cannot drift apart. Re-running it is not redundant: the declared MIME type
  // is not covered by the content hash, so identical bytes can be re-submitted
  // under a different declared type and must be re-checked against the file's
  // actual signature here.

  const { staged, contentHashes } = stageDocumentFiles(input.files);

  if (input.files.length !== facts.rowCount) {
    return reject("TOKEN_MISMATCH", `הקבצים השתנו מאז הבדיקה. ${RETRY_LATER}`);
  }
  if (documentsBatchContentHash(contentHashes) !== facts.contentHash) {
    // Covers a changed byte, a reordering, a removed file and an added one.
    return reject("TOKEN_MISMATCH", `הקבצים השתנו מאז הבדיקה. ${RETRY_LATER}`);
  }
  if (documentDecisionsHash(input.decisions) !== facts.decisionsHash) {
    return reject("TOKEN_MISMATCH", `הבחירות השתנו מאז הבדיקה. ${RETRY_LATER}`);
  }

  // A file the acceptance rules now refuse must never be written, whatever the
  // owner confirmed. This is checked before any run is opened: a batch that
  // cannot be executed honestly should leave no ledger trace at all.
  for (const file of staged) {
    const action = input.decisions[file.index];
    if (action && isCreateAction(action) && file.status === "UNSUPPORTED") {
      return reject(
        "FILE_REJECTED",
        `אחד הקבצים אינו עומד בבדיקת התקינות. ${RETRY_LATER}`,
        file.index + 1
      );
    }
  }

  /* ---- 4. resolve the run BEFORE re-validating decisions -------------- */
  //
  // I-6's truth-order lesson, and it is if anything sharper here. Execution
  // CHANGES the world the decisions are judged against: a file created by the
  // first attempt is, by the second attempt, a document the business already
  // holds. Re-validating first would refuse the resumed run's own CREATE
  // decisions as "this file already exists" — about files it created itself —
  // and the run could never be finished.
  //
  // An existing run is proof these exact decisions were already validated: the
  // run's identity IS (business, batch bytes, mapping sentinel, decisions), and
  // only a validated decision set is ever allowed to create one.

  const contentHash = documentsBatchContentHash(contentHashes);
  const mappingHash = documentsMappingHash();
  const decisionsHash = documentDecisionsHash(input.decisions);

  const existing = await ports.findExistingRun({
    businessId: input.businessId,
    contentHash,
    mappingHash,
    decisionsHash,
  });

  if (existing && existing.status !== "EXECUTING") {
    return replay(ports, input, existing.id, existing.status, staged, {
      totalFiles: input.files.length,
      createdCount: existing.counts.createdCount ?? 0,
      skippedCount: existing.counts.skippedCount ?? 0,
      failedCount: existing.counts.failedCount ?? 0,
    });
  }

  if (!existing) {
    // First execution of this decision set. It has never been checked against
    // server truth, so it is checked now — and nothing may open a run without
    // passing here, which is what lets a resume trust an existing run.
    const analyzed = classifyStagedFiles(
      staged,
      await ports.findExistingHashes(
        input.businessId,
        staged.filter((f) => f.status === "NEW").map((f) => f.hash)
      )
    );
    for (const file of analyzed) {
      const action = input.decisions[file.index];
      if (!action) {
        return reject("DECISION_MISSING", `חסרה בחירה עבור אחד הקבצים. ${RETRY_LATER}`, file.index + 1);
      }
      if (!isDecisionPermitted(file, action)) {
        return reject(
          "DECISION_NOT_PERMITTED",
          "לא ניתן לקלוט את אחד הקבצים שנבחרו.",
          file.index + 1
        );
      }
    }
  }

  const run = await ports.openOrResumeRun({
    businessId: input.businessId,
    userId: input.userId,
    domain: "documents",
    contentHash,
    mappingHash,
    decisionsHash,
    // Documents have no worksheet. The mapping sentinel already says this
    // domain has no mapping contract; this stays null rather than inventing a
    // second place to say it.
    sheetName: null,
    totalRows: input.files.length,
  });

  if (!run.created && run.status !== "EXECUTING") {
    // Lost the create race to a request that has already finished.
    return replay(ports, input, run.id, run.status, staged, {
      totalFiles: input.files.length,
      createdCount: run.counts.createdCount ?? 0,
      skippedCount: run.counts.skippedCount ?? 0,
      failedCount: run.counts.failedCount ?? 0,
    });
  }

  /* ---- 5. execute, one file at a time --------------------------------- */

  const alreadyDone = await ports.loadExecutedRowNumbers(
    input.businessId,
    run.id
  );

  const results: DocumentResultRow[] = [];
  const failures: DocumentFailureRow[] = [];

  for (const file of staged) {
    const position = file.index + 1; // 1-based, the ledger's sourceRowNumber
    if (alreadyDone.has(position)) continue; // committed by an earlier attempt

    const action = input.decisions[file.index] ?? "SKIP";

    if (!isCreateAction(action)) {
      try {
        await ports.markSkippedRow(input.businessId, {
          importRunId: run.id,
          sourceRowNumber: position,
          action: "SKIP",
        });
        results.push({
          position,
          filename: file.filename,
          outcome: "SKIPPED",
          message: file.reason || "לא נקלט לפי בחירתכם.",
        });
      } catch (error) {
        // A primary-key clash means a concurrent execution already accounted
        // for this position, which is not a failure and not this request's news
        // to report. Anything else leaves the position absent, and therefore
        // retryable — the safe direction — but it is worth saying so in the log
        // rather than vanishing.
        if (classifyRowFailure(error).code !== "DUPLICATE_CHANGED") {
          console.warn("[documents-import] skip marker not written", {
            businessId: input.businessId,
            importRunId: run.id,
            position,
          });
        }
      }
      continue;
    }

    const outcome = await createOne(ports, input, run.id, position, file);
    if (outcome.kind === "ALREADY_DONE") continue;
    if (outcome.kind === "CREATED") {
      results.push({
        position,
        filename: file.filename,
        outcome: "CREATED",
        message: "נקלט. הזיהוי יוצג לאישורכם במסך המסמכים.",
      });
      continue;
    }
    failures.push({
      position,
      filename: file.filename,
      code: outcome.code,
      message: outcome.message,
    });
    results.push({
      position,
      filename: file.filename,
      outcome: "FAILED",
      message: outcome.message,
    });
  }

  /* ---- 6. terminalize from the markers -------------------------------- */
  //
  // Counted from what is committed, never from this request's own tally: a
  // resumed run must report everything it has ever done, including the files an
  // interrupted attempt already ingested.

  const counts = await ports.countRunRowsByStatus(input.businessId, run.id);
  const outcome = runOutcomeFor({ ...counts, totalRows: input.files.length });

  if (outcome.terminal) {
    await ports.terminalizeRun(
      input.businessId,
      run.id,
      outcome.status,
      counts
    );
  }

  return {
    ok: true,
    importRunId: run.id,
    status: outcome.terminal ? outcome.status : "EXECUTING",
    alreadyExecuted: false,
    unexecutedFiles: outcome.terminal ? 0 : outcome.unexecutedRows,
    counts: { totalFiles: input.files.length, ...counts },
    files: results,
    failures,
  };
}

/**
 * Commit a terminal marker that has no business write to be atomic with.
 *
 * The interesting return is ALREADY_MARKED. The marker's primary key is
 * (run, position), so a clash is not a failure to record something — it is the
 * ledger telling us a concurrent execution of this same run has already
 * accounted for this position. Reporting a failure to the owner at that point
 * would be false: the file is fine, and the counts read back from the markers
 * will say so.
 */
async function commitTerminalMarker(
  ports: ExecutePorts,
  businessId: number,
  marker: {
    importRunId: number;
    sourceRowNumber: number;
    action: "CREATE" | "SKIP";
    errorCode: RowErrorCode;
  }
): Promise<"WRITTEN" | "ALREADY_MARKED" | "LOST"> {
  try {
    await ports.markFailedRow(businessId, marker);
    return "WRITTEN";
  } catch (error) {
    if (classifyRowFailure(error).code === "DUPLICATE_CHANGED") {
      return "ALREADY_MARKED";
    }
    // The marker could not be written at all, so the position stays absent —
    // which leaves it retryable, the safe direction.
    return "LOST";
  }
}

type CreateOutcome =
  | { kind: "CREATED" }
  | { kind: "ALREADY_DONE" }
  | { kind: "FAILED"; code: RowErrorCode; message: string };

/**
 * Ingest one file, with its execution marker in the same transaction.
 *
 * `markerWritten` is how a unique violation raised by the MARKER is told apart
 * from one raised by the Document write. It cannot be done with two try/catch
 * blocks inside the transaction: the first failed statement aborts it and the
 * second would never run — so the only way to distinguish them is to know which
 * one was in flight, which is what this flag records.
 */
async function createOne(
  ports: ExecutePorts,
  input: ExecuteDocumentsInput,
  importRunId: number,
  position: number,
  file: { index: number; filename: string; mimeType: string; hash: string }
): Promise<CreateOutcome> {
  const action = input.decisions[file.index];
  const source = input.files[file.index];
  let markerWritten = false;

  let result: IngestDocumentResult;
  try {
    result = await ports.ingest({
      businessId: input.businessId,
      userId: input.userId,
      buffer: source.buffer,
      // The RE-VERIFIED type from staging, not the raw declared value.
      mimeType: file.mimeType,
      originalFilename: file.filename,
      sizeBytes: source.buffer.length,
      // Provenance stays "file": these are files the owner selected. See the
      // origin decision in the increment report — a dedicated IMPORT origin is
      // a deferred should-have, not something idempotency depends on.
      source: "file",
      // Read from the SIGNED decision, never from a fresh duplicate lookup.
      // Deriving it from execute-time truth would silently read a plain CREATE
      // on a newly-appeared duplicate as an override the owner never gave.
      allowDuplicate: action === "CREATE_ANYWAY",
      sessionId: input.sessionId ?? null,
      withinTransaction: async (tx) => {
        await markRow(tx, {
          importRunId,
          sourceRowNumber: position,
          action: "CREATE",
          status: "CREATED",
        });
        markerWritten = true;
      },
    });
  } catch (error) {
    const classified = classifyRowFailure(error);

    if (!markerWritten && classified.code === "DUPLICATE_CHANGED") {
      // The marker's primary key, not a business constraint: a concurrent
      // execution of this same run already committed this position. Its work is
      // counted from the markers below, so this is neither a failure nor a
      // second attempt.
      return { kind: "ALREADY_DONE" };
    }

    if (classified.kind === "DETERMINISTIC") {
      // Nothing committed — the transaction rolled back and the service already
      // removed the stored object — so the FAILED marker is written alone. It
      // is final: the same bytes under the same decision fail the same way.
      const marked = await commitTerminalMarker(ports, input.businessId, {
        importRunId,
        sourceRowNumber: position,
        action: "CREATE",
        errorCode: classified.code,
      });
      if (marked === "ALREADY_MARKED") return { kind: "ALREADY_DONE" };
    }
    return { kind: "FAILED", code: classified.code, message: classified.message };
  }

  if (!result.ok) {
    // Drift: the preview said this file was new, and it is not any more. The
    // service returned before writing anything, so nothing needs undoing. It is
    // deliberately NOT re-decided as an override — the owner never confirmed
    // one for this file, and silently creating it would be exactly the silent
    // re-decision the drift rule exists to forbid.
    //
    // One case looks like drift and is not: a concurrent execution of this same
    // run created the file a moment ago, so the duplicate the service found is
    // this run's own work. The marker's primary key is what distinguishes them
    // — if this position is already marked, nothing failed.
    const marked = await commitTerminalMarker(ports, input.businessId, {
      importRunId,
      sourceRowNumber: position,
      action: "CREATE",
      errorCode: "DUPLICATE_CHANGED",
    });
    if (marked === "ALREADY_MARKED") return { kind: "ALREADY_DONE" };
    return {
      kind: "FAILED",
      code: "DUPLICATE_CHANGED",
      message: "הקובץ נוסף לדוביז אחרי הבדיקה, ולכן לא נקלט שוב.",
    };
  }

  return { kind: "CREATED" };
}

/** Report a run that already finished, without touching anything. */
async function replay(
  ports: ExecutePorts,
  input: ExecuteDocumentsInput,
  importRunId: number,
  status: "COMPLETED" | "PARTIAL" | "FAILED",
  staged: readonly { index: number; filename: string }[],
  counts: {
    totalFiles: number;
    createdCount: number;
    skippedCount: number;
    failedCount: number;
  }
): Promise<ExecuteDocumentsResult> {
  const failed = await ports.loadFailedRunRows(input.businessId, importRunId);
  const nameAt = new Map(staged.map((f) => [f.index + 1, f.filename]));
  return {
    ok: true,
    importRunId,
    status,
    alreadyExecuted: true,
    unexecutedFiles: 0,
    counts,
    files: [],
    failures: failed.map((r) => ({
      position: r.sourceRowNumber,
      filename: nameAt.get(r.sourceRowNumber) ?? "",
      code: (r.errorCode ?? "SERVICE_ERROR") as RowErrorCode,
      message: "הקובץ לא נקלט בהרצה הקודמת.",
    })),
  };
}
