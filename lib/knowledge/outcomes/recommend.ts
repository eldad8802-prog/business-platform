/**
 * M9 · Recommendation generation and memory — PURE and deterministic.
 *
 * A recommendation is derived from GOVERNED KNOWLEDGE (a bks.v1 snapshot) plus the targets the domain
 * currently shows. It is never authored by a model: when a validated M8 finding cites the same
 * knowledge, the recommendation records that finding as its source (findingKey + Brain versions), but
 * the recommendation's type, subject and targets come from the catalogue.
 *
 * MEMORY. Dubiz must not nag, and must not have amnesia. What happens to a situation that is already
 * known is decided HERE, before any wording exists:
 *
 *   ACTIVE, same situation            → nothing (dedupe; the database also allows one ACTIVE per key)
 *   ACTIVE, materially changed        → the old version is SUPERSEDED, a new version is issued
 *   ACTIVE, validity elapsed          → EXPIRED (silence is recorded as no decision, never as a "no")
 *   ACTIVE, condition gone            → RESOLVED
 *   closed, owner REJECTED            → suppressed until the situation MATERIALLY changes
 *   closed, owner said NOT_NOW        → suppressed until the deferral passes (or material change)
 *   closed, owner ACCEPTED / MODIFIED → a RESOLVED episode may recur; an expired one waits for the
 *                                       outcome window (or material change) — no nagging mid-action
 *   closed, no decision               → a RESOLVED episode may recur; an EXPIRED one waits a cooldown
 */
import { createHash } from "node:crypto";
import type { BusinessKnowledgeSnapshot } from "../snapshot/snapshot.contract";
import type { ValidatedFinding } from "../brain/brain.contract";
import {
  EXPIRED_COOLDOWN_DAYS,
  RECOMMENDATION_TYPES,
  type RecommendationCandidate,
  type RecommendationSource,
  type RecommendationType,
  type StoredDecision,
  type StoredRecommendation,
} from "./outcome.contract";

const DAY = 86_400_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SEVERITY_RANK: Record<string, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export type DomainTargets = {
  /** Every document of this business currently waiting for review (bounded by the source). */
  readonly pendingDocumentIds: readonly number[];
};

export function recommendationKey(type: RecommendationType, subject: { type: string; id: number }): string {
  return `${type}:${subject.type}:${subject.id}`;
}

function fingerprint(type: string, targets: readonly number[], severity: string | null): string {
  return sha(`${type}|${targets.join(",")}|${severity ?? ""}`);
}

/** Candidates: only where the snapshot itself carries the supporting knowledge. */
export function deriveCandidates(snapshot: BusinessKnowledgeSnapshot, domain: DomainTargets): RecommendationCandidate[] {
  const out: RecommendationCandidate[] = [];

  // Documents: a review backlog. Supported by the L0 "document needs review" facts in the snapshot.
  const docFacts = snapshot.knowledge.filter((k) => k.kind === "FACT" && k.key === "documents-inbox").map((k) => k.slot).sort();
  const pending = [...new Set(domain.pendingDocumentIds)].sort((a, b) => a - b);
  if (pending.length >= RECOMMENDATION_TYPES.REVIEW_PENDING_DOCUMENTS.minTargets && docFacts.length > 0) {
    const subject = { type: "documents_review_queue", id: snapshot.businessId };
    out.push({
      type: "REVIEW_PENDING_DOCUMENTS", recommendationKey: recommendationKey("REVIEW_PENDING_DOCUMENTS", subject), subject,
      targets: pending, supportingSlots: docFacts, severity: null,
      evidenceFingerprint: fingerprint("REVIEW_PENDING_DOCUMENTS", pending, null),
    });
  }

  // Payables: each overdue installment the snapshot states as ACTION_REQUIRED.
  for (const k of snapshot.knowledge) {
    if (k.kind !== "FACT" || k.key !== "payables-schedule" || k.subject?.type !== "installment") continue;
    const v = k.value as { category?: string; severity?: string };
    if (v.category !== "ACTION_REQUIRED") continue;
    const id = Number(k.subject.id);
    const subject = { type: "installment", id };
    const severity = v.severity ?? null;
    out.push({
      type: "SETTLE_OVERDUE_INSTALLMENT", recommendationKey: recommendationKey("SETTLE_OVERDUE_INSTALLMENT", subject), subject,
      targets: [id], supportingSlots: [k.slot], severity,
      evidenceFingerprint: fingerprint("SETTLE_OVERDUE_INSTALLMENT", [id], severity),
    });
  }
  return out.sort((a, b) => a.recommendationKey.localeCompare(b.recommendationKey));
}

