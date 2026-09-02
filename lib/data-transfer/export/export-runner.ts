/**
 * The read half of the export engine: rows out of the database, safely.
 *
 * # Why keyset paging and not one query
 *
 * `findMany` with no bound loads an entire table into the function's heap
 * before a single cell is written. That works in QA, where a tenant has forty
 * customers, and dies in production, where one has forty thousand. Every read
 * here is `WHERE id > cursor ORDER BY id ASC LIMIT n`, which is index-ordered,
 * constant-cost per page, and — unlike OFFSET — cannot skip or duplicate a row
 * when data changes underneath a long export.
 *
 * # Why one short transaction per page, not one around the export
 *
 * `withTenantTransaction` opens an INTERACTIVE Prisma transaction, and Prisma's
 * interactive transactions have a timeout measured in seconds. Wrapping a
 * whole multi-domain export in one would hold a pooled connection open across
 * every page and every assembly step, and would time out on exactly the large
 * tenant the paging exists to serve. So each page gets its own short
 * transaction — the same `dbStep` shape the accountant pack already uses.
 *
 * The cost of that choice, stated plainly: an export is NOT a single database
 * snapshot. A row written between page 3 and page 4 may or may not appear. For
 * a "download a copy of my data" feature that is the right trade — a consistent
 * snapshot would mean holding a transaction open for the length of the export,
 * which is the failure mode we are avoiding.
 *
 * # Read-only
 *
 * Nothing here writes. No create, no update, no upsert, no `createMany`. The
 * verifier asserts it structurally, because "we did not mean to write" is not a
 * property, and a future edit inside a tenant transaction would have real
 * authority to do damage.
 */

import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { SheetCell } from "@/lib/data-transfer/format/table.types";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import {
  EXPORT_BATCH_SIZE,
  EXPORT_MAX_ROWS_PER_DOMAIN,
  EXPORT_MAX_ROWS_TOTAL,
} from "./export-config";
import { getExportDescriptor } from "./export-registry";
import type { ExportDomainDescriptor } from "./export-domain.types";

/** One domain's fully-read table, ready for packaging. */
export type ExportedDomainTable = {
  id: DataTransferDomainId;
  descriptor: ExportDomainDescriptor;
  rows: SheetCell[][];
};

export class ExportTooLargeError extends Error {
  readonly code = "EXPORT_TOO_LARGE";
  constructor(message: string) {
    super(message);
    this.name = "ExportTooLargeError";
  }
}

/**
 * Read every row of one domain via keyset paging.
 *
 * `businessId` MUST be server-derived. It is passed explicitly (rather than
 * read from ambient context) so that every call site has to show where its
 * tenant came from.
 */
export async function readDomainTable(
  businessId: number,
  id: DataTransferDomainId,
  budgetRows: number
): Promise<ExportedDomainTable> {
  const descriptor = getExportDescriptor(id);
  const rows: SheetCell[][] = [];
  let cursor = 0;

  const ceiling = Math.min(EXPORT_MAX_ROWS_PER_DOMAIN, budgetRows);

  for (;;) {
    // One short tenant transaction per page: ALS tenant -> GUC -> RLS.
    const page = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction((tx) =>
        descriptor.readPage(tx, businessId, cursor, EXPORT_BATCH_SIZE)
      )
    );

    if (page.cells.length === 0 || page.lastId === null) break;

    rows.push(...page.cells);

    if (rows.length > ceiling) {
      throw new ExportTooLargeError(
        `domain ${id} exceeds the export row ceiling (${ceiling})`
      );
    }

    // A short page means the table is exhausted — no extra round-trip to learn
    // what we already know.
    if (page.cells.length < EXPORT_BATCH_SIZE) break;

    // Strictly increasing: the descriptor contract guarantees id-ASC ordering,
    // so a cursor that failed to advance would mean a broken descriptor. Break
    // rather than loop forever.
    if (page.lastId <= cursor) break;
    cursor = page.lastId;
  }

  return { id, descriptor, rows };
}

/**
 * Read every selected domain, sharing one total row budget.
 *
 * Domains are read SEQUENTIALLY on purpose. Running four in parallel would open
 * four pooled connections per request for a feature nobody is waiting on
 * interactively, and would make the memory peak four tables instead of one
 * growing set.
 */
export async function readSelectedDomains(
  businessId: number,
  ids: readonly DataTransferDomainId[]
): Promise<ExportedDomainTable[]> {
  const tables: ExportedDomainTable[] = [];
  let used = 0;

  for (const id of ids) {
    const remaining = EXPORT_MAX_ROWS_TOTAL - used;
    if (remaining <= 0) {
      throw new ExportTooLargeError("export exceeds the total row ceiling");
    }
    const table = await readDomainTable(businessId, id, remaining);
    used += table.rows.length;
    tables.push(table);
  }

  return tables;
}
