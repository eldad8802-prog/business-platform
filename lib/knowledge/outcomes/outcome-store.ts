/**
 * M9 · The only file in lib/knowledge/outcomes that touches the database.
 *
 * Every read and write is ONE business's, inside `tenantTx(businessId, …)`, and every where-clause
 * repeats the businessId beside the GUC. Selects name their columns: ids, states, dates, counts. The
 * money a coverage decision needs (installment and allocation amounts) is read here and converted to
 * numbers in memory; it is never written by M9 and never leaves the server.
 *
 * History is never rewritten: action events, observations and decisions are INSERT-only (the runtime
 * has no UPDATE/DELETE on them, and a trigger refuses both for every role). Recommendations and
 * assessments move only their lifecycle columns, which the database also enforces.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import type {
  ActionEventDraft,
  DecisionKind,
  Modification,
  ObservationDraft,
  RecommendationType,
  StoredDecision,
  StoredRecommendation,
} from "./outcome.contract";
import type { ClosePlan, IssueDraft } from "./recommend";
import type { AssessAction, AssessObservation } from "./assess";
import type { DocumentTruth, ExistingObservation, InstallmentTruth } from "./track";
import type { Assessment } from "./outcome.contract";

const DAY = 86_400_000;
const TRACK_LOOKBACK_DAYS = 180;
const PENDING_DOCUMENT_CAP = 500;

const REC_SELECT = {
  id: true, recommendationKey: true, version: true, type: true, subjectType: true, subjectId: true, targets: true,
  severity: true, evidenceFingerprint: true, issuedAt: true, validUntil: true, outcomeWindowEnd: true, status: true, closedAt: true,
} as const;

function toStoredRecommendation(r: {
  id: number; recommendationKey: string; version: number; type: string; subjectType: string; subjectId: number; targets: unknown;
  severity: string | null; evidenceFingerprint: string; issuedAt: Date; validUntil: Date; outcomeWindowEnd: Date; status: string; closedAt: Date | null;
}): StoredRecommendation {
  return {
    ...r, type: r.type as RecommendationType, status: r.status as StoredRecommendation["status"],
    targets: Array.isArray(r.targets) ? (r.targets as unknown[]).map(Number).filter(Number.isInteger) : [],
  };
}

export type OutcomeState = {
  recommendations: StoredRecommendation[];
  decisions: StoredDecision[];
  actions: (AssessAction & { idempotencyKey: string })[];
  observations: (AssessObservation & ExistingObservation)[];
  activeAssessments: Map<number, { id: number; semanticHash: string }>;
  pendingDocumentIds: number[];
};

/** Everything M9 already knows for one business, plus the review queue the generator needs. */
export async function loadOutcomeState(businessId: number, asOf: Date): Promise<OutcomeState> {
  return tenantTx(businessId, async (tx) => {
    const since = new Date(asOf.getTime() - TRACK_LOOKBACK_DAYS * DAY);
    const recs = await tx.outcomeRecommendation.findMany({
      where: { businessId, OR: [{ status: "ACTIVE" }, { issuedAt: { gte: since } }] },
      select: REC_SELECT, orderBy: [{ recommendationKey: "asc" }, { version: "asc" }],
    });
    const ids = recs.map((r) => r.id);
    const decisions = await tx.outcomeDecision.findMany({
      where: { businessId, recommendationId: { in: ids } },
      select: { id: true, recommendationId: true, recommendationVersion: true, decision: true, modification: true, deferUntil: true, decidedAt: true, supersedesDecisionId: true },
    });
    const actions = await tx.outcomeActionEvent.findMany({
      where: { businessId, recommendationId: { in: ids } },
      select: { recommendationId: true, eventType: true, targetId: true, domainStore: true, domainRecordId: true, occurredAt: true, idempotencyKey: true },
    });
    const observations = await tx.outcomeObservation.findMany({
      where: { businessId, recommendationId: { in: ids } },
      select: {
        recommendationId: true, kind: true, valueInt: true, observedAt: true, idempotencyKey: true, evidenceStore: true, evidenceIds: true,
        reverses: { select: { idempotencyKey: true } },
      },
    });
    const assessments = await tx.outcomeAssessment.findMany({
      where: { businessId, recommendationId: { in: ids }, status: "ACTIVE" },
      select: { id: true, recommendationId: true, semanticHash: true },
    });
    const pending = await tx.document.findMany({
      where: { businessId, status: "needs_review" }, select: { id: true }, orderBy: { id: "asc" }, take: PENDING_DOCUMENT_CAP,
    });
    return {
      recommendations: recs.map(toStoredRecommendation),
      decisions: decisions.map((d) => ({
        ...d, decision: d.decision as DecisionKind,
        modification: d.modification && typeof d.modification === "object" ? (d.modification as unknown as Modification) : null,
      })),
      actions: actions.map((a) => ({ ...a, eventType: a.eventType as AssessAction["eventType"] })),
      observations: observations.map((o) => ({
        recommendationId: o.recommendationId, kind: o.kind, valueInt: o.valueInt, observedAt: o.observedAt, idempotencyKey: o.idempotencyKey,
        evidenceStore: o.evidenceStore, evidenceIds: Array.isArray(o.evidenceIds) ? (o.evidenceIds as unknown[]).map(Number) : [],
        reversesKey: o.reverses?.idempotencyKey ?? null,
      })),
      activeAssessments: new Map(assessments.map((a) => [a.recommendationId, { id: a.id, semanticHash: a.semanticHash }])),
      pendingDocumentIds: pending.map((d) => d.id),
    };
  });
}

