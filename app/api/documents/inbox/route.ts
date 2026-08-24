import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { STORED_DOCUMENT_FILENAME_REGEX } from "@/lib/services/documents/document-storage-paths";
import {
  formatYearMonthJerusalem,
  getCurrentYearMonthJerusalem,
  jerusalemMonthUtcHalfOpen,
} from "@/lib/utils/jerusalem-month-range";
import { derivePreviousNet } from "@/lib/documents/previous-net";
import { previousYearMonth } from "@/lib/documents/previous-year-month";
import {
  countPendingReviewAllTime,
  listPendingReviewMonths,
} from "@/lib/documents/pending-review";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 30;
const TIMEZONE_LABEL = "Asia/Jerusalem";

type ConfidenceDot = "high" | "medium" | "low";

type ConfidenceDots = {
  amount: ConfidenceDot;
  vendor: ConfidenceDot;
  dateProxy: ConfidenceDot;
};

function clampLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function dotFromDbLabel(
  label: string | null | undefined
): ConfidenceDot {
  const v = String(label ?? "")
    .trim()
    .toLowerCase();
  if (v === "high") return "high";
  if (v === "medium") return "medium";
  return "low";
}

function dateProxyFromScore(score: number | null | undefined): ConfidenceDot {
  if (score == null || !Number.isFinite(Number(score))) return "low";
  const s = Number(score);
  if (s >= 0.85) return "high";
  if (s >= 0.65) return "medium";
  return "low";
}

function buildConfidenceDots(extracted: {
  amountConfidence: string | null;
  vendorConfidence: string | null;
  confidenceScore: number | null;
} | null): ConfidenceDots {
  if (!extracted) {
    return {
      amount: "low",
      vendor: "low",
      dateProxy: "low",
    };
  }
  return {
    amount: dotFromDbLabel(extracted.amountConfidence),
    vendor: dotFromDbLabel(extracted.vendorConfidence),
    dateProxy: dateProxyFromScore(extracted.confidenceScore),
  };
}

function previewKind(fileUrl: string, mimeType: string): "pdf" | "image" | "unsupported" {
  const lowerUrl = String(fileUrl ?? "").toLowerCase();
  const lowerMime = String(mimeType ?? "").toLowerCase();

  if (lowerMime.includes("pdf") || lowerUrl.endsWith(".pdf")) return "pdf";
  if (
    lowerMime.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif)$/i.test(lowerUrl)
  ) {
    return "image";
  }
  return "unsupported";
}

function computeQuickApproveEligible(input: {
  status: string;
  fileAvailable: boolean;
  amount: number | null | undefined;
  dots: ConfidenceDots;
}): boolean {
  if (input.status !== "needs_review") return false;
  if (!input.fileAvailable) return false;
  const amt = input.amount;
  if (amt == null || !Number.isFinite(amt)) return false;
  if (amt <= 0 || amt > 10_000) return false;
  if (
    input.dots.amount !== "high" ||
    input.dots.vendor !== "high" ||
    input.dots.dateProxy !== "high"
  ) {
    return false;
  }
  return true;
}

