import { prisma } from "@/lib/prisma";
import { normalizeVendorForLearning } from "@/lib/services/documents/vendor-normalization.service";

/**
 * Duplicate-defense signals for the review screen (Integrity Blueprint §6).
 *
 * Two tiers are surfaced here (both WARN — the only hard gate lives at upload,
 * where identical bytes get a 409 + explicit override):
 *
 *  - "exact_file":       another live document of this business with the SAME
 *                        content hash (identical bytes ingested twice).
 *  - "same_transaction": strong accounting-identity match — same business,
 *                        same normalized vendor, same amount, same document
 *                        date on another document / financial record. This is
 *                        deliberately NOT a constraint: two identical legal
 *                        purchases on one day exist; the reviewer decides.
 *
 * READ-ONLY; failures degrade to "no signals" and never block review.
 */

export type DuplicateSignal = {
  level: "exact_file" | "same_transaction";
  documentId: number;
  status: string;
  vendorName: string | null;
  amount: number | null;
  date: string | null;
  hasFinancialRecord: boolean;
};

const MAX_SIGNALS = 5;

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export async function findDuplicateSignals(params: {
  businessId: number;
  documentId: number;
}): Promise<DuplicateSignal[]> {
  try {
    const doc = await prisma.document.findFirst({
      where: { id: params.documentId, businessId: params.businessId },
      select: {
        id: true,
        contentHashSha256: true,
        extractedData: {
          select: { vendorName: true, amount: true, date: true },
        },
      },
    });
    if (!doc) return [];

    const signals: DuplicateSignal[] = [];
    const seenDocIds = new Set<number>([doc.id]);

    // Tier 1 — identical bytes elsewhere in this business.
    if (doc.contentHashSha256) {
      const exact = await prisma.document.findMany({
        where: {
          businessId: params.businessId,
          contentHashSha256: doc.contentHashSha256,
          id: { not: doc.id },
          status: { not: "failed" },
        },
        orderBy: { id: "desc" },
        take: MAX_SIGNALS,
        select: {
          id: true,
          status: true,
          extractedData: { select: { vendorName: true, amount: true, date: true } },
          financialRecord: { select: { id: true, vendorName: true, amount: true, date: true } },
        },
      });
      for (const d of exact) {
        seenDocIds.add(d.id);
        const known = d.financialRecord ?? d.extractedData;
        signals.push({
          level: "exact_file",
          documentId: d.id,
          status: d.status,
          vendorName: known?.vendorName ?? null,
          amount: known?.amount ?? null,
          date: known?.date ? known.date.toISOString() : null,
          hasFinancialRecord: Boolean(d.financialRecord),
        });
      }
    }

    // Tier 2 — same accounting identity (normalized vendor + amount + day).
    const ex = doc.extractedData;
    if (ex?.amount != null && ex.amount > 0 && ex.vendorName && ex.date) {
      const subjectKey = normalizeVendorForLearning(ex.vendorName).normalizedKey;
      if (subjectKey) {
        const candidates = await prisma.document.findMany({
          where: {
            businessId: params.businessId,
            id: { not: doc.id },
            status: { not: "failed" },
            OR: [
              { extractedData: { amount: ex.amount } },
              { financialRecord: { amount: ex.amount } },
            ],
          },
          orderBy: { id: "desc" },
          take: 50,
          select: {
            id: true,
            status: true,
            extractedData: { select: { vendorName: true, amount: true, date: true } },
            financialRecord: { select: { id: true, vendorName: true, amount: true, date: true } },
          },
        });

        for (const d of candidates) {
          if (seenDocIds.has(d.id)) continue;
          if (signals.length >= MAX_SIGNALS) break;
          const known = d.financialRecord ?? d.extractedData;
          if (!known?.vendorName || !known.date) continue;
          if (!sameCalendarDay(known.date, ex.date)) continue;
          const otherKey = normalizeVendorForLearning(known.vendorName).normalizedKey;
          if (!otherKey || otherKey !== subjectKey) continue;
          seenDocIds.add(d.id);
          signals.push({
            level: "same_transaction",
            documentId: d.id,
            status: d.status,
            vendorName: known.vendorName,
            amount: known.amount ?? null,
            date: known.date.toISOString(),
            hasFinancialRecord: Boolean(d.financialRecord),
          });
        }
      }
    }

    return signals;
  } catch (err) {
    console.error("[duplicate-signals] lookup failed (non-fatal):", err);
    return [];
  }
}
