/**
 * Reading the historical fiscal history back. SELECT only.
 *
 * # Why this file exists at all
 *
 * I-8B.5 gave the business a way to put its previous system's documents into
 * Dubiz. Until now nothing could read them: the only queries against
 * `HistoricalFiscalDocument` were the duplicate lookup and the writer's own
 * verification, both of which ask "does this identity already exist" rather
 * than "what does this business hold". An import whose result cannot be looked
 * at is an import the owner has to take on faith.
 *
 * # The one thing this module must never become
 *
 * A second way to reach billing. A historical record is evidence that ANOTHER
 * system issued a document; it is not a Dubiz document, and the two must not
 * meet. So there is no join to `BillingDocument`, no fallback lookup when a
 * reversal reference does not resolve, and no write of any kind — no create, no
 * update, no delete, no upsert. The table has no UPDATE policy and no UPDATE
 * grant in production, and this module gives the application no reason to want
 * one.
 *
 * # Tenancy
 *
 * Every query runs inside `withTenantTransaction`, which sets the
 * `app.current_business_id` GUC that row-level security evaluates. The
 * businessId is passed in from the SESSION by the route and is used in the
 * `where` clause as defence in depth — the boundary is the policy, not the
 * clause. There is no parameter by which a caller could name a business.
 *
 * The I-8B.5 lesson applies directly here: under the restricted runtime role a
 * SELECT with no tenant context does not raise, it returns nothing. "This
 * business has 40 documents" silently becomes "this business has none". That is
 * why the proof battery asserts a POSITIVE same-tenant read and not merely that
 * a cross-tenant read came back empty.
 *
 * # Ordering
 *
 * `originalIssueDate DESC, id DESC`, with undated records last. The tie-break on
 * the primary key is not decoration: page 2 of a list whose ordering is not
 * total can repeat or drop a row, and a fiscal history that shows a different
 * set of documents depending on how you paged through it is worse than no list.
 */

import { Prisma } from "@prisma/client";

import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";

/* ------------------------------------------------------------- config --- */

/** Rows per page. One number, used by the service and asserted by the tests. */
export const HISTORICAL_RECORDS_PAGE_SIZE = 20;

/**
 * How deep paging may go.
 *
 * `skip` grows linearly in cost, and a page number arrives from the client. A
 * ceiling keeps an arbitrary `?page=90000` from becoming a scan of the whole
 * tenant partition. The import ceiling is 10,000 rows per file, so 500 pages of
 * 20 is far past any history a single business could reach through this flow.
 */
export const HISTORICAL_RECORDS_MAX_PAGE = 500;

/** Source systems offered as a filter. Bounded so the facet cannot grow wild. */
export const HISTORICAL_RECORDS_MAX_FACETS = 50;

/** Reversal relationships shown on a detail view. */
export const HISTORICAL_RECORDS_MAX_REVERSED_BY = 20;

/* ------------------------------------------------------------- shapes --- */

/**
 * What the owner is shown for one record.
 *
 * `id` is a navigation handle and nothing else — it is never rendered. Every
 * other field is a fiscal fact the original document carried. Deliberately
 * absent: `businessId`, `documentId`, `importRunId`, `updatedAt` and
 * `reversesHistoricalDocumentId`. They are implementation, and a screen that
 * shows them has told the owner something about Dubiz's tables rather than
 * about their own history.
 */
export type HistoricalRecordListItem = {
  id: number;
  documentTypeCode: string;
  originalDocumentNumber: string | null;
  /** Calendar day, `YYYY-MM-DD`. Never an instant: the stored value is a day. */
  originalIssueDate: string | null;
  totalAmount: string | null;
  currency: string | null;
  customerNameSnapshot: string | null;
  sourceSystemCode: string;
  sourceSystemNameRaw: string | null;
  /** True when this record is a credit that reached a record we hold. */
  reversesLinked: boolean;
  /** What the source wrote in the credited-document column, always preserved. */
  reversesOriginalNumberRaw: string | null;
};

/** A neighbouring record, named the way the owner would recognise it. */
export type HistoricalRecordRelation = {
  id: number;
  documentTypeCode: string;
  originalDocumentNumber: string | null;
  originalIssueDate: string | null;
};

/** One record in full, plus the relationships it participates in. */
export type HistoricalRecordDetail = HistoricalRecordListItem & {
  subtotalAmount: string | null;
  vatAmount: string | null;
  customerTaxIdSnapshot: string | null;
  /** The source system's own word for the type, kept verbatim at import. */
  sourceDocumentTypeRaw: string | null;
  /** When this record entered Dubiz. Ingestion metadata, not a fiscal date. */
  importedAt: string;
  /** The document this credit reverses, when the reference resolved. */
  reverses: HistoricalRecordRelation | null;
  /** Credits that reverse THIS document. Bounded. */
  reversedBy: HistoricalRecordRelation[];
};

export type HistoricalRecordFilters = {
  documentTypeCode: string | null;
  sourceSystemCode: string | null;
  /** Substring of the ORIGINAL number, matched case-insensitively. */
  originalDocumentNumber: string | null;
  /** Inclusive calendar-day bounds, `YYYY-MM-DD`. */
  issuedFrom: string | null;
  issuedTo: string | null;
};

