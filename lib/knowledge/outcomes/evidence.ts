/**
 * Closed Loop · the durable WHY of one recommendation version — PURE and deterministic.
 *
 * At issue, the generator knows a recommendation from the governed snapshot (slots that exist only in that
 * run). The owner asks later "why did Dubiz tell me this?", and the answer must be what Dubiz SAW THEN, not
 * what the ledger says today. So, in the same transaction that issues a version, the domain rows behind its
 * targets are reduced to a small structured record and stored (OutcomeRecommendationEvidence):
 *
 *   OVERDUE_INSTALLMENT   which installment of which commitment, its due date, how many days overdue, its
 *                         status, and whether any live payment already covered part of it (a code). NO money:
 *                         as everywhere in M9, amounts are used in memory only and never written.
 *   REVIEW_BACKLOG        how many documents waited, how long the oldest and newest had waited, and by which
 *                         intake channel (codes), with the document ids as references.
 *
 * Ids, ISO times, day counts and fixed codes only. No names (payee, title), no document
 * content, no free text. Coverage uses the tracker's rule: a live allocation on a RECORDED, unvoided payment.
 */
import { createHash } from "node:crypto";
import type { RecommendationType } from "./outcome.contract";

export const EVIDENCE_VERSION = "rec-evidence.v1";
/** References kept per backlog record; the count is always exact. */
export const EVIDENCE_REF_CAP = 50;

const DAY = 86_400_000;

export type EvidenceKind = "OVERDUE_INSTALLMENT" | "REVIEW_BACKLOG";
export type EvidenceRef = { readonly store: "Installment" | "Commitment" | "Document"; readonly id: number };

export type OverdueInstallmentFacts = {
  readonly installmentId: number;
  readonly commitmentId: number;
  readonly sequence: number;
  readonly dueAt: string;
  readonly daysOverdue: number;
  readonly installmentStatus: string;
  /** NONE: no live payment covers it; PARTIAL: some does, not all. (Fully covered is not overdue.) */
  readonly coverage: "NONE" | "PARTIAL";
  readonly severity: string | null;
};

export type ReviewBacklogFacts = {
  readonly pendingCount: number;
  readonly referencedCount: number;
  readonly oldestWaitingDays: number;
  readonly newestWaitingDays: number;
  readonly bySource: Readonly<Record<string, number>>;
  readonly threshold: number;
};

export type EvidenceFacts = OverdueInstallmentFacts | ReviewBacklogFacts;

export type EvidenceRecord = {
  readonly evidenceVersion: typeof EVIDENCE_VERSION;
  readonly kind: EvidenceKind;
  readonly facts: EvidenceFacts;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly factFingerprint: string;
  readonly capturedAt: Date;
};

/* ── domain rows, as the store reads them ─────────────────────────────────────────────────── */

export type InstallmentRow = {
  readonly id: number;
  readonly commitmentId: number;
  readonly sequence: number;
  readonly dueAt: Date;
  readonly status: string;
  /** Decimal as a string or number; converted to integer minor units here. */
  readonly scheduledAmount: string | number;
  readonly allocations: readonly {
    readonly allocatedAmount: string | number;
    readonly reversedAt: Date | null;
    readonly payment: { readonly status: string; readonly voidedAt: Date | null };
  }[];
};

export type PendingDocumentRow = { readonly id: number; readonly createdAt: Date; readonly source: string };

/* ── helpers ──────────────────────────────────────────────────────────────────────────────── */

const minor = (v: string | number): number => Math.round(Number(v) * 100);
const wholeDays = (from: Date, to: Date): number => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));

/** Intake channels as fixed codes. Anything else is OTHER, never its raw value. */
const SOURCE_CODES = new Set(["file", "upload", "email", "whatsapp", "camera", "scan"]);
const sourceCode = (s: string): string => (SOURCE_CODES.has(s) ? s : "other");

/** Canonical JSON: sorted keys, so the same facts always hash the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function evidenceFingerprint(kind: EvidenceKind, facts: EvidenceFacts, refs: readonly EvidenceRef[]): string {
  return createHash("sha256").update(`${EVIDENCE_VERSION}|${kind}|${canonical(facts)}|${canonical(refs)}`).digest("hex");
}

/* ── builders ─────────────────────────────────────────────────────────────────────────────── */

