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
import { RECOMMENDATION_TYPES } from "./outcome.contract";
import {
  overdueInstallmentEvidence,
  parseEvidence,
  reviewBacklogEvidence,
  type EvidenceRecord,
  type OverdueInstallmentFacts,
  type ParsedEvidence,
} from "./evidence";

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

/**
 * Lifecycle moves first (a successor can only be ACTIVE once its predecessor is not), then issues.
 *
 * Every issued version gets its durable WHY in the SAME transaction, built from the domain rows behind its
 * targets as they stand now (the moment of issue). A version whose evidence cannot be built is not issued:
 * the whole plan rolls back and the derivation reports write_plan. No recommendation exists without its WHY.
 */
export async function writeRecommendationPlan(
  businessId: number,
  asOf: Date,
  plan: { issue: readonly IssueDraft[]; close: readonly ClosePlan[] },
  meta: { snapshotFingerprint: string },
): Promise<{ issued: number; closed: Record<string, number>; evidence: number }> {
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
    let evidence = 0;
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

      let record: EvidenceRecord;
      if (d.candidate.type === "SETTLE_OVERDUE_INSTALLMENT") {
        const inst = await tx.installment.findFirst({
          where: { id: d.candidate.subject.id, businessId },
          select: {
            id: true, commitmentId: true, sequence: true, dueAt: true, status: true, scheduledAmount: true,
            allocations: { where: { businessId }, select: { allocatedAmount: true, reversedAt: true, payment: { select: { status: true, voidedAt: true } } } },
          },
        });
        if (!inst) throw new Error("writeRecommendationPlan: the installment behind a recommendation is gone");
        record = overdueInstallmentEvidence({
          ...inst, scheduledAmount: inst.scheduledAmount.toString(),
          allocations: inst.allocations.map((a) => ({ ...a, allocatedAmount: a.allocatedAmount.toString() })),
        }, d.candidate.severity, asOf);
      } else {
        const docs = await tx.document.findMany({
          where: { businessId, id: { in: [...d.candidate.targets] } }, select: { id: true, createdAt: true, source: true },
        });
        if (docs.length === 0) throw new Error("writeRecommendationPlan: the documents behind a recommendation are gone");
        record = reviewBacklogEvidence(docs, RECOMMENDATION_TYPES.REVIEW_PENDING_DOCUMENTS.minTargets, asOf);
      }
      await tx.outcomeRecommendationEvidence.create({
        data: {
          businessId, recommendationId: created.id, evidenceVersion: record.evidenceVersion, kind: record.kind,
          facts: record.facts as object, evidenceRefs: record.evidenceRefs.map((r) => ({ store: r.store, id: r.id })),
          factFingerprint: record.factFingerprint, capturedAt: record.capturedAt, capturedAfterIssue: false,
        },
      });
      evidence += 1;
      if (d.supersedesId != null) {
        await tx.outcomeRecommendation.updateMany({
          where: { id: d.supersedesId, businessId, status: "SUPERSEDED", supersededById: null },
          data: { supersededById: created.id },
        });
      }
    }
    return { issued, closed, evidence };
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

/* ── Owner surface (read) ─────────────────────────────────────────────────────────────────── */

/** How far back a closed recommendation stays on the owner's surface (its "after" view). */
export const OWNER_SURFACE_CLOSED_DAYS = 45;
const OWNER_DOCUMENT_CAP = 50;

export type OwnerRecommendationRow = {
  id: number;
  version: number;
  type: RecommendationType;
  status: StoredRecommendation["status"];
  issuedAt: Date;
  validUntil: Date;
  outcomeWindowEnd: Date;
  closedAt: Date | null;
  closedReason: string | null;
  targets: number[];
  severity: string | null;
  evidence: ParsedEvidence;
  decision: { decision: DecisionKind; reasonCode: string | null; deferUntil: Date | null; decidedAt: Date; targets: number[] | null } | null;
  actions: { eventType: string; targetId: number; occurredAt: Date }[];
  observations: { kind: string; targetId: number | null; valueInt: number | null; observedAt: Date }[];
  assessment: { actionState: string; outcomeState: string; direction: string; attribution: string; uncertainty: string; windowEnd: Date } | null;
  /** Live, the owner's own records, for display only — never stored as evidence, no money. */
  context: {
    commitment: { id: number; title: string } | null;
    documents: { id: number; createdAt: Date; originalFilename: string | null; status: string }[];
  };
};

