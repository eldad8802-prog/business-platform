/**
 * Late changes reach the monthly workflow (Option B §A.6, §G): when a document is approved, fails or
 * arrives, every CLOSED month it may belong to is marked dirty, so the next sweep re-evaluates it — and,
 * for a month already sent, tells the owner a revised version is ready for review (never re-sent
 * without a fresh approval).
 *
 * The months: the approved record's date, the extracted date, and the upload month (what the package's
 * pending list uses). Only months that already have a period row are touched (`updateMany`), so this
 * does nothing for a business without the workflow, and nothing for the current, still-open month.
 *
 * Never throws and never delays the caller's response beyond one small read and one update: the
 * document change is already committed, and a missing table (code deployed before the migration) is
 * just as silent as a business without the feature.
 */

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { formatYearMonthJerusalem } from "@/lib/utils/jerusalem-month-range";
import { isPeriodClosed } from "./period";

export async function noteDocumentChangeForAccountant(businessId: number, documentId: number, now: Date): Promise<number> {
  try {
    return await tenantTx(businessId, async (tx) => {
      const doc = await tx.document.findFirst({
        where: { id: documentId, businessId },
        select: {
          createdAt: true,
          extractedData: { select: { date: true } },
          financialRecord: { select: { date: true } },
        },
      });
      if (!doc) return 0;
      const keys = new Set<string>();
      for (const d of [doc.createdAt, doc.extractedData?.date ?? null, doc.financialRecord?.date ?? null]) {
        if (!d) continue;
        const key = formatYearMonthJerusalem(d);
        if (isPeriodClosed(key, now)) keys.add(key);
      }
      if (keys.size === 0) return 0;
      const n = await tx.accountantPeriod.updateMany({
        where: { businessId, periodKey: { in: [...keys] } },
        data: { dirtyAt: now, updatedAt: now },
      });
      return n.count;
    });
  } catch {
    return 0;
  }
}
