/**
 * The contract every exportable domain implements.
 *
 * # Why the row type is erased at this boundary
 *
 * A registry that holds Customers, Suppliers, Leads and Inventory side by side
 * cannot be generic over four different row shapes without infecting every
 * caller with `any`. So each descriptor stays FULLY TYPED inside its own file —
 * it runs its own `findMany` and projects its own columns — and hands back
 * plain cells. The engine never sees a Prisma model, and a descriptor can never
 * leak one.
 *
 * # Why the descriptor reads, instead of the engine reading for it
 *
 * Each domain has its own joins (inventory needs its category name), its own
 * label vocabulary and its own idea of which fields are the owner's business.
 * Centralizing the query would mean a central `select` that has to know all of
 * that. The engine owns what is genuinely universal — tenant context, keyset
 * paging, batching, assembly — and nothing else.
 */

import type { SheetCell } from "@/lib/data-transfer/format/table.types";
import type { TenantTx } from "@/lib/tenant/transaction";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import type { DomainFieldSpec } from "@/lib/data-transfer/domain-fields";

/**
 * A domain's columns are its FIELDS (see `lib/data-transfer/domain-fields.ts`):
 * one declaration per field, filtered per surface. Export renders the
 * `exportable` ones; the import template offers the `importable` ones. Two
 * separately-maintained lists would drift, and the drift would be silent.
 */
export type ExportColumnSpec = DomainFieldSpec;

/** One keyset page of already-projected cells. */
export type ExportPage = {
  /** Row-major cells, aligned to {@link ExportDomainDescriptor.columns}. */
  cells: SheetCell[][];
  /**
   * Keyset cursor to continue from — the `id` of the last row read. `null` when
   * the page came back empty, which is how the runner knows to stop.
   */
  lastId: number | null;
};

export type ExportDomainDescriptor = {
  /** Stable id, shared with the six-domain registry. */
  id: DataTransferDomainId;
  /** Worksheet name in a multi-domain workbook. Hebrew, <= 31 chars. */
  sheetName: string;
  /**
   * ASCII slug used in file names. Deliberately not the Hebrew label: a
   * downloaded file crosses operating systems, mail clients and archive tools,
   * and a Hebrew filename is where that trip goes wrong.
   */
  fileSlug: string;
  columns: readonly ExportColumnSpec[];
  /**
   * Read ONE keyset page, strictly after `afterId`, ordered by `id` ascending.
   *
   * Contract the runner relies on:
   *  - MUST filter by `businessId` (defence in depth behind RLS).
   *  - MUST order by `id` ASC and use `id > afterId` — never OFFSET, which
   *    re-scans and can skip or repeat rows as data changes mid-export.
   *  - MUST return at most `take` rows.
   *  - MUST NOT write anything. Export is read-only.
   */
  readPage(
    tx: TenantTx,
    businessId: number,
    afterId: number,
    take: number
  ): Promise<ExportPage>;
};
