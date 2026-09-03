/**
 * What happens when a row fails — batch rollback, markers, and retry.
 *
 * # The measurement this file is built on
 *
 * The obvious design is to run a batch of rows in one transaction, catch the
 * failures, and keep going. It does not work, and this was verified against the
 * project's own PostgreSQL and Prisma rather than assumed:
 *
 *   A  insert, catch the unique violation, insert again in the SAME tx
 *      -> ERROR 25P02 "current transaction is aborted, commands ignored
 *         until end of transaction block"
 *   B  the same, but guarded by SAVEPOINT / ROLLBACK TO SAVEPOINT
 *      -> continues, 2 rows
 *   C  throw in the middle of a batch
 *      -> 0 rows survive; the whole batch is rolled back
 *
 * So a caught error is NOT a recoverable event: after it, every later statement
 * in that transaction fails too. Continuing past a failure would silently lose
 * every remaining row of the batch while reporting them as attempted.
 *
 * SAVEPOINT (B) does work, and is still rejected. It would mean emitting raw
 * savepoint statements around calls into the domain services, whose internals we
 * do not control and which may themselves open nested work. The cost of getting
 * that subtly wrong is a partially applied write, which is precisely the failure
 * this whole ledger exists to prevent. Batch size is a tuning knob; correctness
 * is not.
 *
 * # The two-tier batch
 *
 * Tier 1  attempt IMPORT_EXECUTE_BATCH_SIZE rows in one transaction.
 *         All rows commit with their markers, or none of them do (proof C).
 * Tier 2  if tier 1 failed, re-run exactly those rows one per transaction.
 *         Each row now succeeds or fails alone, and the failure is attributed to
 *         the row that actually caused it instead of to the batch.
 *
 * A batch that fails leaves NOTHING behind — no business records and no markers
 * — so tier 2 is a clean re-attempt, not a resumption of a half-applied batch.
 * The cost is bounded and paid only on failure: one wasted batch, then N single
 * transactions for that batch alone.
 *
 * # Which failures leave a marker, and why that answers the retry question
 *
 * The row marker's primary key is ("importRunId", "sourceRowNumber") and there
 * is deliberately no UPDATE policy on the table: a marker cannot be rewritten.
 * That looks like it collides with retrying a FAILED row. It does not, because
 * the two kinds of failure need opposite treatment:
 *
 *   TRANSIENT (lost connection, pool timeout, deadlock, serialization failure)
 *     The transaction rolled back, so there is no business record AND no marker.
 *     The row is simply ABSENT from the ledger. Resuming the run already treats
 *     "absent" as "not yet executed", so the row is retried by the existing rule
 *     with no update, no delete, and no primary-key collision.
 *
 *   DETERMINISTIC (the row is invalid, or the database now refuses it)
 *     Retrying the identical bytes under the identical decisions produces the
 *     identical failure. There is nothing to retry, so a FAILED marker is
 *     committed — on its own, since the batch it belonged to was rolled back and
 *     there is no business write left to be atomic with. It is immutable because
 *     what it records is finished. Fixing the row means fixing the file, which
 *     changes contentHash, which is a different run.
 *
 * So immutability costs nothing: markers only ever exist for outcomes that are
 * already final. An unrecognised error is classified TRANSIENT, because the
 * conservative mistake is to re-attempt a row that will fail again, while the
 * expensive mistake is to permanently close a row that would have succeeded.
 */

import { Prisma } from "@prisma/client";
import { IMPORT_EXECUTE_BATCH_SIZE } from "@/lib/data-transfer/import/import-config";

/** Terminal-for-this-run vs worth re-attempting. */
export type FailureKind = "DETERMINISTIC" | "TRANSIENT";

/**
 * Short, non-identifying failure codes. These are stored in the ledger, so they
 * must never carry a value from the file — no name, phone, SKU or barcode.
 */
export type RowErrorCode =
  | "VALIDATION_ERROR"
  | "DUPLICATE_CHANGED"
  | "CONFLICT"
  | "SERVICE_ERROR";

export type FailureClassification = {
  kind: FailureKind;
  code: RowErrorCode;
  /** Owner-facing Hebrew explanation. Never includes row values. */
  message: string;
};

/** Prisma codes that mean "the database refused this row on its merits". */
const DETERMINISTIC_PRISMA_CODES = new Set([
  "P2000", // value too long for the column
  "P2002", // unique constraint violation
  "P2003", // foreign key constraint violation
  "P2004", // a database constraint failed
  "P2005", // invalid value for the field's type
  "P2006", // invalid value provided
  "P2011", // null constraint violation
  "P2012", // missing a required value
  "P2019", // input error
  "P2025", // a required related record was not found
]);