export function overdueInstallmentEvidence(row: InstallmentRow, severity: string | null, capturedAt: Date): EvidenceRecord {
  const scheduled = minor(row.scheduledAmount);
  const covered = row.allocations
    .filter((a) => a.reversedAt == null && a.payment.voidedAt == null && a.payment.status === "RECORDED")
    .reduce((s, a) => s + minor(a.allocatedAmount), 0);
  const facts: OverdueInstallmentFacts = {
    installmentId: row.id,
    commitmentId: row.commitmentId,
    sequence: row.sequence,
    dueAt: row.dueAt.toISOString(),
    daysOverdue: wholeDays(row.dueAt, capturedAt),
    installmentStatus: row.status,
    coverage: covered > 0 && covered < scheduled ? "PARTIAL" : "NONE",
    severity,
  };
  const refs: EvidenceRef[] = [{ store: "Installment", id: row.id }, { store: "Commitment", id: row.commitmentId }];
  return {
    evidenceVersion: EVIDENCE_VERSION, kind: "OVERDUE_INSTALLMENT", facts, evidenceRefs: refs,
    factFingerprint: evidenceFingerprint("OVERDUE_INSTALLMENT", facts, refs), capturedAt,
  };
}

export function reviewBacklogEvidence(docs: readonly PendingDocumentRow[], threshold: number, capturedAt: Date): EvidenceRecord {
  if (docs.length === 0) throw new Error("reviewBacklogEvidence: a backlog needs at least one document");
  const sorted = [...docs].sort((a, b) => a.id - b.id);
  const times = sorted.map((d) => d.createdAt.getTime());
  const bySource: Record<string, number> = {};
  for (const d of sorted) { const c = sourceCode(d.source); bySource[c] = (bySource[c] ?? 0) + 1; }
  const refs: EvidenceRef[] = sorted.slice(0, EVIDENCE_REF_CAP).map((d) => ({ store: "Document" as const, id: d.id }));
  const facts: ReviewBacklogFacts = {
    pendingCount: sorted.length,
    referencedCount: refs.length,
    oldestWaitingDays: wholeDays(new Date(Math.min(...times)), capturedAt),
    newestWaitingDays: wholeDays(new Date(Math.max(...times)), capturedAt),
    bySource,
    threshold,
  };
  return {
    evidenceVersion: EVIDENCE_VERSION, kind: "REVIEW_BACKLOG", facts, evidenceRefs: refs,
    factFingerprint: evidenceFingerprint("REVIEW_BACKLOG", facts, refs), capturedAt,
  };
}

export function evidenceKindFor(type: RecommendationType): EvidenceKind {
  return type === "SETTLE_OVERDUE_INSTALLMENT" ? "OVERDUE_INSTALLMENT" : "REVIEW_BACKLOG";
}

/* ── reading it back ──────────────────────────────────────────────────────────────────────── */

export type ParsedEvidence = EvidenceRecord & {
  /** true only for an owner-approved late capture: the facts are as of capturedAt, not as of issue. */
  readonly capturedAfterIssue: boolean;
  /** The stored facts still hash to their stored fingerprint. */
  readonly intact: boolean;
};

/** A stored row, re-validated: anything that does not match the contract is treated as no evidence. */
export function parseEvidence(row: {
  evidenceVersion: string; kind: string; facts: unknown; evidenceRefs: unknown; factFingerprint: string; capturedAt: Date; capturedAfterIssue: boolean;
}): ParsedEvidence | null {
  if (row.evidenceVersion !== EVIDENCE_VERSION) return null;
  if (row.kind !== "OVERDUE_INSTALLMENT" && row.kind !== "REVIEW_BACKLOG") return null;
  if (!row.facts || typeof row.facts !== "object" || !Array.isArray(row.evidenceRefs)) return null;
  const facts = row.facts as EvidenceFacts;
  const refs = (row.evidenceRefs as unknown[]).filter((r): r is EvidenceRef =>
    !!r && typeof r === "object" && typeof (r as EvidenceRef).store === "string" && Number.isInteger((r as EvidenceRef).id));
  const kind = row.kind as EvidenceKind;
  return {
    evidenceVersion: EVIDENCE_VERSION, kind, facts, evidenceRefs: refs, factFingerprint: row.factFingerprint, capturedAt: row.capturedAt,
    capturedAfterIssue: row.capturedAfterIssue,
    // Reconstructable: the stored facts still hash to the fingerprint stored beside them.
    intact: evidenceFingerprint(kind, facts, refs) === row.factFingerprint,
  };
}
