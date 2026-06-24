import { createHash } from "crypto";
import { MonthCloseStatus, type Prisma } from "@prisma/client";
import { ConflictError, ValidationError } from "@/lib/errors";

/**
 * Accountant Package — Phase A.1: minimal Month Closing.
 *
 * A month is identified by (businessId, year, month). It is OPEN by default and
 * a row only materializes when CLOSED. CLOSED is a soft, append-style lock:
 *   • it never deletes or mutates source data,
 *   • it guards the existing financial write flows from landing NEW financial
 *     reality inside a settled period (see `assertMonthOpen`).
 *
 * Out of scope for Phase A: reopen, AMENDED lifecycle, accountant roles.
 */

export const MONTH_CLOSED_ERROR_CODE = "MONTH_CLOSED" as const;
export const MONTH_HAS_CRITICAL_EXCEPTIONS_CODE =
  "MONTH_HAS_CRITICAL_EXCEPTIONS" as const;

export type MonthCloseStatusResult = {
  year: number;
  month: number;
  status: "OPEN" | "CLOSED";
  closedAt: string | null;
  closedByUserId: number | null;
  packageGeneratedAt: string | null;
  snapshotHash: string | null;
};

function assertValidYearMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ValidationError("Invalid year");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError("Invalid month");
  }
}

/** Inclusive start / end of a calendar month (local time, matching the export). */
export function monthRange(year: number, month: number): { from: Date; to: Date } {
  assertValidYearMonth(year, month);
  return {
    from: new Date(year, month - 1, 1, 0, 0, 0, 0),
    to: new Date(year, month, 0, 23, 59, 59, 999),
  };
}

export async function getMonthClose(
  db: Prisma.TransactionClient,
  businessId: number,
  year: number,
  month: number
) {
  assertValidYearMonth(year, month);
  return db.monthClose.findUnique({
    where: { businessId_year_month: { businessId, year, month } },
  });
}

export async function getMonthCloseStatus(
  db: Prisma.TransactionClient,
  businessId: number,
  year: number,
  month: number
): Promise<MonthCloseStatusResult> {
  const existing = await getMonthClose(db, businessId, year, month);
  const closed = existing?.status === MonthCloseStatus.CLOSED;
  return {
    year,
    month,
    status: closed ? "CLOSED" : "OPEN",
    closedAt: existing?.closedAt?.toISOString() ?? null,
    closedByUserId: existing?.closedByUserId ?? null,
    packageGeneratedAt: existing?.packageGeneratedAt?.toISOString() ?? null,
    snapshotHash: existing?.snapshotHash ?? null,
  };
}

export async function isMonthClosed(
  db: Prisma.TransactionClient,
  businessId: number,
  year: number,
  month: number
): Promise<boolean> {
  const existing = await getMonthClose(db, businessId, year, month);
  return existing?.status === MonthCloseStatus.CLOSED;
}

/**
 * Deterministic content hash over the financial records that belong to a closed
 * month. Stored as `snapshotHash` so a later regeneration can be checked
 * against what was settled at close time. Order-independent (sorted by id).
 */
export function computeMonthSnapshotHash(
  records: {
    id: number;
    amount: number;
    date: Date;
    vendorName: string;
    category: string;
    direction: string;
  }[]
): string {
  const canonical = [...records]
    .sort((a, b) => a.id - b.id)
    .map((r) => ({
      id: r.id,
      amount: r.amount,
      date: r.date instanceof Date ? r.date.toISOString() : String(r.date),
      vendorName: r.vendorName,
      category: r.category,
      direction: r.direction,
    }));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/**
 * Closes a month. Caller is responsible for having validated that there are no
 * blocking (Critical) exceptions — this function does not re-derive exceptions.
 * Idempotent on an already-closed month (returns the existing close untouched).
 */
export async function closeMonth(
  db: Prisma.TransactionClient,
  input: {
    businessId: number;
    year: number;
    month: number;
    userId: number;
    snapshotHash: string | null;
  }
) {
  const { businessId, year, month, userId, snapshotHash } = input;
  assertValidYearMonth(year, month);

  const existing = await getMonthClose(db, businessId, year, month);
  if (existing?.status === MonthCloseStatus.CLOSED) {
    return existing;
  }

  return db.monthClose.upsert({
    where: { businessId_year_month: { businessId, year, month } },
    create: {
      businessId,
      year,
      month,
      status: MonthCloseStatus.CLOSED,
      closedAt: new Date(),
      closedByUserId: userId,
      snapshotHash,
    },
    update: {
      status: MonthCloseStatus.CLOSED,
      closedAt: new Date(),
      closedByUserId: userId,
      snapshotHash,
    },
  });
}

/**
 * Guard for existing financial write flows. Throws a 409 ConflictError if the
 * given transaction date lands inside a CLOSED month. Fail-open on bad dates
 * (callers compute the date upstream; an invalid date is not our concern here).
 */
export async function assertMonthOpen(
  db: Prisma.TransactionClient,
  businessId: number,
  date: Date
): Promise<void> {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (await isMonthClosed(db, businessId, year, month)) {
    throw new ConflictError(
      MONTH_CLOSED_ERROR_CODE,
      `החודש ${month}/${year} סגור — לא ניתן לשייך אליו רשומה פיננסית חדשה`
    );
  }
}

/**
 * Best-effort stamp of when an accountant package ZIP was generated for a closed
 * month. Never throws — package generation must not fail because of this.
 */
export async function markPackageGenerated(
  db: Prisma.TransactionClient,
  businessId: number,
  year: number,
  month: number
): Promise<void> {
  try {
    if (!Number.isInteger(year) || !Number.isInteger(month)) return;
    const existing = await getMonthClose(db, businessId, year, month);
    if (existing?.status !== MonthCloseStatus.CLOSED) return;
    await db.monthClose.update({
      where: { businessId_year_month: { businessId, year, month } },
      data: { packageGeneratedAt: new Date() },
    });
  } catch (e) {
    console.error("markPackageGenerated failed:", businessId, year, month, e);
  }
}