/** Has the situation changed enough that the owner's earlier answer no longer covers it? */
export function isMaterialChange(candidate: RecommendationCandidate, prior: StoredRecommendation): boolean {
  if (candidate.type === "REVIEW_PENDING_DOCUMENTS") {
    const before = new Set(prior.targets);
    const fresh = candidate.targets.filter((t) => !before.has(t)).length;
    return fresh >= Math.max(3, Math.ceil(prior.targets.length * 0.5));
  }
  if (candidate.type === "SETTLE_OVERDUE_INSTALLMENT") {
    return (SEVERITY_RANK[candidate.severity ?? ""] ?? -1) > (SEVERITY_RANK[prior.severity ?? ""] ?? -1);
  }
  return false;
}

/** The owner's effective decision on one recommendation version: the latest one, if any. */
export function effectiveDecision(decisions: readonly StoredDecision[], recommendationId: number): StoredDecision | null {
  const mine = decisions.filter((d) => d.recommendationId === recommendationId);
  if (mine.length === 0) return null;
  return [...mine].sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime() || a.id - b.id).at(-1)!;
}

export type SuppressionReason =
  | "DEDUPED_ACTIVE"
  | "SUPPRESSED_REJECTED"
  | "SUPPRESSED_NOT_NOW"
  | "SUPPRESSED_ACCEPTED_IN_PROGRESS"
  | "SUPPRESSED_EXPIRED_COOLDOWN";

export type IssueDraft = {
  readonly candidate: RecommendationCandidate;
  readonly version: number;
  readonly source: RecommendationSource;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly outcomeWindowEnd: Date;
  /** The ACTIVE version this one supersedes, if any. */
  readonly supersedesId: number | null;
  readonly reason: "NEW" | "MATERIAL_CHANGE" | "RECURRED";
};

export type ClosePlan = { readonly id: number; readonly status: "RESOLVED" | "EXPIRED" | "SUPERSEDED"; readonly reason: string };

export type RecommendationPlan = {
  readonly issue: IssueDraft[];
  readonly close: ClosePlan[];
  readonly suppressed: { readonly recommendationKey: string; readonly reason: SuppressionReason }[];
};

export type BrainLink = {
  readonly findings: readonly ValidatedFinding[];
  readonly meta: { contractVersion: string; promptVersion: string; contextVersion: string; model: string; contextFingerprint: string };
} | null;

function sourceFor(candidate: RecommendationCandidate, brain: BrainLink): RecommendationSource {
  if (!brain) return { kind: "KNOWLEDGE_RULE" };
  const slots = new Set(candidate.supportingSlots);
  const keys = brain.findings.filter((f) => f.knowledgeSlots.some((s) => slots.has(s))).map((f) => f.findingKey).sort();
  if (keys.length === 0) return { kind: "KNOWLEDGE_RULE" };
  return { kind: "BRAIN_FINDING", findingKey: keys[0], ...brain.meta };
}