function encodeCursor(createdAt: Date, id: number): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(raw: string): { createdAt: Date; id: number } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "number") {
      return null;
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    if (!Number.isInteger(parsed.id)) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
    }

    // Reads bucket — fail-OPEN: a transient Redis blip must not break viewing
    // documents (the orchestrator logs the degradation). Only a genuine
    // over-limit returns 429.
    const apiDecision = await checkRateLimit({
      bucket: "DOCUMENTS_API",
      user: user.id,
      business: user.businessId,
    });
    if (!apiDecision.allowed) {
      console.warn("[rate-limit] throttled", {
        feature: "documents.inbox",
        bucket: apiDecision.bucket,
        scope: apiDecision.scope,
        userId: user.id,
        businessId: user.businessId,
        retryAfterSeconds: apiDecision.retryAfterSeconds,
      });
      return buildRateLimitResponse(apiDecision);
    }

    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    const summaryOnly = url.searchParams.get("summaryOnly")?.trim() === "1";
    const limit = clampLimit(url.searchParams.get("limit"));
    const cursorRaw = url.searchParams.get("cursor");

    let resolvedMonth: string;
    try {
      resolvedMonth = monthParam?.trim()
        ? monthParam.trim()
        : getCurrentYearMonthJerusalem();
    } catch {
      return NextResponse.json({ error: "שגיאה בטעינת התקופה" }, { status: 500 });
    }

    let from: Date;
    let toExclusive: Date;
    try {
      ({ from, toExclusive } = jerusalemMonthUtcHalfOpen(resolvedMonth));
    } catch {
      return NextResponse.json(
        { error: "חודש לא תקין (פורמט YYYY-MM)" },
        { status: 400 }
      );
    }

    const businessId = user.businessId;

    // Backlog = total needs_review across ALL time, plus the distinct Jerusalem
    // months that hold it. Month-independent, so it's computed once and shared
    // by both the summary and full responses. `totalPendingReview` uses the same
    // canonical selector as the Attention paperwork insight, so the two surfaces
    // never disagree on "total pending".
    const [totalPendingReview, pendingMonths] = await Promise.all([
      countPendingReviewAllTime(businessId),
      listPendingReviewMonths(businessId),
    ]);

    if (summaryOnly) {
      // Previous calendar month (Jerusalem), for the net cash-flow delta. Reuses
      // the exact same half-open window logic — just shifted one month back via a
      // pure, unit-tested helper. `resolvedMonth` is already validated (it passed
      // the range call above).
      const previousMonth = previousYearMonth(resolvedMonth);
      const { from: prevFrom, toExclusive: prevToExclusive } =
        jerusalemMonthUtcHalfOpen(previousMonth);

      const [
        incomeAgg,
        expenseAgg,
        recordCount,
        pendingReview,
        approvedDocuments,
        nextPendingDoc,
        prevIncomeAgg,
        prevExpenseAgg,
      ] = await Promise.all([
        prisma.financialRecord.aggregate({
          where: {
            businessId,
            date: { gte: from, lt: toExclusive },
            direction: "income",
          },
          _sum: { amount: true },
        }),
        prisma.financialRecord.aggregate({
          where: {
            businessId,
            date: { gte: from, lt: toExclusive },
            direction: "expense",
          },
          _sum: { amount: true },
        }),
        prisma.financialRecord.count({
          where: {
            businessId,
            date: { gte: from, lt: toExclusive },
          },
        }),
        prisma.document.count({
          where: {
            businessId,
            createdAt: { gte: from, lt: toExclusive },
            status: "needs_review",
          },
        }),
        prisma.document.count({
          where: {
            businessId,
            createdAt: { gte: from, lt: toExclusive },
            status: "approved",
          },
        }),
        prisma.document.findFirst({
          where: {
            businessId,
            createdAt: { gte: from, lt: toExclusive },
            status: "needs_review",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            status: true,
            extractedData: {
              select: {
                amount: true,
                vendorName: true,
              },
            },
          },
        }),
        prisma.financialRecord.aggregate({
          where: {
            businessId,
            date: { gte: prevFrom, lt: prevToExclusive },
            direction: "income",
          },
          _sum: { amount: true },
        }),
        prisma.financialRecord.aggregate({
          where: {
            businessId,
            date: { gte: prevFrom, lt: prevToExclusive },
            direction: "expense",
          },
          _sum: { amount: true },
        }),
      ]);

      const incomeSum = incomeAgg._sum.amount ?? 0;
      const expenseSum = expenseAgg._sum.amount ?? 0;

      // Previous-month net — derived by a pure, unit-tested helper (returns null
      // when there is genuinely no prior data, never 0).
      const previousNet = derivePreviousNet(
        prevIncomeAgg._sum.amount,
        prevExpenseAgg._sum.amount
      );

      const nextPending = nextPendingDoc
        ? {
            documentId: nextPendingDoc.id,
            status: nextPendingDoc.status,
            extracted: nextPendingDoc.extractedData
              ? {
                  amount: nextPendingDoc.extractedData.amount,
                  vendorName: nextPendingDoc.extractedData.vendorName,
                }
              : null,
          }
        : null;

      return NextResponse.json({
        success: true,
        scope: {
          month: resolvedMonth,
          timezone: TIMEZONE_LABEL,
        },
        pendingMonths,
        financialPulse: {
          period: {
            month: resolvedMonth,
            from: from.toISOString(),
            toExclusive: toExclusive.toISOString(),
          },
          fromFinancialRecords: {
            income: incomeSum,
            expense: expenseSum,
            net: incomeSum - expenseSum,
            recordCount,
          },
          inboxDocumentCounts: {
            pendingReview,
            approvedDocuments,
            totalPendingReview,
          },
        },
        previousNet,
        nextPending,
        items: [],
        pagination: {
          limit: 0,
          nextCursor: null,
          hasMore: false,
        },
      });
    }

    const cursor = cursorRaw?.trim() ? decodeCursor(cursorRaw.trim()) : null;
    if (cursorRaw?.trim() && !cursor) {
      return NextResponse.json({ error: "סמן עמוד לא תקין" }, { status: 400 });
    }

    const [
      incomeAgg,
      expenseAgg,
      recordCount,
      pendingReview,
      approvedDocuments,
      docs,
    ] = await Promise.all([
      prisma.financialRecord.aggregate({
        where: {
          businessId,
          date: { gte: from, lt: toExclusive },
          direction: "income",
        },
        _sum: { amount: true },
      }),
      prisma.financialRecord.aggregate({
        where: {
          businessId,
          date: { gte: from, lt: toExclusive },
          direction: "expense",
        },
        _sum: { amount: true },
      }),
      prisma.financialRecord.count({
        where: {
          businessId,
          date: { gte: from, lt: toExclusive },
        },
      }),
      prisma.document.count({
        where: {
          businessId,
          createdAt: { gte: from, lt: toExclusive },
          status: "needs_review",
        },
      }),
      prisma.document.count({
        where: {
          businessId,
          createdAt: { gte: from, lt: toExclusive },
          status: "approved",
        },
      }),
      prisma.document.findMany({
        where: {
          businessId,
          createdAt: { gte: from, lt: toExclusive },
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  {
                    AND: [
                      { createdAt: cursor.createdAt },
                      { id: { lt: cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          createdAt: true,
          status: true,
          source: true,
          mimeType: true,
          fileUrl: true,
          extractedData: {
            select: {
              amount: true,
              vendorName: true,
              date: true,
              direction: true,
              category: true,
              confidenceScore: true,
              amountConfidence: true,
              vendorConfidence: true,
              categoryConfidence: true,
            },
          },
          financialRecord: {
            select: {
              amount: true,
              vendorName: true,
              date: true,
              direction: true,
              category: true,
              approvedAt: true,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
    ]);

    const hasMore = docs.length > limit;
    const pageDocs = hasMore ? docs.slice(0, limit) : docs;

    const incomeSum = incomeAgg._sum.amount ?? 0;
    const expenseSum = expenseAgg._sum.amount ?? 0;

    const items = pageDocs.map((doc) => {
      const extracted = doc.extractedData;
      const dots = buildConfidenceDots(extracted);

      const storedName = String(doc.fileUrl ?? "").trim();
      const fileAvailable = STORED_DOCUMENT_FILENAME_REGEX.test(storedName);

      const preview = {
        kind: previewKind(doc.fileUrl, doc.mimeType),
        fileAvailable,
        thumbnailReady: false as const,
      };

      const quickApprove = computeQuickApproveEligible({
        status: doc.status,
        fileAvailable,
        amount: extracted?.amount ?? null,
        dots,
      });

      return {
        documentId: doc.id,
        createdAt: doc.createdAt.toISOString(),
        groupMonth: formatYearMonthJerusalem(doc.createdAt),
        status: doc.status,
        source: doc.source,
        mimeType: doc.mimeType,
        preview,
        extracted: extracted
          ? {
              amount: extracted.amount,
              vendorName: extracted.vendorName,
              date: extracted.date ? extracted.date.toISOString() : null,
              direction: extracted.direction,
              category: extracted.category,
              confidenceScore: extracted.confidenceScore,
              amountConfidence: extracted.amountConfidence,
              vendorConfidence: extracted.vendorConfidence,
              categoryConfidence: extracted.categoryConfidence,
            }
          : null,
        financial: doc.financialRecord
          ? {
              amount: doc.financialRecord.amount,
              vendorName: doc.financialRecord.vendorName,
              date: doc.financialRecord.date.toISOString(),
              direction: doc.financialRecord.direction,
              category: doc.financialRecord.category,
              approvedAt: doc.financialRecord.approvedAt.toISOString(),
            }
          : undefined,
        confidenceDots: dots,
        quickApprove: {
          eligible: quickApprove,
        },
      };
    });

    let nextCursor: string | null = null;
    if (hasMore && pageDocs.length > 0) {
      const last = pageDocs[pageDocs.length - 1];
      nextCursor = encodeCursor(last.createdAt, last.id);
    }

    return NextResponse.json({
      success: true,
      scope: {
        month: resolvedMonth,
        timezone: TIMEZONE_LABEL,
      },
      pendingMonths,
      financialPulse: {
        period: {
          month: resolvedMonth,
          from: from.toISOString(),
          toExclusive: toExclusive.toISOString(),
        },
        fromFinancialRecords: {
          income: incomeSum,
          expense: expenseSum,
          net: incomeSum - expenseSum,
          recordCount,
        },
        inboxDocumentCounts: {
          pendingReview,
          approvedDocuments,
          totalPendingReview,
        },
      },
      items,
      pagination: {
        limit,
        nextCursor,
        hasMore,
      },
    });
  } catch (e) {
    console.error("DOCUMENTS_INBOX_ERROR:", e);
    return NextResponse.json(
      { error: "שגיאה בטעינת המסמכים. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  }
}
