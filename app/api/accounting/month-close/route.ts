import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  closeMonth,
  computeMonthSnapshotHash,
  getMonthCloseStatus,
  monthRange,
  MONTH_HAS_CRITICAL_EXCEPTIONS_CODE,
} from "@/lib/services/accounting/month-close.service";
import { computeExceptionsForPeriod } from "@/lib/reports/exceptions-report";

/**
 * Accountant Package — Phase A: Month Close.
 *
 * GET  /api/accounting/month-close?year=YYYY&month=M
 *   → current close status + exception totals for the month.
 * POST /api/accounting/month-close  { year, month }
 *   → closes the month. Blocked (409) if any Critical exception exists.
 *
 * Whole-month scope only — category filtering is intentionally NOT applied to
 * the close gate (a month is settled in full or not at all).
 */

function parseIntParam(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const url = new URL(req.url);
    const year = parseIntParam(url.searchParams.get("year"));
    const month = parseIntParam(url.searchParams.get("month"));
    if (year == null || month == null) {
      return Response.json(
        { error: "year and month are required" },
        { status: 400 }
      );
    }

    const { from, to } = monthRange(year, month);

    const [status, exceptions] = await Promise.all([
      getMonthCloseStatus(prisma, user.businessId, year, month),
      computeExceptionsForPeriod(prisma, {
        businessId: user.businessId,
        fromDate: from,
        toDate: to,
        categories: undefined,
      }),
    ]);

    return Response.json({
      monthClose: status,
      exceptions: {
        totals: exceptions.totals,
        summary: exceptions.summary,
      },
      canClose: status.status === "OPEN" && exceptions.totals.critical === 0,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.statusCode }
      );
    }
    console.error("MONTH CLOSE GET ERROR:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const body = (await req.json().catch(() => null)) as {
      year?: number;
      month?: number;
    } | null;
    const year = body?.year;
    const month = body?.month;
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      return Response.json(
        { error: "year and month are required" },
        { status: 400 }
      );
    }

    const { from, to } = monthRange(year as number, month as number);

    const exceptions = await computeExceptionsForPeriod(prisma, {
      businessId: user.businessId,
      fromDate: from,
      toDate: to,
      categories: undefined,
    });

    if (exceptions.totals.critical > 0) {
      return Response.json(
        {
          error:
            `לא ניתן לסגור את החודש — קיימים ${exceptions.totals.critical} חריגים קריטיים שיש לתקן`,
          code: MONTH_HAS_CRITICAL_EXCEPTIONS_CODE,
          exceptions: { totals: exceptions.totals, summary: exceptions.summary },
        },
        { status: 409 }
      );
    }

    const records = await prisma.financialRecord.findMany({
      where: {
        businessId: user.businessId,
        date: { gte: from, lte: to },
      },
      select: {
        id: true,
        amount: true,
        date: true,
        vendorName: true,
        category: true,
        direction: true,
      },
    });
    const snapshotHash = computeMonthSnapshotHash(records);

    await closeMonth(prisma, {
      businessId: user.businessId,
      year: year as number,
      month: month as number,
      userId: user.id,
      snapshotHash,
    });

    const status = await getMonthCloseStatus(
      prisma,
      user.businessId,
      year as number,
      month as number
    );

    return Response.json({
      monthClose: status,
      exceptions: { totals: exceptions.totals, summary: exceptions.summary },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.statusCode }
      );
    }
    console.error("MONTH CLOSE POST ERROR:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
