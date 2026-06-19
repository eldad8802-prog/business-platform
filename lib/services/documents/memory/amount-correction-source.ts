/**
 * Phase 2 MVP — reads human corrections from the Correction Ledger (READ-ONLY).
 *
 * Returns raw amount corrections (scope + human-confirmed amount). The winning
 * candidate's structural band is computed later by the shadow runner (which
 * re-runs the representation engine on the document file). When the ledger is
 * empty (not yet activated) this returns [] and the whole pipeline reports
 * "No Effect" — a valid state.
 */

import { prisma } from "@/lib/prisma";
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

export async function loadAmountCorrectionsFromLedger(): Promise<RawAmountCorrection[]> {
  const reviews = await prisma.reviewEvent.findMany({
    where: { approvedAs: "financial" },
    orderBy: { occurredAt: "asc" },
  });
  if (reviews.length === 0) return [];

  const docIds = Array.from(new Set(reviews.map((r) => r.documentId)));
  const snaps = await prisma.extractionSnapshot.findMany({
    where: { documentId: { in: docIds } },
    orderBy: { occurredAt: "desc" },
    select: { documentId: true, documentType: true },
  });
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
