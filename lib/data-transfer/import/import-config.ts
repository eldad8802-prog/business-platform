/**
 * Import limits — ONE place, enforced on the SERVER.
 *
 * These are the owner-approved product limits for the first wave, not engine
 * tuning: a file this size is what a small business plausibly has, and anything
 * beyond it is a signal to split rather than a request to serve.
 *
 * Client-side checks exist only to fail fast and politely. Every one of these
 * is re-checked server-side, because a client check is a courtesy and a server
 * check is the rule.
 */

/** Largest tabular upload accepted, in bytes. */
export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Largest number of DATA rows accepted (header excluded). */
export const IMPORT_MAX_ROWS = 10_000;

/**
 * Rows shown to the owner in the preview response.
 *
 * The preview must stay usable at 10,000 rows, and a 10,000-row JSON payload is
 * not a preview — it is the file again. The response carries a bounded window
 * plus complete COUNTS, so the summary is always exact even when the row list
 * is not exhaustive.
 */
export const IMPORT_PREVIEW_ROW_WINDOW = 100;

/** Sample values shown per column while the owner reviews the mapping. */
export const IMPORT_MAPPING_SAMPLE_VALUES = 3;

/**
 * How long a preview stays confirmable.
 *
 * Short on purpose: the token attests that a specific file, mapped a specific
 * way, was analyzed for a specific business. The longer that assertion lives,
 * the longer a captured token is useful to someone who should not have it.
 */
export const IMPORT_PREVIEW_TTL_SECONDS = 30 * 60;

/** Accepted upload types, by extension and by declared MIME. */
export const IMPORT_ACCEPTED_EXTENSIONS = [".xlsx", ".csv"] as const;

export const IMPORT_ACCEPTED_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
  "text/plain",
  // Browsers and Windows disagree about CSV; some send this for .csv files.
  "application/vnd.ms-excel",
  // Firefox occasionally sends an empty type for a drag-and-dropped file.
  "",
] as const;

/**
 * Rows attempted per execution transaction.
 *
 * 200 keeps a batch's lock footprint and duration small enough for a serverless
 * request while still amortising round trips: at 10,000 rows that is 50 commits,
 * not 10,000. It is also the unit of ROLLBACK — see `execution-semantics.ts`,
 * which explains why a failure discards the whole batch and re-runs it one row
 * at a time rather than continuing past the error.
 */
export const IMPORT_EXECUTE_BATCH_SIZE = 200;

/**
 * Interactive-transaction budget for ONE execution batch, in milliseconds.
 *
 * Prisma's default is 5 seconds, and a batch is 200 rows each doing a marker
 * insert plus a full domain-service create — an inventory row also writes a
 * stock movement. Against a serverless database that is comfortably more than
 * five seconds of round trips, and the default was observed being exceeded on a
 * real remote database.
 *
 * Exceeding it is not a correctness problem: the batch rolls back whole and
 * every row is retried individually, so the outcome stays right. It is a
 * performance cliff — the expensive path taken for no reason — and it makes a
 * normal import look like a failing one.
 *
 * Sized to sit well inside the route's own 300s ceiling.
 */
export const IMPORT_EXECUTE_BATCH_TIMEOUT_MS = 60_000;
