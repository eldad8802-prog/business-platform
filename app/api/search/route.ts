import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

// GET /api/search
//
// Backwards-compatible: still returns `{ results }` and each row keeps every
// FinancialRecord field. The shape is purely additive — a `document` object
// with read-only metadata is now included, and several new optional query
// params are accepted. When no `q` is provided, this returns the most recent
// records (capped by `limit`) so the search screen can be used for browsing
// as well as for explicit search.

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function parseDirection(raw: string | null): "income" | "expense" | null {
  if (raw === "income" || raw === "expense") return raw;
  return null;
}

function parseMonthRange(raw: string | null): { gte: Date; lte: Date } | null {
  if (!raw) return null;
  const [yStr, mStr] = raw.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  if (m < 1 || m > 12) return null;
  return {
    gte: new Date(y, m - 1, 1, 0, 0, 0, 0),
    lte: new Date(y, m, 0, 23, 59, 59, 999),
  };
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
      return authRequiredResponse(req);
    }

  try {
    const { searchParams } = new URL(req.url);

    const q = (searchParams.get("q") || "").trim();
    const category = searchParams.get("category");
    const vendor = searchParams.get("vendor");
    const direction = parseDirection(searchParams.get("direction"));
    const monthRange = parseMonthRange(searchParams.get("month"));
    const fromDate = parseDate(searchParams.get("from"));
    const toDate = parseDate(searchParams.get("to"));
    const limit = parseLimit(searchParams.get("limit"));

    // Date filter precedence: explicit `month` wins over `from`/`to` so the
    // UI can choose a single, simpler control.
    let dateFilter: { gte?: Date; lte?: Date } | null = null;
    if (monthRange) {
      dateFilter = monthRange;
    } else if (fromDate || toDate) {
      dateFilter = {};
      if (fromDate) dateFilter.gte = fromDate;
      if (toDate) dateFilter.lte = toDate;
    }

    // When the query is numeric, also match it against the amount. People often
    // recall an expense by its sum ("1,250") rather than the vendor name.
    const qNumeric = q ? Number(q.replace(/[,₪\s]/g, "")) : NaN;
    const qIsAmount = Number.isFinite(qNumeric) && qNumeric > 0;

    const results = await prisma.financialRecord.findMany({
      where: {
        businessId: user.businessId,
        AND: [
          q
            ? {
                OR: [
                  { vendorName: { contains: q, mode: "insensitive" as const } },
                  { category: { contains: q, mode: "insensitive" as const } },
                  ...(qIsAmount ? [{ amount: qNumeric }] : []),
                ],
              }
            : {},
          category ? { category } : {},
          vendor ? { vendorName: vendor } : {},
          direction ? { direction } : {},
          dateFilter ? { date: dateFilter } : {},
        ],
      },
      orderBy: {
        date: "desc",
      },
      take: limit,
      include: {
        document: {
          select: {
            status: true,
            mimeType: true,
            source: true,
            createdAt: true,
          },
        },
      },
    });

    return Response.json({ results });
  } catch (error) {
    console.error("SEARCH ERROR:", error);

    return Response.json({ error: "Search failed" }, { status: 500 });
  }
}