/**
 * What the owner's recommendation surface shows, for ONE business: the ACTIVE versions and the ones closed in
 * the last OWNER_SURFACE_CLOSED_DAYS, each WITH its durable evidence. A version without evidence (issued before
 * evidence existed) is not shown — its WHY cannot be reconstructed — and is only counted.
 */
export async function loadOwnerRecommendations(
  businessId: number,
  asOf: Date,
  opts: { id?: number } = {},
): Promise<{ items: OwnerRecommendationRow[]; withoutEvidence: number }> {
  return tenantTx(businessId, async (tx) => {
    const since = new Date(asOf.getTime() - OWNER_SURFACE_CLOSED_DAYS * DAY);
    const recs = await tx.outcomeRecommendation.findMany({
      where: opts.id != null
        ? { businessId, id: opts.id }
        : { businessId, OR: [{ status: "ACTIVE" }, { closedAt: { gte: since } }] },
      select: {
        id: true, version: true, type: true, status: true, issuedAt: true, validUntil: true, outcomeWindowEnd: true,
        closedAt: true, closedReason: true, targets: true, severity: true,
        evidence: {
          select: { evidenceVersion: true, kind: true, facts: true, evidenceRefs: true, factFingerprint: true, capturedAt: true, capturedAfterIssue: true },
        },
      },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    const shown: { r: (typeof recs)[number]; evidence: ParsedEvidence }[] = [];
    for (const r of recs) {
      const evidence = r.evidence ? parseEvidence(r.evidence) : null;
      if (evidence) shown.push({ r, evidence });
    }
    const ids = shown.map((x) => x.r.id);
    if (ids.length === 0) return { items: [], withoutEvidence: recs.length };

    const decisions = await tx.outcomeDecision.findMany({
      where: { businessId, recommendationId: { in: ids } },
      select: { recommendationId: true, decision: true, reasonCode: true, deferUntil: true, decidedAt: true, modification: true },
      orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
    });
    const actions = await tx.outcomeActionEvent.findMany({
      where: { businessId, recommendationId: { in: ids } },
      select: { recommendationId: true, eventType: true, targetId: true, occurredAt: true },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    const observations = await tx.outcomeObservation.findMany({
      where: { businessId, recommendationId: { in: ids } },
      select: { recommendationId: true, kind: true, targetId: true, valueInt: true, observedAt: true },
      orderBy: [{ observedAt: "asc" }, { id: "asc" }],
    });
    const assessments = await tx.outcomeAssessment.findMany({
      where: { businessId, recommendationId: { in: ids }, status: "ACTIVE" },
      select: { recommendationId: true, actionState: true, outcomeState: true, direction: true, attribution: true, uncertainty: true, windowEnd: true },
    });

    const targetsOf = (r: (typeof recs)[number]) => (Array.isArray(r.targets) ? (r.targets as unknown[]).map(Number).filter(Number.isInteger) : []);
    const commitmentIdOf = (e: ParsedEvidence) => (e.kind === "OVERDUE_INSTALLMENT" ? (e.facts as OverdueInstallmentFacts).commitmentId : null);
    const commitmentIds = [...new Set(shown.map((x) => commitmentIdOf(x.evidence)).filter((x): x is number => x != null))];
    const commitments = commitmentIds.length === 0 ? [] : await tx.commitment.findMany({
      where: { businessId, id: { in: commitmentIds } }, select: { id: true, title: true },
    });
    const docIds = [...new Set(shown.filter((x) => x.r.type === "REVIEW_PENDING_DOCUMENTS").flatMap((x) => targetsOf(x.r).slice(0, OWNER_DOCUMENT_CAP)))];
    const docs = docIds.length === 0 ? [] : await tx.document.findMany({
      where: { businessId, id: { in: docIds } }, select: { id: true, createdAt: true, originalFilename: true, status: true },
    });
    const docById = new Map(docs.map((d) => [d.id, d]));
    const commitmentById = new Map(commitments.map((c) => [c.id, c]));

    const items = shown.map(({ r, evidence }): OwnerRecommendationRow => {
      const targets = targetsOf(r);
      const last = decisions.filter((d) => d.recommendationId === r.id).at(-1);
      const a = assessments.find((x) => x.recommendationId === r.id);
      const commitmentId = commitmentIdOf(evidence);
      const mod = last?.modification as { targets?: unknown } | null | undefined;
      return {
        id: r.id, version: r.version, type: r.type as RecommendationType, status: r.status as StoredRecommendation["status"],
        issuedAt: r.issuedAt, validUntil: r.validUntil, outcomeWindowEnd: r.outcomeWindowEnd, closedAt: r.closedAt, closedReason: r.closedReason,
        targets, severity: r.severity, evidence,
        decision: last ? {
          decision: last.decision as DecisionKind, reasonCode: last.reasonCode, deferUntil: last.deferUntil, decidedAt: last.decidedAt,
          targets: mod && Array.isArray(mod.targets) ? mod.targets.map(Number) : null,
        } : null,
        actions: actions.filter((x) => x.recommendationId === r.id).map((x) => ({ eventType: x.eventType, targetId: x.targetId, occurredAt: x.occurredAt })),
        observations: observations.filter((x) => x.recommendationId === r.id)
          .map((x) => ({ kind: x.kind, targetId: x.targetId, valueInt: x.valueInt, observedAt: x.observedAt })),
        assessment: a ? { actionState: a.actionState, outcomeState: a.outcomeState, direction: a.direction, attribution: a.attribution, uncertainty: a.uncertainty, windowEnd: a.windowEnd } : null,
        context: {
          commitment: commitmentId != null ? commitmentById.get(commitmentId) ?? null : null,
          documents: r.type === "REVIEW_PENDING_DOCUMENTS"
            ? targets.slice(0, OWNER_DOCUMENT_CAP).map((id) => docById.get(id)).filter((d): d is NonNullable<typeof d> => d != null)
            : [],
        },
      };
    });
    return { items, withoutEvidence: recs.length - shown.length };
  });
}

/** Sentinel: every probe transaction is rolled back, whether the database refused the write or not. */
class ProbeRollback extends Error {}

export type GuardProbe = { catalog: Record<string, number | boolean>; probes: Record<string, string>; holds: boolean };

/**
 * Production verification of the M9 guards AS THE RUNTIME ROLE, persisting nothing.
 *
 * Catalog facts (constraints, partial indexes, triggers, per-command policies, composite tenant keys)
 * are read; then writes that MUST be refused are attempted, each in its own tenant transaction that is
 * always rolled back. A probe that is not refused reports ALLOWED and fails `holds` — and still commits
 * nothing. Only this business's own rows are touched, and only inside a rolled-back transaction.
 */
export async function probeOutcomeGuards(businessId: number): Promise<GuardProbe> {
  const tables = ["OutcomeRecommendation", "OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation", "OutcomeAssessment"];
  const catalog = await tenantTx(businessId, async (tx) => {
    const q = async (sql: string) => Number((await tx.$queryRawUnsafe<{ n: number }[]>(sql, tables))[0]?.n ?? -1);
    return {
      checkConstraints: await q(`SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = ANY($1::text[]) AND c.contype = 'c'`),
      compositeTenantKeys: await q(`SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = ANY($1::text[]) AND c.contype = 'f' AND array_length(c.conkey, 1) = 2`),
      partialUniqueIndexes: await q(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = ANY($1::text[]) AND indexname LIKE '%_one_active_key' AND indexdef LIKE '%WHERE%'`),
      enabledGuardTriggers: await q(`SELECT count(*)::int AS n FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid WHERE t.relname = ANY($1::text[]) AND NOT g.tgisinternal AND g.tgenabled = 'O'`),
      perCommandPolicies: await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1::text[]) AND cmd <> 'ALL'`),
      forAllPolicies: await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1::text[]) AND cmd = 'ALL'`),
      attributionCheckIsSequenceOnly: (await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'OutcomeAssessment_attribution_chk'
        AND pg_get_constraintdef(oid) LIKE '%OBSERVED_SEQUENCE%' AND pg_get_constraintdef(oid) NOT ILIKE '%CAUS%' AND pg_get_constraintdef(oid) NOT ILIKE '%CONTRIBUT%' AND ($1::text[]) IS NOT NULL`)) === 1,
    };
  });

  const probes: Record<string, string> = {};
  const attempt = async (name: string, sql: string, ...params: unknown[]) => {
    try {
      await tenantTx(businessId, async (tx) => { await tx.$executeRawUnsafe(sql, ...params); throw new ProbeRollback(); });
    } catch (e) {
      if (e instanceof ProbeRollback) { probes[name] = "ALLOWED"; return; }
      const code = (e as { meta?: { code?: string } })?.meta?.code ?? /\b(42501|23514|23503|DZ90[12])\b/.exec(String((e as Error)?.message))?.[1] ?? "ERR";
      probes[name] = `REFUSED:${code}`;
    }
  };
  for (const t of ["OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation"]) {
    await attempt(`update_${t}`, `UPDATE "${t}" SET "createdAt" = "createdAt" WHERE false`);
  }
  for (const t of tables) await attempt(`delete_${t}`, `DELETE FROM "${t}" WHERE false`);
  await attempt("causal_attribution", `INSERT INTO "OutcomeAssessment" ("businessId","recommendationId","assessorVersion","decisionState","actionState","outcomeState","direction","attribution","uncertainty","windowStart","windowEnd","observationCount","evidenceRefs","detail","semanticHash","assessedAt","confirmedAt")
    VALUES ($1, -1, 'probe', 'NONE', 'NOT_STARTED', 'PENDING', 'NOT_MEASURABLE', 'CAUSED', 'probe', now(), now(), 0, '[]', '{}', 'probe', now(), now())`, businessId);
  await attempt("dangling_tenant_reference", `INSERT INTO "OutcomeDecision" ("businessId","recommendationId","recommendationVersion","decision","actorUserId","source","decidedAt","idempotencyKey")
    VALUES ($1, -1, 1, 'ACCEPT', 1, 'PROBE', now(), 'm9-guard-probe')`, businessId);
  const live = await tenantTx(businessId, (tx) => tx.outcomeRecommendation.findFirst({ where: { businessId, status: "ACTIVE" }, select: { id: true } }));
  if (live) await attempt("recommendation_content_edit", `UPDATE "OutcomeRecommendation" SET "targetCount" = "targetCount" + 1 WHERE "businessId" = $1 AND id = $2`, businessId, live.id);

  const refused = (k: string, codes: string[]) => codes.some((c) => probes[k] === `REFUSED:${c}`);
  const holds =
    catalog.checkConstraints === 10 && catalog.compositeTenantKeys === 8 && catalog.partialUniqueIndexes === 2 &&
    catalog.enabledGuardTriggers === 5 && catalog.perCommandPolicies === 12 && catalog.forAllPolicies === 0 && catalog.attributionCheckIsSequenceOnly &&
    ["OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation"].every((t) => refused(`update_${t}`, ["42501"])) &&
    tables.every((t) => refused(`delete_${t}`, ["42501"])) &&
    refused("causal_attribution", ["23514"]) && refused("dangling_tenant_reference", ["23503"]) &&
    (!live || refused("recommendation_content_edit", ["DZ902", "P0001"]));
  return { catalog, probes, holds };
}
