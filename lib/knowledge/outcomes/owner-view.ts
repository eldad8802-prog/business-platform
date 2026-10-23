/**
 * Closed Loop · what the owner reads about ONE recommendation — PURE, deterministic, no model.
 *
 *   WHAT        the action, in the owner's terms
 *   WHY         what Dubiz saw, from the durable evidence captured at issue (never recomputed from today)
 *   EVIDENCE    the captured facts themselves, dated, with how they were captured
 *   WHAT NOW    the owner's options (the OwnerDecision contract), and where ACCEPT takes them: the real
 *               domain flow (payables / document review). Nothing here marks anything done; completion is
 *               what the ledger later shows.
 *   AFTER       the decision, the ledger's actions and observations and the assessment, worded as a
 *               SEQUENCE only: "after the recommendation and the action, the payment was recorded". Never a
 *               cause, never credit to Dubiz — the assessor itself only knows OBSERVED_SEQUENCE.
 *
 * No money (M9 never stores it), no names beyond the owner's own commitment title / file name, which are
 * read live for display and are not evidence.
 */
import type { Locale } from "@/lib/i18n/config";
import { formatDate } from "@/lib/i18n/format";
import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";
import type { OwnerRecommendationRow } from "./outcome-store";
import { NOT_NOW_DEFAULT_DAYS, NOT_NOW_MAX_DAYS, REASON_CODES, type DecisionKind, type ReasonCode } from "./outcome.contract";
import type { OverdueInstallmentFacts, ReviewBacklogFacts } from "./evidence";

export const OWNER_VIEW_VERSION = "owner-view.v1";

export type OwnerActionOption = {
  readonly decision: DecisionKind;
  readonly label: string;
  /** ACCEPT / MODIFY: where the owner continues, in the existing domain flow. */
  readonly href: string | null;
};

export type OwnerRecommendationView = {
  readonly id: number;
  readonly version: number;
  readonly type: OwnerRecommendationRow["type"];
  /** waiting: needs an answer · in_progress: accepted, the ledger shows it is not finished · closed: anything else */
  readonly stage: "waiting" | "in_progress" | "closed";
  readonly what: string;
  readonly summary: string;
  readonly why: readonly string[];
  readonly evidence: { readonly lines: readonly string[]; readonly capturedAt: string; readonly capturedNote: string; readonly intact: boolean };
  readonly options: readonly OwnerActionOption[];
  /** For MODIFY: the targets the owner may narrow to (documents only). */
  readonly selectable: readonly { readonly id: number; readonly label: string }[];
  readonly status: string;
  readonly after: readonly string[];
  readonly decidable: boolean;
  readonly handoff: string | null;
  readonly decision: { readonly decision: DecisionKind; readonly label: string; readonly at: string } | null;
  readonly issuedAt: string;
  readonly validUntil: string;
};

/**
 * Wording follows the interface language: every builder takes an optional `t` (+ `locale` for dates).
 * Without them the view is the Hebrew it always was — the Hebrew dictionary holds these strings verbatim.
 */
const HE_T: Translator = createTranslator(he);

/** Reason labels, in the given language (Hebrew by default). */
export function reasonLabels(t: Translator = HE_T): Readonly<Record<ReasonCode, string>> {
  return Object.fromEntries(REASON_CODES.map((code) => [code, t(`insights.recommendations.reasons.${code}`)])) as Record<ReasonCode, string>;
}
export const REASON_LABELS: Readonly<Record<ReasonCode, string>> = reasonLabels();
export function reasonOptions(t: Translator = HE_T): { code: ReasonCode; label: string }[] {
  const labels = reasonLabels(t);
  return REASON_CODES.map((code) => ({ code, label: labels[code] }));
}
export const REASON_OPTIONS = reasonOptions();
export function notNowChoices(t: Translator = HE_T): { days: number; label: string }[] {
  return [
    { days: 3, label: t("insights.recommendations.notNow.threeDays") },
    { days: NOT_NOW_DEFAULT_DAYS, label: t("insights.recommendations.notNow.week") },
    { days: 30, label: t("insights.recommendations.notNow.month") },
  ].filter((c) => c.days <= NOT_NOW_MAX_DAYS);
}
export const NOT_NOW_CHOICES = notNowChoices();

