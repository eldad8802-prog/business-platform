/**
 * Phase 2 MVP — reads human corrections from the Correction Ledger (READ-ONLY).
 *
 * Returns raw amount corrections (scope + human-confirmed amount). The winning
 * candidate's structural band is computed later by the shadow runner (which
 * re-runs the representation engine on the document file). When the ledger is
 * empty (not yet activated) this returns [] and the whole pipeline reports
 * "No Effect" — a valid state.
 *
 * M0 — this read is now TENANT-SCOPED and takes an explicit `businessId`.
 *
 * It previously selected every `approvedAs: "financial"` ReviewEvent in the database and grouped by
 * tenant afterwards. Nothing leaked (the caller is an offline runner, and under the least-privilege
 * runtime role RLS would have returned nothing at all), but the SHAPE was wrong in the way that
 * matters most for a learning system: a prior is only ever allowed to be built from ONE business's own
 * history. "Normal for this business" can never be derived from a corpus that spans businesses. Making
 * the tenant a required argument means that rule is enforced by the type system, not by a convention
 * downstream code is trusted to remember.
 */

import { tenantTx } from "@/lib/tenant/tenant-tx";
import type { AmountScopeKey } from "./amount-memory";

export type RawAmountCorrection = {
  documentId: number;
  scope: AmountScopeKey;
  humanAmount: number;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractHumanAmount(rawFinal: unknown, verdicts: unknown): number | null {
  if (rawFinal && typeof rawFinal === "object") {
    const a = num((rawFinal as Record<string, unknown>).amount);
    if (a != null) return a;
  }
  if (verdicts && typeof verdicts === "object") {
    const amt = (verdicts as Record<string, unknown>).amount;
    if (amt && typeof amt === "object") {
      const f = num((amt as Record<string, unknown>).final);
      if (f != null) return f;
    }
  }
  return null;
}

export async function loadAmountCorrectionsFromLedger(
  businessId: number,
): Promise<RawAmountCorrection[]> {
  const { reviews, snaps } = await tenantTx(businessId, async (tx) => {
    // The explicit `businessId` predicate is kept alongside the tenant transaction on purpose: the GUC
    // is the database's guarantee, this is the application's, and a learning corpus should not depend
    // on exactly one of them being correct.
    const reviews = await tx.reviewEvent.findMany({
      where: { businessId, approvedAs: "financial" },
      orderBy: { occurredAt: "asc" },
    });
    if (reviews.length === 0) return { reviews, snaps: [] };

    const docIds = Array.from(new Set(reviews.map((r) => r.documentId)));
    const snaps = await tx.extractionSnapshot.findMany({
      where: { businessId, documentId: { in: docIds } },
      orderBy: { occurredAt: "desc" },
      select: { documentId: true, documentType: true },
    });
    return { reviews, snaps };
  });

  if (reviews.length === 0) return [];

  const docTypeByDoc = new Map<number, string | null>();
  for (const s of snaps) {
    if (!docTypeByDoc.has(s.documentId)) docTypeByDoc.set(s.documentId, s.documentType);
  }

  const out: RawAmountCorrection[] = [];
  for (const r of reviews) {
    const humanAmount = extractHumanAmount(r.rawFinal, r.verdicts);
    if (humanAmount == null || humanAmount <= 0) continue;
    out.push({
      documentId: r.documentId,
      humanAmount,
      scope: {
        businessId: r.businessId,
        vendor: (r.vendorFinal ?? r.vendorBelief ?? "").trim(),
        docType: docTypeByDoc.get(r.documentId) ?? "unknown",
        direction: r.directionFinal ?? r.directionBelief ?? "unknown",
      },
    });
  }
  return out;
}