export type HistoricalRecordsPage = {
  items: HistoricalRecordListItem[];
  page: number;
  pageSize: number;
  /** Total matching the CURRENT filters, so the owner can see what they cut. */
  total: number;
  totalPages: number;
  hasMore: boolean;
  /** Every source system this business holds, for the filter control. */
  sourceSystems: string[];
  /** True when the business holds nothing at all, filters aside. */
  emptyHistory: boolean;
};

export const EMPTY_HISTORICAL_FILTERS: HistoricalRecordFilters = {
  documentTypeCode: null,
  sourceSystemCode: null,
  originalDocumentNumber: null,
  issuedFrom: null,
  issuedTo: null,
};

/* ------------------------------------------------------------ helpers --- */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar day as the UTC midnight the writer stored.
 *
 * `fiscalDateToUtcDate` pins every historical issue date at UTC midnight so the
 * stored timestamp reads back as the same day. A filter built any other way —
 * local midnight, `new Date(text)` — would shift the boundary by the server's
 * offset and quietly drop the documents issued on the first or last day of the
 * range the owner asked for.
 */
export function historicalDayToUtc(day: string): Date | null {
  const match = ISO_DAY.exec(day);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  // Round-trip check: `Date.UTC` happily rolls 2025-02-30 into March.
  if (date.toISOString().slice(0, 10) !== day) return null;
  return date;
}

/**
 * The page number to actually query, from whatever the client asked for.
 *
 * Exported because it is the whole of the paging policy and it is worth being
 * able to prove without a database: a missing, fractional, negative or absurd
 * page must resolve to a real page rather than to a negative `skip` or a scan.
 */
export function clampHistoricalPage(requested: unknown): number {
  if (!Number.isInteger(requested)) return 1;
  return Math.min(Math.max(requested as number, 1), HISTORICAL_RECORDS_MAX_PAGE);
}

/** The stored instant back as the calendar day it was written to mean. */
function dayOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Money as text. `Decimal` does not survive JSON, and a float is not money. */
function amountOf(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(2);
}

/**
 * The `where` clause for a filter set.
 *
 * `businessId` is first and is not optional. RLS is the boundary, but a service
 * that could be called with the tenant clause missing is one refactor away from
 * being called that way.
 */
function whereFor(
  businessId: number,
  filters: HistoricalRecordFilters
): Prisma.HistoricalFiscalDocumentWhereInput {
  const where: Prisma.HistoricalFiscalDocumentWhereInput = { businessId };

  if (filters.documentTypeCode) where.documentTypeCode = filters.documentTypeCode;
  if (filters.sourceSystemCode) where.sourceSystemCode = filters.sourceSystemCode;
  if (filters.originalDocumentNumber) {
    where.originalDocumentNumber = {
      contains: filters.originalDocumentNumber,
      mode: "insensitive",
    };
  }

  const from = filters.issuedFrom ? historicalDayToUtc(filters.issuedFrom) : null;
  const to = filters.issuedTo ? historicalDayToUtc(filters.issuedTo) : null;
  if (from || to) {
    where.originalIssueDate = {
      ...(from ? { gte: from } : {}),
      // The stored value IS midnight, so an inclusive upper bound is `lte` on
      // that same midnight rather than the end of the day.
      ...(to ? { lte: to } : {}),
    };
  }

  return where;
}

/**
 * Total ordering. Undated records sort last rather than first, because a
 * history is read newest-first and a row with no date is the least informative
 * thing in it. The `id` tie-break is what makes paging stable.
 */
const ORDER_BY: Prisma.HistoricalFiscalDocumentOrderByWithRelationInput[] = [
  { originalIssueDate: { sort: "desc", nulls: "last" } },
  { id: "desc" },
];

/** Columns the list needs. Explicit, so a schema addition cannot leak. */
const LIST_SELECT = {
  id: true,
  documentTypeCode: true,
  originalDocumentNumber: true,
  originalIssueDate: true,
  totalAmount: true,
  currency: true,
  customerNameSnapshot: true,
  sourceSystemCode: true,
  sourceSystemNameRaw: true,
  reversesHistoricalDocumentId: true,
  reversesOriginalNumberRaw: true,
} as const;

type ListRow = {
  id: number;
  documentTypeCode: string;
  originalDocumentNumber: string | null;
  originalIssueDate: Date | null;
  totalAmount: Prisma.Decimal | null;
  currency: string | null;
  customerNameSnapshot: string | null;
  sourceSystemCode: string;
  sourceSystemNameRaw: string | null;
  reversesHistoricalDocumentId: number | null;
  reversesOriginalNumberRaw: string | null;
};

function toListItem(row: ListRow): HistoricalRecordListItem {
  return {
    id: row.id,
    documentTypeCode: row.documentTypeCode,
    originalDocumentNumber: row.originalDocumentNumber,
    originalIssueDate: dayOf(row.originalIssueDate),
    totalAmount: amountOf(row.totalAmount),
    currency: row.currency,
    customerNameSnapshot: row.customerNameSnapshot,
    sourceSystemCode: row.sourceSystemCode,
    sourceSystemNameRaw: row.sourceSystemNameRaw,
    reversesLinked: row.reversesHistoricalDocumentId !== null,
    reversesOriginalNumberRaw: row.reversesOriginalNumberRaw,
  };
}

