/**
 * 4a T4 — documents issued between the official status date and the Dubiz update ("מעבר לעוסק מורשה").
 *
 * READ ONLY. Owner decisions 2026-11-24 (D9–D12):
 *   - fiscal documents that were actually issued: TAX_INVOICE, TAX_INVOICE_RECEIPT, RECEIPT, CREDIT_NOTE with status
 *     ISSUED (no QUOTE, no draft);
 *   - counted by `issuedAt` (which is also the document's printed date: Dubiz has no separate document date);
 *   - from the start of the official date in Asia/Jerusalem (inclusive) to `confirmedAt` (exclusive); before the
 *     transition exists, to now. The end is enforced by what each document froze (see issuedAsExempt): a document
 *     issued after the transition never counts, even if its issuedAt is a moment earlier than confirmedAt;
 *   - after the transition, the range comes from the historical `BusinessKindTransition` row only;
 *   - "cancelled": Dubiz cancels by a credit note. A TAX_INVOICE's credit state uses the credit flow's own rule
 *     (getBillingCreditState: Σ issued credit notes vs the invoice total) → FULL / PARTIAL / NONE. Any other document
 *     that a credit note names is reported only as LINKED (no full/partial claim).
 * Nothing here writes, credits or re-issues a document.
 *
 * Coordination with issuance: issueBillingDocumentTx takes pg_advisory_xact_lock_shared('legal_identity:<business>');
 * the transition (business_kind_transition_to_authorized) takes the same key exclusively. A count made inside the
 * transition's transaction, after the transition function returned, therefore sees every issuance that committed
 * before it and none can commit until it ends (countInterimDocumentsTx).
 */
import { Prisma } from "@prisma/client";

export const INTERIM_DOCUMENT_TYPES = ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE"] as const;
export const INTERIM_TIME_ZONE = "Asia/Jerusalem";
export const INTERIM_EARLIEST_DATE = "2000-01-01"; // = KIND_TRANSITION_EARLIEST_EFFECTIVE_DATE
export const INTERIM_LIST_LIMIT = 50;

export type InterimCreditState = "NONE" | "PARTIAL" | "FULL" | "LINKED";

export type InterimDocument = {
  id: number;
  documentType: (typeof INTERIM_DOCUMENT_TYPES)[number];
  documentNumber: number | null;
  documentNumberFormatted: string | null;
  issuedAt: string;
  /** The document's date as printed = issuedAt's calendar day in Asia/Jerusalem (YYYY-MM-DD). */
  documentDate: string;
  totalAmount: string;
  currency: string;
  creditState: InterimCreditState;
  creditedAmount: string;
};

export type InterimRange = {
  /** YYYY-MM-DD, the official date (inclusive, from 00:00 Asia/Jerusalem). */
  fromDate: string;
  /** ISO instant, exclusive. */
  to: string;
  timezone: typeof INTERIM_TIME_ZONE;
  toExclusive: true;
  /** Where the range came from. */
  source: "TRANSITION_RECORD" | "REQUEST";
};