const decisionLabel = (k: DecisionKind, t: Translator): string => t(`insights.recommendations.decision.${k}`);

/** InstallmentStatus: SCHEDULED is the only state an overdue installment is in (paid ones are not overdue). */
const statusLabel = (status: string, t: Translator): string | undefined =>
  status === "SCHEDULED" ? t("insights.recommendations.installmentStatus.SCHEDULED") : undefined;

const SOURCES = ["email", "whatsapp", "file", "upload", "camera", "scan", "other"] as const;
const sourceLabel = (k: string, t: Translator): string | undefined =>
  (SOURCES as readonly string[]).includes(k) ? t(`insights.recommendations.source.${k as (typeof SOURCES)[number]}`) : undefined;

const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });
export const heDate = (d: Date | string): string => dateFmt.format(typeof d === "string" ? new Date(d) : d);
/** Hebrew keeps its exact legacy formatter; other languages use the shared one (same day/month/year, business time zone). */
const dateFor = (locale: Locale) => (d: Date | string): string =>
  locale === "he" ? heDate(d) : formatDate(typeof d === "string" ? new Date(d) : d, { locale }, "date");
const daysFor = (t: Translator) => (n: number): string =>
  n === 1 ? t("insights.recommendations.daysOne") : n === 2 ? t("insights.recommendations.daysTwo") : t("insights.recommendations.daysMany", { n });
const docsFor = (t: Translator) => (n: number): string =>
  n === 1 ? t("insights.recommendations.docsOne") : t("insights.recommendations.docsMany", { n });

/** Where ACCEPT continues: the real domain flow, never a "done" button. */
export function handoffFor(row: Pick<OwnerRecommendationRow, "type" | "evidence" | "targets">, subset?: readonly number[] | null): string {
  if (row.type === "SETTLE_OVERDUE_INSTALLMENT") {
    const f = row.evidence.facts as OverdueInstallmentFacts;
    return `/payables/${f.commitmentId}?pay=${f.installmentId}`;
  }
  const first = (subset && subset.length > 0 ? [...subset] : [...row.targets]).sort((a, b) => a - b)[0];
  return first != null ? `/documents/review/${first}` : "/documents/inbox";
}

function installmentWhat(f: OverdueInstallmentFacts, title: string | null, t: Translator): string {
  return title
    ? t("insights.recommendations.installment.whatTitled", { sequence: f.sequence, title })
    : t("insights.recommendations.installment.what");
}