/**
 * Classify a failure thrown while writing one row.
 *
 * P2002 gets its own code: it means the preview and the database disagree, which
 * in practice means the underlying data changed between preview and execute —
 * someone added that customer by hand in the meantime. The owner needs to be
 * told that specifically, because re-uploading the same file will not fix it.
 */
export function classifyRowFailure(error: unknown): FailureClassification {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return {
        kind: "DETERMINISTIC",
        code: "DUPLICATE_CHANGED",
        message: "רשומה זהה נוצרה במערכת אחרי בדיקת התצוגה המקדימה",
      };
    }
    if (DETERMINISTIC_PRISMA_CODES.has(error.code)) {
      return {
        kind: "DETERMINISTIC",
        code: "CONFLICT",
        message: "בסיס הנתונים דחה את השורה",
      };
    }
    // P1001/P1002/P1008/P1017/P2024/P2034 and anything else: worth retrying.
    return {
      kind: "TRANSIENT",
      code: "SERVICE_ERROR",
      message: "התרחשה תקלה זמנית בשמירת השורה",
    };
  }

  // A domain service rejecting its input is a statement about the row itself.
  // Every one of the four services signals this by throwing, and the row will be
  // rejected identically on every retry.
  if (error instanceof Error && isDomainValidationError(error)) {
    return {
      kind: "DETERMINISTIC",
      code: "VALIDATION_ERROR",
      message: "השורה נדחתה בבדיקת התקינות של המערכת",
    };
  }

  return {
    kind: "TRANSIENT",
    code: "SERVICE_ERROR",
    message: "התרחשה תקלה זמנית בשמירת השורה",
  };
}

/**
 * Matched by NAME rather than by `instanceof`, on purpose.
 *
 * The four services throw four different validation classes, and one of them
 * (inventory unit parsing) throws a plain TypeError. Importing all of them here
 * to test identity would couple this file to every domain and still miss the
 * TypeError. The name test is what actually distinguishes them.
 */
function isDomainValidationError(error: Error): boolean {
  return (
    error.name.endsWith("ValidationError") ||
    error.name === "TypeError" ||
    error.name === "RangeError"
  );
}

/** Split the executable rows into transaction-sized batches, in file order. */
export function planBatches<T>(
  rows: readonly T[],
  size: number = IMPORT_EXECUTE_BATCH_SIZE
): T[][] {
  if (size < 1) throw new Error("Batch size must be at least 1");
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}

export type RunCounts = {
  createdCount: number;
  skippedCount: number;
  failedCount: number;
};

export type TerminalRunStatus = "COMPLETED" | "PARTIAL" | "FAILED";

/**
 * The status a finished run terminalizes to.
 *
 * A run where the owner chose SKIP for everything is COMPLETED, not FAILED:
 * nothing went wrong, the answer was simply "import none of it". PARTIAL is
 * reserved for the genuinely mixed outcome, which is the one an owner most
 * needs to see distinctly — some records exist now and some do not.
 */
export function terminalStatusFor(counts: RunCounts): TerminalRunStatus {
  if (counts.failedCount === 0) return "COMPLETED";
  return counts.createdCount > 0 ? "PARTIAL" : "FAILED";
}

/**
 * Rows still to execute when a run is resumed after an interruption.
 *
 * "Already marked" is the ONLY reason to skip, and it is read from the markers
 * rather than from the counters: the counters are written once at
 * terminalization and say nothing about a run that never got there.
 */
export function rowsStillToExecute<T extends { rowNumber: number }>(
  rows: readonly T[],
  alreadyMarked: ReadonlySet<number>
): T[] {
  return rows.filter((row) => !alreadyMarked.has(row.rowNumber));
}

/**
 * Is the run finished, and if so how?
 *
 * A run is only terminalized when every row is accounted for. Rows lost to a
 * TRANSIENT failure are accounted for by NOTHING — no record, no marker — so
 * the run stays EXECUTING and re-submitting the identical file, mapping and
 * decisions resumes it exactly where it stopped.
 *
 * Terminalizing such a run would be the one genuinely harmful alternative:
 * `openOrResumeRun` reports a terminal run instead of continuing it, so a run
 * closed early would strand its unexecuted rows permanently while telling the
 * owner the import was done.
 */
export function runOutcomeFor(
  input: RunCounts & { totalRows: number }
):
  | { terminal: true; status: TerminalRunStatus }
  | { terminal: false; unexecutedRows: number } {
  const accounted =
    input.createdCount + input.skippedCount + input.failedCount;
  if (accounted >= input.totalRows) {
    return { terminal: true, status: terminalStatusFor(input) };
  }
  return { terminal: false, unexecutedRows: input.totalRows - accounted };
}
