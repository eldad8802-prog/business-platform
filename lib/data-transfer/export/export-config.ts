/**
 * Export engine tuning — ONE place, so a limit is never a magic number buried
 * in a query.
 *
 * These are not product limits (those arrive with Import, where a file the
 * owner uploads has to be bounded). These are the engine's own safety numbers:
 * how much it reads at a time, and how much it is willing to hold in memory
 * before it refuses rather than dies.
 */

/**
 * Rows fetched per keyset page.
 *
 * 500 is a deliberate middle: large enough that a 10k-row export is 20 short
 * transactions rather than 200, small enough that one page is a few hundred KB
 * and a slow page cannot hold a transaction open long. Raising it trades
 * transaction duration for round-trips — measure before changing.
 */
export const EXPORT_BATCH_SIZE = 500;

/**
 * Hard ceiling on rows materialized for a single domain.
 *
 * WHY A CEILING EXISTS AT ALL: ExcelJS builds the entire workbook in memory
 * before a single byte can be written, so an export's peak memory is a function
 * of TOTAL rows, not of page size. A serverless function that exceeds its
 * memory is KILLED — the caller sees a truncated connection, not an error. A
 * refusal the owner can read ("too much data, select fewer areas") is strictly
 * better than a process that disappears.
 *
 * MEASURED, not guessed — `scripts/qa/data-transfer/export-memory-probe.ts`,
 * 10 mixed-type Hebrew columns, node 24, peak heap DELTA over the row array:
 *
 *     rows      build     peak heap    xlsx artifact
 *     1,000     278ms      17.4 MB      0.1 MB
 *     10,000    1.2s       95.4 MB      0.5 MB
 *     25,000    2.8s      247.8 MB      1.2 MB
 *     50,000    5.4s      746.7 MB      2.3 MB
 *     100,000   20.6s    1335.4 MB      4.7 MB
 *
 * Growth is super-linear past ~25k. A serverless Node function is assumed to
 * have 1024 MB; the peak above is a DELTA that does not include the source rows
 * the request is already holding, so the real requirement is roughly double.
 * 20,000 rows (~200 MB delta, ~300-400 MB in practice) leaves genuine headroom;
 * the 50,000 this file first carried would not have — it was a guess, and the
 * probe is why it is not shipping.
 *
 * CSV is ~20x cheaper (100,000 rows in 1.25s), but the ceiling is deliberately
 * format-INDEPENDENT: the owner picks the format after the selection, and a
 * limit that moves under them is worse than one that is simply predictable.
 *
 * Raising these means changing the shape of the work — streamed XLSX, or an
 * async job — not raising the number.
 */
export const EXPORT_MAX_ROWS_PER_DOMAIN = 20_000;

/**
 * Ceiling across ALL selected domains in one request.
 *
 * Lower than 4x the per-domain ceiling on purpose: a multi-domain XLSX is ONE
 * workbook, so four domains share a single memory peak rather than each getting
 * their own.
 */
export const EXPORT_MAX_ROWS_TOTAL = 30_000;

/**
 * Serverless wall-clock budget for an export request. Matches the value the
 * accountant pack already uses for the same class of work (fetch many rows,
 * assemble one artifact, respond).
 */
export const EXPORT_MAX_DURATION_SECONDS = 60;