export function buildOwnerView(
  row: OwnerRecommendationRow,
  asOf: Date,
  t: Translator = HE_T,
  locale: Locale = "he"
): OwnerRecommendationView {
  const heDate = dateFor(locale);
  const days = daysFor(t);
  const docs = docsFor(t);
  const R = "insights.recommendations" as const;
  const ev = row.evidence;
  const d = row.decision;
  const capturedNote = ev.capturedAfterIssue
    ? t(`${R}.capturedAfterIssue`, { date: heDate(ev.capturedAt) })
    : t(`${R}.capturedAtIssue`, { date: heDate(ev.capturedAt) });

  let what: string, summary: string;
  const why: string[] = [];
  const lines: string[] = [];
  const selectable: { id: number; label: string }[] = [];
  const options: OwnerActionOption[] = [];

  if (row.type === "SETTLE_OVERDUE_INSTALLMENT") {
    const f = ev.facts as OverdueInstallmentFacts;
    const title = row.context.commitment?.title ?? null;
    what = installmentWhat(f, title, t);
    summary = t(`${R}.installment.summary`, { date: heDate(f.dueAt) });
    why.push(title
      ? t(`${R}.installment.whyOverdueTitled`, { sequence: f.sequence, title, days: days(f.daysOverdue) })
      : t(`${R}.installment.whyOverdue`, { sequence: f.sequence, days: days(f.daysOverdue) }));
    if (f.coverage === "PARTIAL") why.push(t(`${R}.installment.whyPartial`));
    why.push(t(`${R}.installment.whyOpenDebt`));
    lines.push(t(`${R}.installment.lineDue`, { sequence: f.sequence, date: heDate(f.dueAt) }));
    lines.push(t(`${R}.installment.lineLate`, { days: days(f.daysOverdue) }));
    const installmentStatus = statusLabel(f.installmentStatus, t) ?? t(`${R}.installmentStatus.SCHEDULED`);
    lines.push(f.coverage === "PARTIAL"
      ? t(`${R}.installment.lineStatusPartial`, { status: installmentStatus })
      : t(`${R}.installment.lineStatus`, { status: installmentStatus }));
    options.push({ decision: "ACCEPT", label: t(`${R}.installment.accept`), href: handoffFor(row) });
  } else {
    const f = ev.facts as ReviewBacklogFacts;
    what = t(`${R}.review.what`, { docs: docs(f.pendingCount) });
    summary = f.oldestWaitingDays > 0
      ? t(`${R}.review.summaryOldest`, { days: days(f.oldestWaitingDays) })
      : t(`${R}.review.summaryToday`);
    why.push(f.oldestWaitingDays > 0
      ? t(`${R}.review.whyWaitingOldest`, { docs: docs(f.pendingCount), days: days(f.oldestWaitingDays) })
      : t(`${R}.review.whyWaiting`, { docs: docs(f.pendingCount) }));
    why.push(t(`${R}.review.whyRecords`));
    lines.push(t(`${R}.review.linePending`, { docs: docs(f.pendingCount) }));
    const bySource = Object.entries(f.bySource).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => t(`${R}.review.lineSource`, { count: n, source: sourceLabel(k, t) ?? t(`${R}.source.other`) }));
    if (bySource.length > 0) lines.push(bySource.join(" · "));
    lines.push(f.oldestWaitingDays === f.newestWaitingDays
      ? t(`${R}.review.lineWaitingSame`, { days: days(f.oldestWaitingDays) })
      : t(`${R}.review.lineWaitingRange`, { from: days(f.newestWaitingDays), to: days(f.oldestWaitingDays) }));
    for (const doc of row.context.documents) {
      selectable.push({ id: doc.id, label: `${doc.originalFilename?.trim() || t(`${R}.review.documentFallback`, { date: heDate(doc.createdAt) })}` });
    }
    options.push({ decision: "ACCEPT", label: t(`${R}.review.accept`), href: handoffFor(row) });
    if (row.targets.length > 1) options.push({ decision: "MODIFY", label: t(`${R}.review.modify`), href: null });
  }
  options.push({ decision: "NOT_NOW", label: t(`${R}.options.notNow`), href: null });
  options.push({ decision: "REJECT", label: t(`${R}.options.reject`), href: null });

  /* ── after: decision, ledger, assessment — sequence only ── */
  const after: string[] = [];
  const performed = row.actions.filter((a) => a.eventType === "PERFORMED");
  const reversed = row.actions.filter((a) => a.eventType === "REVERSED");
  const withdrawn = row.actions.filter((a) => a.eventType === "WITHDRAWN");
  if (d) {
    const reason = d.reasonCode && (reasonLabels(t) as Record<string, string>)[d.reasonCode];
    if (d.decision === "REJECT") {
      after.push(reason
        ? t(`${R}.after.rejectedReason`, { date: heDate(d.decidedAt), reason })
        : t(`${R}.after.rejected`, { date: heDate(d.decidedAt) }));
    } else if (d.decision === "NOT_NOW") {
      after.push(t(`${R}.after.notNow`, { date: d.deferUntil ? heDate(d.deferUntil) : t(`${R}.after.laterDate`) }));
    } else {
      after.push(d.decision === "MODIFY" && d.targets
        ? t(`${R}.after.acceptedPart`, { date: heDate(d.decidedAt), docs: docs(d.targets.length) })
        : t(`${R}.after.accepted`, { date: heDate(d.decidedAt) }));
    }
  }
  if (row.type === "SETTLE_OVERDUE_INSTALLMENT") {
    const settled = row.observations.filter((o) => o.kind === "INSTALLMENT_SETTLED");
    const unsettled = row.observations.filter((o) => o.kind === "INSTALLMENT_SETTLEMENT_REVERSED");
    if (performed.length > 0) {
      const at = performed[performed.length - 1].occurredAt;
      after.push(d && (d.decision === "ACCEPT" || d.decision === "MODIFY")
        ? t(`${R}.after.paidAfterAction`, { date: heDate(at) })
        : t(`${R}.after.paidAfter`, { date: heDate(at) }));
    }
    if (settled.length > unsettled.length) {
      const s = settled[settled.length - 1];
      after.push(s.valueInt != null
        ? t(`${R}.after.coveredDays`, { days: days(Math.max(0, s.valueInt)) })
        : t(`${R}.after.covered`));
    }
    if (reversed.length > 0 || unsettled.length > 0) after.push(t(`${R}.after.reopened`));
    if (withdrawn.length > 0) after.push(t(`${R}.after.withdrawnInstallment`));
  } else {
    const f = ev.facts as ReviewBacklogFacts;
    const reviewed = new Set(performed.map((a) => a.targetId)).size;
    if (reviewed > 0) after.push(t(`${R}.after.reviewed`, { reviewed, docs: docs(row.targets.length) }));
    const end = row.observations.find((o) => o.kind === "REVIEW_BACKLOG_AT_WINDOW_END");
    if (end && end.valueInt != null) {
      after.push(t(`${R}.after.windowEnd`, { date: heDate(end.observedAt), docs: docs(end.valueInt), count: f.pendingCount }));
    }
    if (withdrawn.length > 0) after.push(t(`${R}.after.withdrawnDocs`, { docs: docs(new Set(withdrawn.map((a) => a.targetId)).size) }));
  }
  if (row.assessment?.actionState === "PRECEDED_RECOMMENDATION") after.push(t(`${R}.after.preceded`));
  if (row.assessment?.attribution === "OBSERVED_SEQUENCE") after.push(t(`${R}.after.sequenceOnly`));

  /* ── stage and status ── */
  const accepted = d && (d.decision === "ACCEPT" || d.decision === "MODIFY");
  const completed = row.assessment?.actionState === "COMPLETED" || row.assessment?.outcomeState === "OBSERVED";
  let stage: OwnerRecommendationView["stage"];
  let status: string;
  if (row.status === "ACTIVE" && !d) { stage = "waiting"; status = t(`${R}.status.waiting`, { date: heDate(row.validUntil) }); }
  else if (accepted && !completed && row.outcomeWindowEnd.getTime() > asOf.getTime() && row.status !== "SUPERSEDED") { stage = "in_progress"; status = t(`${R}.status.inProgress`); }
  else {
    stage = "closed";
    status = accepted && completed ? t(`${R}.status.done`)
      : d?.decision === "REJECT" ? t(`${R}.status.rejected`)
      : d?.decision === "NOT_NOW" ? t(`${R}.status.deferred`, { date: d.deferUntil ? heDate(d.deferUntil) : t(`${R}.after.laterDate`) })
      : row.status === "RESOLVED" ? t(`${R}.status.resolved`)
      : row.status === "EXPIRED" ? (accepted ? t(`${R}.status.windowEnded`) : t(`${R}.status.expired`))
      : row.status === "SUPERSEDED" ? t(`${R}.status.superseded`)
      : t(`${R}.status.ended`);
  }

  return {
    id: row.id, version: row.version, type: row.type, stage, what, summary, why,
    evidence: { lines, capturedAt: ev.capturedAt.toISOString(), capturedNote, intact: ev.intact },
    options, selectable, status, after,
    decidable: row.status === "ACTIVE",
    handoff: accepted ? handoffFor(row, d?.targets) : null,
    decision: d ? { decision: d.decision, label: decisionLabel(d.decision, t), at: d.decidedAt.toISOString() } : null,
    issuedAt: row.issuedAt.toISOString(),
    validUntil: row.validUntil.toISOString(),
  };
}

/** Owner-visible words that would claim a cause or credit Dubiz. The view never produces them. */
export const CAUSAL_PHRASES = ["בזכות", "הודות", "בגלל ההמלצה", "כתוצאה מההמלצה", "גרמה", "גרם ל", "Dubiz עזר", "חסכת", "הצלחת"] as const;
