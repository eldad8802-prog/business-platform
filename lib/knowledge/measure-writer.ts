/**
 * M2 · Measure writer — the only place a KnowledgeMeasure is persisted.
 *
 * Replace semantics, exactly as the Claim writer has: delete the slot, create it again, in one
 * transaction. A measure has no history by design — history belongs to the EVIDENCE, and a derived
 * artifact that accumulated versions of itself would become a second, worse source of truth.
 *
 * Tenant-bound by construction, like the Claim writer after M0: the default client opens a
 * `tenantTx`, so the tenant the rule computed for is the tenant the database enforces.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import type { MeasureResult } from "./measure.contract";

/** Rejected before any mutation. Same class of failure as `MaterializationRejected`. */
export class MeasureRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasureRejected";
  }
}

export type MeasureWriteOutcome = {
  readonly action: "created" | "replaced";
  readonly measureId: number;
  readonly status: MeasureResult["status"];
  readonly observationCount: number;
  readonly evidenceLinkCount: number;
};

/**
 * Pure validation, before anything is written.
 *
 * The tenant check is the one that matters: every evidence ref must belong to the business the measure
 * is being written for. The database enforces the measure's own tenancy through RLS, but an evidence
 * link pointing at another tenant's record would be a true cross-tenant derivation — knowledge about A
 * built partly from B — and no row-level policy can see that, because the link's own `businessId`
 * would look perfectly valid.
 */
export function validateMeasure(businessId: number, result: MeasureResult): void {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new MeasureRejected("businessId must be a positive integer");
  }
  if (!result.measureKey) throw new MeasureRejected("measureKey is required");
  if (result.observationCount < 0) throw new MeasureRejected("observationCount cannot be negative");
  if (result.status === "ACTIVE" && result.valueNumeric == null) {
    throw new MeasureRejected("an ACTIVE measure must carry a value");
  }
  if (result.status === "INSUFFICIENT_EVIDENCE" && result.valueNumeric != null) {
    // Carrying a number under this status is how a "we don't know" quietly becomes a fact downstream.
    throw new MeasureRejected("INSUFFICIENT_EVIDENCE must not carry a value");
  }
  if (result.windowEnd < result.windowStart) throw new MeasureRejected("window ends before it starts");
  for (const ref of result.evidenceSet.refs) {
    if (ref.businessId !== businessId) {
      throw new MeasureRejected(
        `evidence ref ${ref.kind}:${ref.recordId} belongs to business ${ref.businessId}, not ${businessId}`,
      );
    }
  }
  if (result.evidenceSet.refs.length !== result.observationCount) {
    throw new MeasureRejected("observationCount must equal the number of evidence refs");
  }
}

/** The narrow surface the writer needs. Injectable so the writer is testable without a database. */
export interface MeasureWriterTx {
  knowledgeMeasure: {
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: number }>;
  };
}
export interface MeasureWriterClient {
  $transaction<T>(fn: (tx: MeasureWriterTx) => Promise<T>): Promise<T>;
}

function tenantMeasureClient(businessId: number): MeasureWriterClient {
  return {
    $transaction: <T>(fn: (tx: MeasureWriterTx) => Promise<T>): Promise<T> =>
      tenantTx(businessId, (tx) => fn(tx as unknown as MeasureWriterTx)),
  };
}

export async function writeMeasure(
  businessId: number,
  result: MeasureResult,
  rulePolicyVersionId: number,
  client: MeasureWriterClient = tenantMeasureClient(businessId),
): Promise<MeasureWriteOutcome> {
  validateMeasure(businessId, result);
  if (!Number.isInteger(rulePolicyVersionId) || rulePolicyVersionId <= 0) {
    throw new MeasureRejected("rulePolicyVersionId must be a positive integer");
  }

  return client.$transaction(async (tx) => {
    // The slot. `entityType`/`entityId` are matched as-is (including null) so a business-level measure
    // replaces the business-level measure and never a per-entity one.
    const removed = await tx.knowledgeMeasure.deleteMany({
      where: {
        businessId,
        measureKey: result.measureKey,
        entityType: result.entityType,
        entityId: result.entityId,
        rulePolicyVersionId,
      },
    });

    const created = await tx.knowledgeMeasure.create({
      data: {
        businessId,
        measureKey: result.measureKey,
        entityType: result.entityType,
        entityId: result.entityId,
        valueNumeric: result.valueNumeric ?? 0,
        valueUnit: result.valueUnit,
        detail: result.detail ?? undefined,
        observationCount: result.observationCount,
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
        trend: result.trend ?? undefined,
        status: result.status,
        rulePolicyVersionId,
        evidenceFingerprint: result.evidenceSet.fingerprint,
        // Written in the same statement as the measure: an explanation that can arrive separately is
        // an explanation that can be missing.
        evidenceLinks: {
          create: result.evidenceSet.refs.map((r) => ({
            businessId,
            evidenceKind: r.kind,
            evidenceRecordId: r.recordId,
          })),
        },
      },
    });

    return {
      action: removed.count > 0 ? ("replaced" as const) : ("created" as const),
      measureId: created.id,
      status: result.status,
      observationCount: result.observationCount,
      evidenceLinkCount: result.evidenceSet.refs.length,
    };
  });
}