export function israelDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: INTERIM_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isRealDate(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/** The same rule the transition applies to statusEffectiveDate: a real date, not before 2000-01-01, not in the future. */
export function validateInterimFromDate(raw: unknown, now: Date = new Date()): { ok: true; fromDate: string } | { ok: false; code: "REQUIRED" | "INVALID" | "IN_FUTURE" } {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return { ok: false, code: "REQUIRED" };
  if (!isRealDate(v) || v < INTERIM_EARLIEST_DATE) return { ok: false, code: "INVALID" };
  if (v > israelDate(now)) return { ok: false, code: "IN_FUTURE" };
  return { ok: true, fromDate: v };
}

/** The credit flow's rule, applied to what one query returns. */
export function classifyCredit(documentType: string, totalAmount: Prisma.Decimal, creditedAmount: Prisma.Decimal, creditNoteCount: number): InterimCreditState {
  if (creditNoteCount === 0) return "NONE";
  if (documentType !== "TAX_INVOICE") return "LINKED";
  if (creditedAmount.gte(totalAmount)) return "FULL";
  if (creditedAmount.gt(0)) return "PARTIAL";
  return "LINKED";
}

type Tx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Where the window starts, as a UTC instant: 00:00 of `fromDate` in Asia/Jerusalem (DST-correct, computed by the
 * database's time-zone rules). `issuedAt` is TIMESTAMP(3) WITHOUT TIME ZONE holding UTC, so every bound is compared as
 * a UTC wall-clock value.
 */
const startUtc = (fromDate: string) => Prisma.sql`((${fromDate}::date)::timestamp AT TIME ZONE ${INTERIM_TIME_ZONE}) AT TIME ZONE 'UTC'`;
const instantUtc = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
const typesSql = Prisma.join(INTERIM_DOCUMENT_TYPES.map((t) => Prisma.sql`${t}::"BillingDocumentType"`));

/**
 * "Issued as an exempt dealer" inside the window. issuedAt is stamped before the issuance waits for the transition key,
 * so under concurrency a document can carry an issuedAt a moment before confirmedAt yet have been issued after the
 * transition (lab L2). What the document froze decides:
 *   - issuedSnapshot.extensions.billingBusinessKind = EXEMPT_DEALER → counted (with the key, no document can freeze
 *     EXEMPT_DEALER once the transition committed);
 *   - AUTHORIZED_DEALER (or any other kind) → never counted;
 *   - no recorded kind (only documents older than the billing MVP's snapshot) → the plain issuedAt < end rule.
 * The window's start is always issuedAt ≥ 00:00 of the official date in Asia/Jerusalem.
 */
const kindSql = Prisma.sql`(d."issuedSnapshot"->'extensions'->>'billingBusinessKind')`;
const issuedAsExempt = (to: string) =>
  Prisma.sql`(${kindSql} = 'EXEMPT_DEALER' OR (${kindSql} IS NULL AND d."issuedAt" < ${instantUtc(to)}))`;

/** The transition record of the business, if any (read in the caller's tenant transaction). */
export async function readTransitionWindowTx(tx: Tx, businessId: number): Promise<{ fromDate: string; to: string } | null> {
  const rows = await tx.$queryRaw<Array<{ d: string; c: Date }>>`
    SELECT to_char("statusEffectiveDate", 'YYYY-MM-DD') AS d, "confirmedAt" AS c
      FROM "BusinessKindTransition" WHERE "businessId" = ${businessId} LIMIT 1`;
  if (rows.length === 0) return null;
  return { fromDate: rows[0].d, to: new Date(rows[0].c).toISOString() };
}

/** Count only — for the transition's own transaction (see the header). */
export async function countInterimDocumentsTx(tx: Tx, args: { businessId: number; fromDate: string; to: string }): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "BillingDocument" d
     WHERE d."businessId" = ${args.businessId}
       AND d."status" = 'ISSUED'::"BillingDocumentStatus"
       AND d."documentType" IN (${typesSql})
       AND d."issuedAt" >= ${startUtc(args.fromDate)}
       AND ${issuedAsExempt(args.to)}`;
  return rows[0]?.n ?? 0;
}

export type InterimDocumentsResult = {
  range: InterimRange;
  count: number;
  credit: { full: number; partial: number; linked: number };
  items?: InterimDocument[];
  nextCursor?: string | null;
};

/**
 * Resolve the range (the transition record wins; otherwise the requested date to now) and read the count, the credit
 * summary and, on request, one page of the list ordered by issuedAt, id. Cursor = "<issuedAt ISO>_<id>" of the last row.
 */
export async function readInterimDocumentsTx(
  tx: Tx,
  args: { businessId: number; requestedFromDate: string | null; now: Date; list: boolean; cursor?: string | null; limit?: number }
): Promise<{ ok: true; result: InterimDocumentsResult } | { ok: false; code: "FROM_DATE_REQUIRED" }> {
  const window = await readTransitionWindowTx(tx, args.businessId);
  let range: InterimRange;
  if (window) {
    range = { fromDate: window.fromDate, to: window.to, timezone: INTERIM_TIME_ZONE, toExclusive: true, source: "TRANSITION_RECORD" };
  } else {
    if (!args.requestedFromDate) return { ok: false, code: "FROM_DATE_REQUIRED" };
    range = { fromDate: args.requestedFromDate, to: args.now.toISOString(), timezone: INTERIM_TIME_ZONE, toExclusive: true, source: "REQUEST" };
  }

  const rows = await tx.$queryRaw<Array<{ id: number; t: string; total: Prisma.Decimal; credited: Prisma.Decimal; cn: number }>>`
    SELECT d."id", d."documentType"::text AS t, d."totalAmount" AS total,
           coalesce(c.credited, 0) AS credited, coalesce(c.cn, 0)::int AS cn
      FROM "BillingDocument" d
      LEFT JOIN LATERAL (
        SELECT sum(x."totalAmount") AS credited, count(*) AS cn FROM "BillingDocument" x
         WHERE x."businessId" = d."businessId" AND x."documentType" = 'CREDIT_NOTE'::"BillingDocumentType"
           AND x."status" = 'ISSUED'::"BillingDocumentStatus" AND x."referenceDocumentId" = d."id") c ON true
     WHERE d."businessId" = ${args.businessId}
       AND d."status" = 'ISSUED'::"BillingDocumentStatus"
       AND d."documentType" IN (${typesSql})
       AND d."issuedAt" >= ${startUtc(range.fromDate)}
       AND ${issuedAsExempt(range.to)}`;
  const credit = { full: 0, partial: 0, linked: 0 };
  for (const r of rows) {
    const s = classifyCredit(r.t, new Prisma.Decimal(r.total), new Prisma.Decimal(r.credited), Number(r.cn));
    if (s === "FULL") credit.full++;
    else if (s === "PARTIAL") credit.partial++;
    else if (s === "LINKED") credit.linked++;
  }
  const result: InterimDocumentsResult = { range, count: rows.length, credit };
  if (!args.list) return { ok: true, result };

  const limit = Math.min(Math.max(1, args.limit ?? INTERIM_LIST_LIMIT), INTERIM_LIST_LIMIT);
  const cur = parseCursor(args.cursor ?? null);
  const page = await tx.$queryRaw<Array<{ id: number; t: string; n: number | null; nf: string | null; at: Date; total: Prisma.Decimal; cur: string; credited: Prisma.Decimal; cn: number }>>`
    SELECT d."id", d."documentType"::text AS t, d."documentNumber" AS n, d."documentNumberFormatted" AS nf,
           d."issuedAt" AS at, d."totalAmount" AS total, d."currency" AS cur,
           coalesce(c.credited, 0) AS credited, coalesce(c.cn, 0)::int AS cn
      FROM "BillingDocument" d
      LEFT JOIN LATERAL (
        SELECT sum(x."totalAmount") AS credited, count(*) AS cn FROM "BillingDocument" x
         WHERE x."businessId" = d."businessId" AND x."documentType" = 'CREDIT_NOTE'::"BillingDocumentType"
           AND x."status" = 'ISSUED'::"BillingDocumentStatus" AND x."referenceDocumentId" = d."id") c ON true
     WHERE d."businessId" = ${args.businessId}
       AND d."status" = 'ISSUED'::"BillingDocumentStatus"
       AND d."documentType" IN (${typesSql})
       AND d."issuedAt" >= ${startUtc(range.fromDate)}
       AND ${issuedAsExempt(range.to)}
       ${cur ? Prisma.sql`AND (d."issuedAt", d."id") > (${instantUtc(cur.at)}, ${cur.id})` : Prisma.empty}
     ORDER BY d."issuedAt", d."id"
     LIMIT ${limit + 1}`;
  const more = page.length > limit;
  const items = page.slice(0, limit).map((r): InterimDocument => {
    // Prisma returns TIMESTAMP WITHOUT TIME ZONE as a Date whose UTC fields are the stored (UTC) wall clock.
    const at = new Date(r.at);
    return {
      id: r.id,
      documentType: r.t as InterimDocument["documentType"],
      documentNumber: r.n,
      documentNumberFormatted: r.nf,
      issuedAt: at.toISOString(),
      documentDate: israelDate(at),
      totalAmount: new Prisma.Decimal(r.total).toFixed(2),
      currency: r.cur,
      creditState: classifyCredit(r.t, new Prisma.Decimal(r.total), new Prisma.Decimal(r.credited), Number(r.cn)),
      creditedAmount: new Prisma.Decimal(r.credited).toFixed(2),
    };
  });
  const last = items[items.length - 1];
  return { ok: true, result: { ...result, items, nextCursor: more && last ? `${last.issuedAt}_${last.id}` : null } };
}

export function parseCursor(raw: string | null): { at: string; id: number } | null {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)_(\d{1,12})$/.exec(raw);
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { at: m[1], id: Number(m[2]) };
}
