/**
 * M9 · Action and outcome tracking — PURE. Domain truth in, append-only drafts out.
 *
 * An ACTION is what the ledger shows was done to a recommendation's target, not what anyone said
 * would be done. An OBSERVATION is what the ledger shows afterwards. Both are derived from immutable or
 * tombstoned domain records, keyed by those records, so re-running (a retry, a duplicate event, a
 * rebuild) produces the same keys and the writer inserts nothing new — including reversals, which are
 * replayed from the ledger timeline rather than remembered.
 *
 *   documents  PERFORMED  = the document's first ReviewEvent (immutable, human actor, business time)
 *              WITHDRAWN  = the document left the review queue without a review (deleted / failed)
 *              observed   = review backlog at issue, and at the end of the outcome window
 *   payables   PERFORMED  = a PaymentAllocation recorded after the recommendation, on a payment; its
 *                           time is the payment's own `paidAt` (owner-entered business time)
 *              REVERSED   = that allocation reversed, or its payment voided — a NEW event, never an edit
 *              WITHDRAWN  = the installment was cancelled
 *              observed   = the installment became fully covered (days late), and — separately —
 *                           that coverage being reversed
 *
 * Money is used only to decide coverage, in memory. What is stored is days, counts and record ids.
 */
import { createHash } from "node:crypto";
import {
  RECOMMENDATION_TYPES,
  type ActionEventDraft,
  type ObservationDraft,
  type StoredDecision,
  type StoredRecommendation,
} from "./outcome.contract";
import { effectiveDecision } from "./recommend";

const DAY = 86_400_000;
const key = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
const days = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);

export type DocumentTruth = {
  readonly documentId: number;
  /** null when the document no longer exists. */
  readonly status: string | null;
  readonly firstReview: { readonly id: number; readonly occurredAt: Date; readonly reviewerUserId: number } | null;
};

export type InstallmentTruth = {
  readonly installmentId: number;
  readonly dueAt: Date;
  readonly status: string;
  readonly scheduledAmount: number;
  readonly allocations: readonly {
    readonly id: number;
    readonly createdAt: Date;
    readonly createdByUserId: number | null;
    readonly allocatedAmount: number;
    readonly reversedAt: Date | null;
    readonly payment: { readonly id: number; readonly status: string; readonly paidAt: Date; readonly voidedAt: Date | null };
  }[];
};

export type DomainTruth = {
  readonly documents: ReadonlyMap<number, DocumentTruth>;
  readonly installments: ReadonlyMap<number, InstallmentTruth>;
  /** Review backlog reconstructed at a recommendation's window end, by recommendation id. */
  readonly backlogAtWindowEnd: ReadonlyMap<number, number>;
};

export type ExistingObservation = {
  readonly recommendationId: number;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly reversesKey: string | null;
  readonly observedAt: Date;
};

/** The version of a recommendation that was live when something happened to one of its targets. */
function versionAt(versions: readonly StoredRecommendation[], target: number, at: Date): StoredRecommendation | null {
  const eligible = versions.filter((v) => v.targets.includes(target) && v.issuedAt.getTime() <= at.getTime());
  return eligible.sort((a, b) => a.version - b.version).at(-1) ?? null;
}

function decisionFor(decisions: readonly StoredDecision[], rec: StoredRecommendation, at: Date): number | null {
  const d = effectiveDecision(decisions.filter((x) => x.decidedAt.getTime() <= at.getTime()), rec.id);
  return d && (d.decision === "ACCEPT" || d.decision === "MODIFY") ? d.id : null;
}

