import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

type SuggestionLine = {
  matchedItemId: number;
  name: string;
  medianQty: number;
};

type SupplierReorderSuggestion = {
  supplierName: string;
  lastApprovedAt: string;
  medianIntervalDays: number;
  daysSinceLast: number;
  isTimely: boolean;
  recurringItemCount: number;
  lines: SuggestionLine[];
};

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);

    if (!user || !user.businessId) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    // Fetch the last 50 APPROVED drafts that have a non-null supplierName and approvedAt.
    // matchedItemId-filtered lines only — unmatched lines carry no reliable item identity.
    const drafts = await prisma.supplierPurchaseDraft.findMany({
      where: {
        businessId: user.businessId,
        status: "APPROVED",
        supplierName: { not: null },
        approvedAt: { not: null },
      },
      select: {
        supplierName: true,
        approvedAt: true,
        lines: {
          where: { matchedItemId: { not: null } },
          select: {
            matchedItemId: true,
            quantity: true,
            rawName: true,
          },
        },
      },
      orderBy: { approvedAt: "desc" },
      take: 50,
    });

    // Group drafts by exact supplierName.
    type DraftRow = (typeof drafts)[number];
    const bySupplier = new Map<string, DraftRow[]>();

    for (const draft of drafts) {
      const key = draft.supplierName as string;
      if (!bySupplier.has(key)) bySupplier.set(key, []);
      bySupplier.get(key)!.push(draft);
    }

    const suggestions: SupplierReorderSuggestion[] = [];
    const now = Date.now();

    for (const [supplierName, supplierDrafts] of bySupplier) {
      // Need at least 2 approved orders to identify a pattern.
      if (supplierDrafts.length < 2) continue;

      // Drafts are already sorted desc by approvedAt from Prisma.
      // Compute intervals in days between consecutive approvedAt values.
      const intervals: number[] = [];
      for (let i = 0; i < supplierDrafts.length - 1; i++) {
        const newer = supplierDrafts[i].approvedAt!.getTime();
        const older = supplierDrafts[i + 1].approvedAt!.getTime();
        const days = (newer - older) / MS_PER_DAY;
        if (days > 0) intervals.push(days);
      }

      if (intervals.length === 0) continue;

      const medianIntervalDays = median(intervals);
      const lastApprovedAt = supplierDrafts[0].approvedAt!;
      const daysSinceLast = (now - lastApprovedAt.getTime()) / MS_PER_DAY;

      // isTimely: we're in the expected reorder window and not stale (>90 days).
      const isTimely =
        daysSinceLast >= 0.75 * medianIntervalDays && daysSinceLast < 90;

      // Recurring items: appear in >= 2 of the last 3 approved drafts.
      const last3 = supplierDrafts.slice(0, 3);
      const itemMap = new Map<
        number,
        { quantities: number[]; name: string | null }
      >();

      for (const draft of last3) {
        for (const line of draft.lines) {
          if (line.matchedItemId == null) continue;
          if (!itemMap.has(line.matchedItemId)) {
            itemMap.set(line.matchedItemId, {
              quantities: [],
              name: line.rawName,
            });
          }
          const entry = itemMap.get(line.matchedItemId)!;
          entry.quantities.push(line.quantity);
          if (!entry.name && line.rawName) entry.name = line.rawName;
        }
      }

      const recurringLines: SuggestionLine[] = [];
      for (const [matchedItemId, { quantities, name }] of itemMap) {
        if (quantities.length < 2) continue;
        recurringLines.push({
          matchedItemId,
          name: name ?? `פריט ${matchedItemId}`,
          medianQty: Math.max(1, Math.round(median(quantities))),
        });
      }

      if (recurringLines.length === 0) continue;

      suggestions.push({
        supplierName,
        lastApprovedAt: lastApprovedAt.toISOString(),
        medianIntervalDays: Math.round(medianIntervalDays),
        daysSinceLast: Math.round(daysSinceLast),
        isTimely,
        recurringItemCount: recurringLines.length,
        lines: recurringLines,
      });
    }

    // isTimely suggestions first, then by ascending daysSinceLast.
    suggestions.sort((a, b) => {
      if (a.isTimely !== b.isTimely) return a.isTimely ? -1 : 1;
      return a.daysSinceLast - b.daysSinceLast;
    });

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error("supplier reorder-suggestions error:", error);
    return NextResponse.json(
      { error: "Failed to fetch supplier reorder suggestions" },
      { status: 500 }
    );
  }
}
