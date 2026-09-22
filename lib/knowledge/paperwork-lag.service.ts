/**
 * M2 · DOC-04 end to end: read this business's evidence, derive, persist.
 *
 * The tenant seam. Everything below it is pure (the rule) or tenant-bound (the writer); this file is
 * where a `businessId` becomes a database read, and it is deliberately the only place that happens for
 * this measure.
 *
 * Idempotent and replayable: running it twice over unchanged evidence produces an identical row,
 * including the fingerprint. That is what makes the artifact safe to delete — the rebuild proof in the
 * battery deletes every measure and re-derives it, and the fingerprints must match.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { resolveVendorCategoryPolicyVersion } from "@/lib/business-memory/policy";
import {
  derivePaperworkLag,
  MEASURE_KEY,
  type PaperworkObservation,
} from "./rules/documents-paperwork-lag";
import { writeMeasure, type MeasureWriteOutcome } from "./measure-writer";
import type { MeasureResult } from "./measure.contract";

/**
 * Read the observations for ONE business.
 *
 * `FinancialRecord` is the right evidence table precisely because its EXISTENCE is the owner decision:
 * the row is created inside the approval transaction and nowhere else, so there is no such thing as an
 * unapproved one. `approvedAt` is non-nullable for the same reason. That makes every row an observation
 * of a real human act, which is the only kind of evidence a habit may be built from.
 */
export async function loadPaperworkObservations(
  businessId: number,
): Promise<PaperworkObservation[]> {
  const rows = await tenantTx(businessId, (tx) =>
    tx.financialRecord.findMany({
      where: { businessId },
      orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
      select: { id: true, businessId: true, date: true, approvedAt: true },
    }),
  );
  return rows.map((r) => ({
    recordId: r.id,
    businessId: r.businessId,
    documentDate: r.date,
    approvedAt: r.approvedAt,
  }));
}

export type PaperworkLagOutcome =
  | { kind: "written"; result: MeasureResult; write: MeasureWriteOutcome }
  | { kind: "failed"; stage: "policy" | "evidence" | "derive" | "write"; detail: string };

/**
 * Derive and persist DOC-04 for one business.
 *
 * INSUFFICIENT_EVIDENCE is WRITTEN, not skipped. A stored "we looked, and there were four" is a fact
 * about the business that a consumer can explain; an absent row is indistinguishable from a rule that
 * never ran, and the difference matters the first time someone asks why Dubiz said nothing.
 *
 * Rule versioning reuses the existing policy registry rather than inventing a second one. v1 of this
 * measure is pinned to the same registered version row the Claim path resolves, so a rule change is a
 * version change with the same semantics everywhere.
 */
export async function derivePaperworkLagForBusiness(
  businessId: number,
  now: Date = new Date(),
): Promise<PaperworkLagOutcome> {
  let policyVersionId: number;
  try {
    policyVersionId = (await resolveVendorCategoryPolicyVersion()).policyVersionId;
  } catch (e) {
    return { kind: "failed", stage: "policy", detail: e instanceof Error ? e.message : String(e) };
  }

  let observations: PaperworkObservation[];
  try {
    observations = await loadPaperworkObservations(businessId);
  } catch (e) {
    return { kind: "failed", stage: "evidence", detail: e instanceof Error ? e.message : String(e) };
  }

  let result: MeasureResult;
  try {
    result = derivePaperworkLag(observations, now);
  } catch (e) {
    return { kind: "failed", stage: "derive", detail: e instanceof Error ? e.message : String(e) };
  }

  // The derivation is pure and cannot know the tenant when the sample is empty, so the caller's
  // trusted businessId is authoritative for the evidence set's ownership.
  const scoped: MeasureResult = {
    ...result,
    evidenceSet: { ...result.evidenceSet, businessId },
  };

  try {
    const write = await writeMeasure(businessId, scoped, policyVersionId);
    return { kind: "written", result: scoped, write };
  } catch (e) {
    return { kind: "failed", stage: "write", detail: e instanceof Error ? e.message : String(e) };
  }
}

export { MEASURE_KEY };