/** Domain truth for the targets of the given recommendations. */
export async function loadDomainTruth(businessId: number, asOf: Date, recs: readonly StoredRecommendation[]) {
  return tenantTx(businessId, async (tx) => {
    const docTargets = [...new Set(recs.filter((r) => r.type === "REVIEW_PENDING_DOCUMENTS").flatMap((r) => r.targets))];
    const instTargets = [...new Set(recs.filter((r) => r.type === "SETTLE_OVERDUE_INSTALLMENT").flatMap((r) => r.targets))];

    const docs = docTargets.length === 0 ? [] : await tx.document.findMany({
      where: { businessId, id: { in: docTargets } }, select: { id: true, status: true },
    });
    const reviews = docTargets.length === 0 ? [] : await tx.reviewEvent.findMany({
      where: { businessId, documentId: { in: docTargets } },
      select: { id: true, documentId: true, occurredAt: true, reviewerUserId: true },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    const status = new Map(docs.map((d) => [d.id, d.status]));
    const firstReview = new Map<number, (typeof reviews)[number]>();
    for (const r of reviews) if (!firstReview.has(r.documentId)) firstReview.set(r.documentId, r);
    const documents = new Map<number, DocumentTruth>(docTargets.map((id) => [id, {
      documentId: id, status: status.get(id) ?? null,
      firstReview: firstReview.has(id) ? { id: firstReview.get(id)!.id, occurredAt: firstReview.get(id)!.occurredAt, reviewerUserId: firstReview.get(id)!.reviewerUserId } : null,
    }]));

    // The review backlog as it stood at each closed window's end, reconstructed from current state:
    // documents that existed then and had not yet been reviewed then. (A document deleted since is
    // not counted — stated in the M9 limitations.)
    const backlogAtWindowEnd = new Map<number, number>();
    for (const r of recs) {
      if (r.type !== "REVIEW_PENDING_DOCUMENTS" || r.outcomeWindowEnd.getTime() > asOf.getTime()) continue;
      const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "Document" d
          WHERE d."businessId" = $1 AND d."createdAt" <= $2
            AND NOT EXISTS (SELECT 1 FROM "ReviewEvent" e WHERE e."businessId" = $1 AND e."documentId" = d.id AND e."occurredAt" <= $2)
            AND (d.status = 'needs_review'
                 OR EXISTS (SELECT 1 FROM "ReviewEvent" e WHERE e."businessId" = $1 AND e."documentId" = d.id AND e."occurredAt" > $2))`,
        businessId, r.outcomeWindowEnd,
      );
      backlogAtWindowEnd.set(r.id, rows[0]?.n ?? 0);
    }

    const insts = instTargets.length === 0 ? [] : await tx.installment.findMany({
      where: { businessId, id: { in: instTargets } },
      select: {
        id: true, dueAt: true, status: true, scheduledAmount: true,
        allocations: {
          where: { businessId },
          select: {
            id: true, createdAt: true, createdByUserId: true, allocatedAmount: true, reversedAt: true,
            payment: { select: { id: true, status: true, paidAt: true, voidedAt: true } },
          },
        },
      },
    });
    const installments = new Map<number, InstallmentTruth>(insts.map((i) => [i.id, {
      installmentId: i.id, dueAt: i.dueAt, status: i.status, scheduledAmount: Number(i.scheduledAmount),
      allocations: i.allocations.map((a) => ({
        id: a.id, createdAt: a.createdAt, createdByUserId: a.createdByUserId, allocatedAmount: Number(a.allocatedAmount), reversedAt: a.reversedAt,
        payment: { id: a.payment.id, status: a.payment.status, paidAt: a.payment.paidAt, voidedAt: a.payment.voidedAt },
      })),
    }]));
    return { documents, installments, backlogAtWindowEnd };
  });
}

/** Lifecycle moves first (a successor can only be ACTIVE once its predecessor is not), then issues. */
export async function writeRecommendationPlan(
  businessId: number,
  asOf: Date,
  plan: { issue: readonly IssueDraft[]; close: readonly ClosePlan[] },
  meta: { snapshotFingerprint: string },
): Promise<{ issued: number; closed: Record<string, number> }> {
  return tenantTx(businessId, async (tx) => {
    const closed: Record<string, number> = {};
    for (const c of plan.close) {
      const r = await tx.outcomeRecommendation.updateMany({
        where: { id: c.id, businessId, status: "ACTIVE" },
        data: { status: c.status, closedAt: asOf, closedReason: c.reason },
      });
      if (r.count === 1) closed[c.status] = (closed[c.status] ?? 0) + 1;
    }
    let issued = 0;
    for (const d of plan.issue) {
      const s = d.source;
      const created = await tx.outcomeRecommendation.create({
        data: {
          businessId, recommendationKey: d.candidate.recommendationKey, version: d.version, type: d.candidate.type,
          family: d.candidate.type === "REVIEW_PENDING_DOCUMENTS" ? "documents" : "payables",
          subjectType: d.candidate.subject.type, subjectId: d.candidate.subject.id,
          targets: [...d.candidate.targets], targetCount: d.candidate.targets.length, supportingSlots: [...d.candidate.supportingSlots],
          severity: d.candidate.severity, evidenceFingerprint: d.candidate.evidenceFingerprint,
          sourceKind: s.kind,
          sourceFindingKey: s.kind === "BRAIN_FINDING" ? s.findingKey : null,
          brainContractVersion: s.kind === "BRAIN_FINDING" ? s.contractVersion : null,
          brainPromptVersion: s.kind === "BRAIN_FINDING" ? s.promptVersion : null,
          brainContextVersion: s.kind === "BRAIN_FINDING" ? s.contextVersion : null,
          brainModel: s.kind === "BRAIN_FINDING" ? s.model : null,
          contextFingerprint: s.kind === "BRAIN_FINDING" ? s.contextFingerprint : null,
          snapshotFingerprint: meta.snapshotFingerprint, generatorVersion: "rec-generator.v1",
          issuedAt: d.issuedAt, validUntil: d.validUntil, outcomeWindowEnd: d.outcomeWindowEnd,
        },
        select: { id: true },
      });
      issued += 1;
      if (d.supersedesId != null) {
        await tx.outcomeRecommendation.updateMany({
          where: { id: d.supersedesId, businessId, status: "SUPERSEDED", supersededById: null },
          data: { supersededById: created.id },
        });
      }
    }
    return { issued, closed };
  });
}

/** Append-only: duplicates (a retry, a replay, a rebuild) are skipped by their idempotency key. */
export async function writeTracking(
  businessId: number,
  asOf: Date,
  actions: readonly ActionEventDraft[],
  observations: readonly ObservationDraft[],
  assessments: readonly Assessment[],
  assessorVersion: string,
): Promise<{ actionsInserted: number; observationsInserted: number; assessmentsWritten: number; assessmentsConfirmed: number; assessmentsSuperseded: number }> {
  return tenantTx(businessId, async (tx) => {
    const a = actions.length === 0 ? { count: 0 } : await tx.outcomeActionEvent.createMany({
      data: actions.map((x) => ({ businessId, ...x, observedAt: asOf })),
      skipDuplicates: true,
    });

    const actionKeys = [...new Set(observations.map((o) => o.actionEventKey).filter((k): k is string => k != null))];
    const actionIds = new Map((actionKeys.length === 0 ? [] : await tx.outcomeActionEvent.findMany({
      where: { businessId, idempotencyKey: { in: actionKeys } }, select: { id: true, idempotencyKey: true },
    })).map((r) => [r.idempotencyKey, r.id]));
    const reverseKeys = [...new Set(observations.map((o) => o.reversesKey).filter((k): k is string => k != null))];
    const plain = observations.filter((o) => o.reversesKey == null);
    const toRow = (o: ObservationDraft, reversesObservationId: number | null) => ({
      businessId, recommendationId: o.recommendationId, actionEventId: o.actionEventKey ? actionIds.get(o.actionEventKey) ?? null : null,
      kind: o.kind, targetType: o.targetType, targetId: o.targetId, valueInt: o.valueInt, unit: o.unit,
      evidenceStore: o.evidenceStore, evidenceIds: [...o.evidenceIds], observedAt: o.observedAt,
      reversesObservationId, idempotencyKey: o.idempotencyKey,
    });
    let observationsInserted = plain.length === 0 ? 0 : (await tx.outcomeObservation.createMany({ data: plain.map((o) => toRow(o, null)), skipDuplicates: true })).count;
    if (reverseKeys.length > 0) {
      const targets = new Map((await tx.outcomeObservation.findMany({
        where: { businessId, idempotencyKey: { in: reverseKeys } }, select: { id: true, idempotencyKey: true },
      })).map((r) => [r.idempotencyKey, r.id]));
      const rows = observations.filter((o) => o.reversesKey != null && targets.has(o.reversesKey)).map((o) => toRow(o, targets.get(o.reversesKey!)!));
      if (rows.length > 0) observationsInserted += (await tx.outcomeObservation.createMany({ data: rows, skipDuplicates: true })).count;
    }

    let assessmentsWritten = 0, assessmentsConfirmed = 0, assessmentsSuperseded = 0;
    for (const s of assessments) {
      const live = await tx.outcomeAssessment.findFirst({
        where: { businessId, recommendationId: s.recommendationId, status: "ACTIVE" }, select: { id: true, semanticHash: true },
      });
      if (live && live.semanticHash === s.semanticHash) {
        await tx.outcomeAssessment.updateMany({ where: { id: live.id, businessId, status: "ACTIVE" }, data: { confirmedAt: asOf } });
        assessmentsConfirmed += 1;
        continue;
      }
      if (live) {
        await tx.outcomeAssessment.updateMany({ where: { id: live.id, businessId, status: "ACTIVE" }, data: { status: "SUPERSEDED", supersededAt: asOf } });
        assessmentsSuperseded += 1;
      }
      await tx.outcomeAssessment.create({
        data: {
          businessId, recommendationId: s.recommendationId, assessorVersion, decisionState: s.decisionState, actionState: s.actionState,
          outcomeState: s.outcomeState, direction: s.direction, attribution: s.attribution, uncertainty: s.uncertainty,
          windowStart: s.windowStart, windowEnd: s.windowEnd, observationCount: s.observationCount,
          evidenceRefs: s.evidenceRefs.map((r) => ({ store: r.store, id: r.id })), detail: s.detail, semanticHash: s.semanticHash,
          assessedAt: asOf, confirmedAt: asOf,
        },
      });
      assessmentsWritten += 1;
    }
    return { actionsInserted: a.count, observationsInserted, assessmentsWritten, assessmentsConfirmed, assessmentsSuperseded };
  }, { timeoutMs: 30_000 });
}

export type DecisionInput = {
  recommendationVersion: number;
  decision: DecisionKind;
  modification?: Modification | null;
  reasonCode?: string | null;
  deferUntil?: Date | null;
  idempotencyKey: string;
};

export type DecisionResult =
  | { ok: true; decisionId: number; duplicate: boolean }
  | { ok: false; code: "NOT_FOUND" | "NOT_ACTIVE" | "VERSION_MISMATCH" | "INVALID_MODIFICATION" };

/**
 * The owner's decision, appended. `actorUserId` MUST be server-derived (the session). Only an ACTIVE
 * version can be decided, and only the version the owner was answering: a decision about v1 is never
 * silently applied to v2. A change of mind is a new row naming the decision it supersedes.
 */
export async function appendOwnerDecision(
  businessId: number,
  recommendationId: number,
  actorUserId: number,
  input: DecisionInput,
  now: Date,
): Promise<DecisionResult> {
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) throw new Error("appendOwnerDecision: a server-derived actor is required");
  return tenantTx(businessId, async (tx) => {
    const dup = await tx.outcomeDecision.findFirst({
      where: { businessId, idempotencyKey: input.idempotencyKey }, select: { id: true, recommendationId: true },
    });
    if (dup) return dup.recommendationId === recommendationId ? { ok: true as const, decisionId: dup.id, duplicate: true } : { ok: false as const, code: "NOT_FOUND" as const };

    const rec = await tx.outcomeRecommendation.findFirst({
      where: { id: recommendationId, businessId }, select: { id: true, version: true, status: true, targets: true },
    });
    if (!rec) return { ok: false as const, code: "NOT_FOUND" as const };
    if (rec.status !== "ACTIVE") return { ok: false as const, code: "NOT_ACTIVE" as const };
    if (rec.version !== input.recommendationVersion) return { ok: false as const, code: "VERSION_MISMATCH" as const };
    if (input.decision === "MODIFY") {
      const allowed = new Set((rec.targets as unknown[]).map(Number));
      const t = input.modification?.targets ?? [];
      if (t.length === 0 || !t.every((x) => allowed.has(x)) || t.length === allowed.size) {
        return { ok: false as const, code: "INVALID_MODIFICATION" as const };
      }
    }
    const previous = await tx.outcomeDecision.findFirst({
      where: { businessId, recommendationId }, select: { id: true }, orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    });
    const created = await tx.outcomeDecision.create({
      data: {
        businessId, recommendationId, recommendationVersion: rec.version, decision: input.decision,
        modification: input.decision === "MODIFY" ? { targets: [...new Set(input.modification!.targets)].sort((a, b) => a - b) } : undefined,
        reasonCode: input.reasonCode ?? null, deferUntil: input.decision === "NOT_NOW" ? input.deferUntil ?? null : null,
        actorUserId, source: "OWNER_UI", decidedAt: now, idempotencyKey: input.idempotencyKey,
        supersedesDecisionId: previous?.id ?? null,
      },
      select: { id: true },
    });
    return { ok: true as const, decisionId: created.id, duplicate: false };
  });
}