export function planRecommendations(input: {
  asOf: Date;
  candidates: readonly RecommendationCandidate[];
  stored: readonly StoredRecommendation[];
  decisions: readonly StoredDecision[];
  brain: BrainLink;
}): RecommendationPlan {
  const { asOf } = input;
  const issue: IssueDraft[] = [];
  const close: ClosePlan[] = [];
  const suppressed: RecommendationPlan["suppressed"][number][] = [];
  const byKey = new Map<string, StoredRecommendation[]>();
  for (const r of input.stored) byKey.set(r.recommendationKey, [...(byKey.get(r.recommendationKey) ?? []), r]);
  const candidateKeys = new Set(input.candidates.map((c) => c.recommendationKey));

  // Every ACTIVE recommendation whose situation is gone is RESOLVED.
  for (const r of input.stored) {
    if (r.status === "ACTIVE" && !candidateKeys.has(r.recommendationKey)) close.push({ id: r.id, status: "RESOLVED", reason: "CONDITION_CLEARED" });
  }

  const draft = (candidate: RecommendationCandidate, version: number, supersedesId: number | null, reason: IssueDraft["reason"]): IssueDraft => {
    const spec = RECOMMENDATION_TYPES[candidate.type];
    return {
      candidate, version, source: sourceFor(candidate, input.brain), issuedAt: asOf,
      validUntil: new Date(asOf.getTime() + spec.validityDays * DAY),
      outcomeWindowEnd: new Date(asOf.getTime() + spec.outcomeWindowDays * DAY),
      supersedesId, reason,
    };
  };

  for (const candidate of input.candidates) {
    const versions = [...(byKey.get(candidate.recommendationKey) ?? [])].sort((a, b) => a.version - b.version);
    const latest = versions.at(-1);
    if (!latest) { issue.push(draft(candidate, 1, null, "NEW")); continue; }

    const material = isMaterialChange(candidate, latest);
    let status = latest.status;
    let closedAt = latest.closedAt;

    if (status === "ACTIVE") {
      if (asOf.getTime() > latest.validUntil.getTime()) {
        close.push({ id: latest.id, status: "EXPIRED", reason: "VALIDITY_ELAPSED" });
        status = "EXPIRED";
        closedAt = asOf;
      } else if (material) {
        issue.push(draft(candidate, latest.version + 1, latest.id, "MATERIAL_CHANGE"));
        continue;
      } else {
        suppressed.push({ recommendationKey: candidate.recommendationKey, reason: "DEDUPED_ACTIVE" });
        continue;
      }
    }

    // The latest version is closed. Whether the situation may be raised again is the owner's answer's.
    const decision = effectiveDecision(input.decisions, latest.id);
    let allowed: boolean;
    let why: SuppressionReason;
    switch (decision?.decision ?? "NONE") {
      case "REJECT":
        allowed = material; why = "SUPPRESSED_REJECTED"; break;
      case "NOT_NOW":
        allowed = material || (decision!.deferUntil != null && asOf.getTime() >= decision!.deferUntil.getTime());
        why = "SUPPRESSED_NOT_NOW"; break;
      case "ACCEPT":
      case "MODIFY":
        allowed = status === "RESOLVED" || material || asOf.getTime() >= latest.outcomeWindowEnd.getTime();
        why = "SUPPRESSED_ACCEPTED_IN_PROGRESS"; break;
      default:
        allowed = status === "RESOLVED" || material ||
          (closedAt != null && asOf.getTime() >= closedAt.getTime() + EXPIRED_COOLDOWN_DAYS * DAY);
        why = "SUPPRESSED_EXPIRED_COOLDOWN";
    }
    if (allowed) issue.push(draft(candidate, latest.version + 1, null, material ? "MATERIAL_CHANGE" : "RECURRED"));
    else suppressed.push({ recommendationKey: candidate.recommendationKey, reason: why });
  }

  // A supersession closes the version it replaces.
  for (const d of issue) if (d.supersedesId != null) close.push({ id: d.supersedesId, status: "SUPERSEDED", reason: "MATERIAL_CHANGE" });
  close.sort((a, b) => a.id - b.id);
  return { issue, close, suppressed: suppressed.sort((a, b) => a.recommendationKey.localeCompare(b.recommendationKey)) };
}
