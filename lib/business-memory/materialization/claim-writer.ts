/**
 * Business Memory IMPL-5A · Derived Claim Persistence Writer (narrow, atomic, inert).
 *
 * Persists ONE validated DerivedClaimResult into exactly one projection slot, atomically. It is the
 * only place that writes Business Memory. It does NOT read canonical evidence, derive, resolve/select a
 * policy version, normalize, touch VendorLearning, or connect to any runtime flow. INERT: no product
 * caller (Materializer pre-impl v1 §21/§23).
 *
 * Replace semantics (v2 §13): transactional deleteMany(slot)+cascade, then a nested create — a full
 * replace, no Claim history. Idempotent: replaying the same valid command yields the same logical DB
 * state (delete-then-create is deterministic). Cross-request freshness is an upstream concern (§15).
 *
 * PolicyVersion handling is W-A (§4): the caller supplies `result.policyVersionId`; the Writer only
 * VALIDATES it exists — it never resolves policyKey→id, never reads current/latest. (Semantic binding
 * of the version to vendor-category/v1 is enforced UPSTREAM by the future Resolver, not here — §5.)
 */
import { prisma } from "@/lib/prisma";
import type {
  ClaimWriterClient,
  MaterializationCommand,
  MaterializationOutcome,
  ProjectionCreateData,
  ProjectionSlotWhere,
} from "./claim-writer.contract";
import { MaterializationRejected, validateCommand } from "./claim-writer.validate";

/**
 * Materialize one DerivedClaimResult. `client` is injectable (default: Prisma) so the Writer is
 * unit-testable with a fake — no real DB required.
 */
export async function materializeClaim(
  command: MaterializationCommand,
  client: ClaimWriterClient = prisma as unknown as ClaimWriterClient,
): Promise<MaterializationOutcome> {
  // 1) Pure validation BEFORE any mutation (tenant, structural, subset, state consistency).
  validateCommand(command);

  const { businessId, result } = command;
  const slot: ProjectionSlotWhere = {
    businessId,
    subjectDomain: result.subject.domain,
    subjectNormalizedKey: result.subject.normalizedKey,
    claimType: result.claimType,
    policyVersionId: result.policyVersionId,
  };
  const persist = result.state === "supported" || result.state === "conflicting";
  const evidenceLinkCount = result.candidates.reduce((sum, c) => sum + c.supportingRefs.length, 0);

  return client.$transaction(async (tx): Promise<MaterializationOutcome> => {
    // 2) PolicyVersion existence guard (W-A). Fail closed before touching the Claim tables.
    const pv = await tx.derivationPolicyVersion.findUnique({
      where: { id: result.policyVersionId },
      select: { id: true },
    });
    if (!pv) {
      throw new MaterializationRejected(`policyVersionId ${result.policyVersionId} does not exist`);
    }

    // 3) Replace: drop the existing slot (cascade removes candidates + evidence links). Unique slot →
    //    deleteMany removes 0 or 1. `count` tells us created-vs-replaced / deleted-vs-no-op.
    const { count: removed } = await tx.derivedClaimProjection.deleteMany({ where: slot });

    // 4a) insufficient / withdrawn → absence: delete only, create nothing (no empty root, no tombstone).
    if (!persist) {
      return {
        action: removed > 0 ? "deleted" : "no-op",
        slot,
        evidenceSetFingerprint: result.evidenceSetIdentity.fingerprint,
        candidateCount: 0,
        evidenceLinkCount: 0,
      };
    }

    // 4b) supported / conflicting → create a fresh projection with all candidates + evidence links.
    //     Candidates ordered by proposition value (deterministic, NOT precedence). Links keep the
    //     Deriver's canonical ref order.
    const data: ProjectionCreateData = {
      ...slot,
      evidenceSetFingerprint: result.evidenceSetIdentity.fingerprint,
      candidates: {
        create: [...result.candidates]
          .sort((a, b) => (a.propositionValue < b.propositionValue ? -1 : a.propositionValue > b.propositionValue ? 1 : 0))
          .map((c) => ({
            propositionValue: c.propositionValue,
            evidenceLinks: {
              create: c.supportingRefs.map((r) => ({
                businessId,
                evidenceKind: r.kind,
                evidenceRecordId: r.recordId,
              })),
            },
          })),
      },
    };
    await tx.derivedClaimProjection.create({ data });

    return {
      action: removed > 0 ? "replaced" : "created",
      slot,
      evidenceSetFingerprint: result.evidenceSetIdentity.fingerprint,
      candidateCount: result.candidates.length,
      evidenceLinkCount,
    };
  });
}