export function trackOutcomes(input: {
  asOf: Date;
  recommendations: readonly StoredRecommendation[];
  decisions: readonly StoredDecision[];
  truth: DomainTruth;
  /** Not needed: settlement history is replayed from the ledger, so a rebuild reproduces it. */
  existingObservations?: readonly ExistingObservation[];
}): { actions: ActionEventDraft[]; observations: ObservationDraft[] } {
  const { asOf, truth } = input;
  const actions: ActionEventDraft[] = [];
  const observations: ObservationDraft[] = [];
  const byKey = new Map<string, StoredRecommendation[]>();
  for (const r of input.recommendations) byKey.set(r.recommendationKey, [...(byKey.get(r.recommendationKey) ?? []), r]);

  for (const versions of [...byKey.values()]) {
    const first = [...versions].sort((a, b) => a.version - b.version)[0];

    if (first.type === "REVIEW_PENDING_DOCUMENTS") {
      const actionKind = RECOMMENDATION_TYPES.REVIEW_PENDING_DOCUMENTS.actionKind;
      const targets = [...new Set(versions.flatMap((v) => v.targets))].sort((a, b) => a - b);
      for (const t of targets) {
        const doc = truth.documents.get(t);
        const firstVersionWithT = versions.filter((v) => v.targets.includes(t)).sort((a, b) => a.version - b.version)[0];
        if (doc?.firstReview) {
          const at = doc.firstReview.occurredAt;
          const rec = versionAt(versions, t, at) ?? firstVersionWithT;
          actions.push({
            recommendationId: rec.id, decisionId: decisionFor(input.decisions, rec, at), actionKind, eventType: "PERFORMED",
            targetType: "document", targetId: t, domainStore: "ReviewEvent", domainRecordId: doc.firstReview.id,
            actorUserId: doc.firstReview.reviewerUserId, occurredAt: at,
            idempotencyKey: key("act", rec.id, "PERFORMED", "ReviewEvent", doc.firstReview.id),
          });
        } else if (!doc || doc.status !== "needs_review") {
          // Left the queue without a review: the domain withdrew the target. Not a decision, not an action.
          const rec = versions.filter((v) => v.targets.includes(t)).sort((a, b) => a.version - b.version).at(-1)!;
          actions.push({
            recommendationId: rec.id, decisionId: null, actionKind, eventType: "WITHDRAWN",
            targetType: "document", targetId: t, domainStore: "Document", domainRecordId: t,
            actorUserId: null, occurredAt: asOf, idempotencyKey: key("act", rec.id, "WITHDRAWN", "Document", t),
          });
        }
      }
      for (const v of versions) {
        observations.push({
          recommendationId: v.id, actionEventKey: null, kind: "REVIEW_BACKLOG_AT_ISSUE", targetType: null, targetId: null,
          valueInt: v.targets.length, unit: "count", evidenceStore: "OutcomeRecommendation", evidenceIds: [v.id],
          observedAt: v.issuedAt, reversesKey: null, idempotencyKey: key("obs", v.id, "REVIEW_BACKLOG_AT_ISSUE"),
        });
        const end = truth.backlogAtWindowEnd.get(v.id);
        if (asOf.getTime() >= v.outcomeWindowEnd.getTime() && end != null) {
          observations.push({
            recommendationId: v.id, actionEventKey: null, kind: "REVIEW_BACKLOG_AT_WINDOW_END", targetType: null, targetId: null,
            valueInt: end, unit: "count", evidenceStore: "Document", evidenceIds: [],
            observedAt: v.outcomeWindowEnd, reversesKey: null, idempotencyKey: key("obs", v.id, "REVIEW_BACKLOG_AT_WINDOW_END"),
          });
        }
      }
    }

    if (first.type === "SETTLE_OVERDUE_INSTALLMENT") {
      const actionKind = RECOMMENDATION_TYPES.SETTLE_OVERDUE_INSTALLMENT.actionKind;
      const t = first.subjectId;
      const inst = truth.installments.get(t);
      if (!inst) continue;
      const firstIssued = [...versions].sort((a, b) => a.version - b.version)[0].issuedAt;
      if (inst.status === "CANCELLED") {
        const rec = [...versions].sort((a, b) => a.version - b.version).at(-1)!;
        actions.push({
          recommendationId: rec.id, decisionId: null, actionKind, eventType: "WITHDRAWN", targetType: "installment", targetId: t,
          domainStore: "Installment", domainRecordId: t, actorUserId: null, occurredAt: asOf,
          idempotencyKey: key("act", rec.id, "WITHDRAWN", "Installment", t),
        });
      }
      // Only allocations RECORDED after the recommendation existed are candidate responses to it.
      const allocs = inst.allocations.filter((a) => a.createdAt.getTime() >= firstIssued.getTime())
        .sort((a, b) => a.payment.paidAt.getTime() - b.payment.paidAt.getTime() || a.id - b.id);
      for (const a of allocs) {
        const rec = versionAt(versions, t, a.createdAt) ?? versions[0];
        const performedKey = key("act", rec.id, "PERFORMED", "PaymentAllocation", a.id);
        actions.push({
          recommendationId: rec.id, decisionId: decisionFor(input.decisions, rec, a.createdAt), actionKind, eventType: "PERFORMED",
          targetType: "installment", targetId: t, domainStore: "PaymentAllocation", domainRecordId: a.id,
          actorUserId: a.createdByUserId, occurredAt: a.payment.paidAt, idempotencyKey: performedKey,
        });
        const undone = [a.reversedAt, a.payment.voidedAt].filter((x): x is Date => x != null).sort((x, y) => x.getTime() - y.getTime())[0];
        if (undone) {
          actions.push({
            recommendationId: rec.id, decisionId: null, actionKind, eventType: "REVERSED",
            targetType: "installment", targetId: t, domainStore: "PaymentAllocation", domainRecordId: a.id,
            actorUserId: null, occurredAt: undone, idempotencyKey: key("act", rec.id, "REVERSED", "PaymentAllocation", a.id),
          });
        }
      }

      // Settlement HISTORY, replayed from the ledger alone so a rebuild reproduces it exactly: every
      // allocation enters when recorded and leaves when reversed or its payment is voided. Each time
      // coverage reaches the scheduled amount a settlement is observed; each time it falls back below,
      // that settlement is reversed — by a NEW observation, never by editing the old one.
      type Step = { at: Date; id: number; delta: number; paidAt: Date };
      const steps: Step[] = [];
      for (const a of inst.allocations) {
        if (a.payment.status !== "RECORDED" && a.payment.voidedAt == null) continue; // never a live payment
        steps.push({ at: a.createdAt, id: a.id, delta: a.allocatedAmount, paidAt: a.payment.paidAt });
        const undone = [a.reversedAt, a.payment.voidedAt].filter((x): x is Date => x != null).sort((x, y) => x.getTime() - y.getTime())[0];
        if (undone) steps.push({ at: undone, id: a.id, delta: -a.allocatedAmount, paidAt: a.payment.paidAt });
      }
      steps.sort((x, y) => x.at.getTime() - y.at.getTime() || (y.delta > 0 ? 1 : 0) - (x.delta > 0 ? 1 : 0) || x.id - y.id);
      const liveSet = new Map<number, Step>();
      let covered = 0;
      let open: { key: string; recId: number } | null = null;
      for (const st of steps) {
        if (st.delta > 0) liveSet.set(st.id, st); else liveSet.delete(st.id);
        covered += st.delta;
        const isSettled = covered >= inst.scheduledAmount - 0.005;
        if (isSettled && !open && st.delta > 0 && st.at.getTime() >= firstIssued.getTime()) {
          const set = [...liveSet.keys()].sort((x, y) => x - y);
          const settleRec = versionAt(versions, t, st.at) ?? versions[0];
          const settledKey = key("obs", first.recommendationKey, "INSTALLMENT_SETTLED", set.join(","));
          // Business time of the settlement: the latest payment date among the covering allocations.
          const paid = [...liveSet.values()].map((x) => x.paidAt).sort((x, y) => y.getTime() - x.getTime())[0];
          observations.push({
            recommendationId: settleRec.id, actionEventKey: key("act", settleRec.id, "PERFORMED", "PaymentAllocation", st.id),
            kind: "INSTALLMENT_SETTLED", targetType: "installment", targetId: t,
            valueInt: days(inst.dueAt, paid), unit: "days", evidenceStore: "PaymentAllocation",
            evidenceIds: set, observedAt: paid, reversesKey: null, idempotencyKey: settledKey,
          });
          open = { key: settledKey, recId: settleRec.id };
        } else if (!isSettled && open) {
          observations.push({
            recommendationId: open.recId, actionEventKey: null, kind: "INSTALLMENT_SETTLEMENT_REVERSED", targetType: "installment", targetId: t,
            valueInt: null, unit: null, evidenceStore: "PaymentAllocation", evidenceIds: [st.id],
            observedAt: st.at, reversesKey: open.key, idempotencyKey: key("obs", "reversal", open.key),
          });
          open = null;
        } else if (isSettled && !open) {
          // Already covered before the recommendation existed: nothing to observe for it.
          open = { key: "pre-existing", recId: 0 };
        }
      }
    }
  }

  const uniq = <T extends { idempotencyKey: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.idempotencyKey, x])).values()]
    .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
  return { actions: uniq(actions), observations: uniq(observations) };
}