const RELATION_SELECT = {
  id: true,
  documentTypeCode: true,
  originalDocumentNumber: true,
  originalIssueDate: true,
} as const;

function toRelation(row: {
  id: number;
  documentTypeCode: string;
  originalDocumentNumber: string | null;
  originalIssueDate: Date | null;
}): HistoricalRecordRelation {
  return {
    id: row.id,
    documentTypeCode: row.documentTypeCode,
    originalDocumentNumber: row.originalDocumentNumber,
    originalIssueDate: dayOf(row.originalIssueDate),
  };
}

/* --------------------------------------------------------------- read --- */

/**
 * One page of the business's historical fiscal records.
 *
 * Opens ONE tenant transaction and issues every query inside it, so the page,
 * the count and the facet all observe the same snapshot. Counting in a separate
 * transaction is how a list ends up saying "21 documents" above twenty rows
 * that are all there is.
 */
export async function listHistoricalRecords(
  businessId: number,
  input: { page?: number; filters?: Partial<HistoricalRecordFilters> } = {}
): Promise<HistoricalRecordsPage> {
  const filters: HistoricalRecordFilters = {
    ...EMPTY_HISTORICAL_FILTERS,
    ...(input.filters ?? {}),
  };

  const page = clampHistoricalPage(input.page);
  const where = whereFor(businessId, filters);

  return withTenantTransaction(async (tx: TenantTx) => {
    const [rows, total, anyAtAll, facets] = await Promise.all([
      tx.historicalFiscalDocument.findMany({
        where,
        orderBy: ORDER_BY,
        skip: (page - 1) * HISTORICAL_RECORDS_PAGE_SIZE,
        take: HISTORICAL_RECORDS_PAGE_SIZE,
        select: LIST_SELECT,
      }),
      tx.historicalFiscalDocument.count({ where }),
      // "No documents at all" and "no documents matching this filter" are
      // different situations and get different screens, so they are different
      // questions rather than one number the UI has to guess from.
      tx.historicalFiscalDocument.count({ where: { businessId } }),
      // `groupBy` and NOT `findMany({ distinct })`: Prisma applies `distinct`
      // after fetching, so a bounded `take` would silently drop a source system
      // that appears once in a long history — and the owner would be offered a
      // filter list missing exactly the entry they were looking for. A GROUP BY
      // is computed by PostgreSQL, so the bound applies to the GROUPS.
      tx.historicalFiscalDocument.groupBy({
        by: ["sourceSystemCode"],
        where: { businessId },
        orderBy: { sourceSystemCode: "asc" },
        take: HISTORICAL_RECORDS_MAX_FACETS,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / HISTORICAL_RECORDS_PAGE_SIZE));

    return {
      items: rows.map(toListItem),
      page,
      pageSize: HISTORICAL_RECORDS_PAGE_SIZE,
      total,
      totalPages,
      hasMore: page * HISTORICAL_RECORDS_PAGE_SIZE < total,
      sourceSystems: facets.map((f) => f.sourceSystemCode),
      emptyHistory: anyAtAll === 0,
    };
  });
}

/**
 * One record in full, or `null`.
 *
 * `null` covers both "no such record" and "not this tenant's record", and the
 * caller must not distinguish them: a 404 that means "exists, but not yours"
 * confirms the existence of another business's document.
 */
export async function getHistoricalRecord(
  businessId: number,
  id: number
): Promise<HistoricalRecordDetail | null> {
  if (!Number.isInteger(id) || id <= 0) return null;

  return withTenantTransaction(async (tx: TenantTx) => {
    const row = await tx.historicalFiscalDocument.findFirst({
      where: { businessId, id },
      select: {
        ...LIST_SELECT,
        subtotalAmount: true,
        vatAmount: true,
        customerTaxIdSnapshot: true,
        sourceDocumentTypeRaw: true,
        createdAt: true,
        // Both directions of the reversal relation are tenant-scoped by the
        // composite key, so neither can reach another business's record.
        reverses: { select: RELATION_SELECT },
        reversedByOthers: {
          select: RELATION_SELECT,
          orderBy: [{ originalIssueDate: "desc" }, { id: "desc" }],
          take: HISTORICAL_RECORDS_MAX_REVERSED_BY,
        },
      },
    });

    if (!row) return null;

    return {
      ...toListItem(row),
      subtotalAmount: amountOf(row.subtotalAmount),
      vatAmount: amountOf(row.vatAmount),
      customerTaxIdSnapshot: row.customerTaxIdSnapshot,
      sourceDocumentTypeRaw: row.sourceDocumentTypeRaw,
      importedAt: row.createdAt.toISOString(),
      reverses: row.reverses ? toRelation(row.reverses) : null,
      reversedBy: row.reversedByOthers.map(toRelation),
    };
  });
}
