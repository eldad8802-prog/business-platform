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

export const REASON_LABELS: Readonly<Record<ReasonCode, string>> = {
  ALREADY_HANDLED: "כבר טיפלתי בזה",
  NOT_RELEVANT: "לא רלוונטי לעסק",
  WRONG_TIMING: "לא הזמן המתאים",
  DISAGREE: "לא מסכים עם ההמלצה",
  WILL_HANDLE_DIFFERENTLY: "אטפל בזה בדרך אחרת",
};
export const REASON_OPTIONS = REASON_CODES.map((code) => ({ code, label: REASON_LABELS[code] }));
export const NOT_NOW_CHOICES = [
  { days: 3, label: "עוד 3 ימים" },
  { days: NOT_NOW_DEFAULT_DAYS, label: "עוד שבוע" },
  { days: 30, label: "עוד חודש" },
].filter((c) => c.days <= NOT_NOW_MAX_DAYS);

const DECISION_LABELS: Record<DecisionKind, string> = {
  ACCEPT: "אישרת",
  MODIFY: "אישרת חלק",
  REJECT: "דחית",
  NOT_NOW: "ביקשת לדחות",
};

/** InstallmentStatus: SCHEDULED is the only state an overdue installment is in (paid ones are not overdue). */
const STATUS_LABELS: Record<string, string> = { SCHEDULED: "פתוח" };

const SOURCE_LABELS: Record<string, string> = {
  email: "מהמייל", whatsapp: "מוואטסאפ", file: "מקובץ", upload: "מהעלאה", camera: "מצילום", scan: "מסריקה", other: "ממקור אחר",
};

const dateFmt = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" });
export const heDate = (d: Date | string): string => dateFmt.format(typeof d === "string" ? new Date(d) : d);
const days = (n: number): string => (n === 1 ? "יום אחד" : n === 2 ? "יומיים" : `${n} ימים`);
const docs = (n: number): string => (n === 1 ? "מסמך אחד" : `${n} מסמכים`);

/** Where ACCEPT continues: the real domain flow, never a "done" button. */
export function handoffFor(row: Pick<OwnerRecommendationRow, "type" | "evidence" | "targets">, subset?: readonly number[] | null): string {
  if (row.type === "SETTLE_OVERDUE_INSTALLMENT") {
    const f = row.evidence.facts as OverdueInstallmentFacts;
    return `/payables/${f.commitmentId}?pay=${f.installmentId}`;
  }
  const first = (subset && subset.length > 0 ? [...subset] : [...row.targets]).sort((a, b) => a - b)[0];
  return first != null ? `/documents/review/${first}` : "/documents/inbox";
}

function installmentWhat(f: OverdueInstallmentFacts, title: string | null): string {
  return title ? `לרשום את תשלום ${f.sequence} של „${title}”` : `לרשום תשלום שמועדו עבר`;
}

export function buildOwnerView(row: OwnerRecommendationRow, asOf: Date): OwnerRecommendationView {
  const ev = row.evidence;
  const d = row.decision;
  const capturedNote = ev.capturedAfterIssue
    ? `המידע נאסף ב־${heDate(ev.capturedAt)}, אחרי שההמלצה נוצרה, ומתאר את המצב באותו יום.`
    : `המידע נשמר ב־${heDate(ev.capturedAt)}, ברגע שההמלצה נוצרה.`;

  let what: string, summary: string;
  const why: string[] = [];
  const lines: string[] = [];
  const selectable: { id: number; label: string }[] = [];
  const options: OwnerActionOption[] = [];

  if (row.type === "SETTLE_OVERDUE_INSTALLMENT") {
    const f = ev.facts as OverdueInstallmentFacts;
    const title = row.context.commitment?.title ?? null;
    what = installmentWhat(f, title);
    summary = `המועד היה ${heDate(f.dueAt)}.`;
    why.push(`תשלום ${f.sequence}${title ? ` של „${title}”` : ""} לא נרשם כשולם, והמועד שלו עבר לפני ${days(f.daysOverdue)}.`);
    if (f.coverage === "PARTIAL") why.push("חלק ממנו כבר נרשם כשולם, אבל לא כולו.");
    why.push("כשתשלום כזה נשאר פתוח, הוא ממשיך להופיע כחוב פתוח בתמונת התשלומים של העסק.");
    lines.push(`תשלום ${f.sequence}, מועד ${heDate(f.dueAt)}`);
    lines.push(`${days(f.daysOverdue)} אחרי המועד`);
    lines.push(`מצב: ${STATUS_LABELS[f.installmentStatus] ?? "פתוח"}${f.coverage === "PARTIAL" ? " · שולם חלק" : ""}`);
    options.push({ decision: "ACCEPT", label: "לרישום התשלום", href: handoffFor(row) });
  } else {
    const f = ev.facts as ReviewBacklogFacts;
    what = `לעבור על ${docs(f.pendingCount)} שמחכים לבדיקה`;
    summary = f.oldestWaitingDays > 0 ? `הוותיק שבהם מחכה ${days(f.oldestWaitingDays)}.` : "כולם הגיעו היום.";
    why.push(`${docs(f.pendingCount)} מחכים לבדיקה שלך${f.oldestWaitingDays > 0 ? `, הוותיק שבהם כבר ${days(f.oldestWaitingDays)}` : ""}.`);
    why.push("מסמך נכנס לרשומות העסק רק אחרי שבודקים ומאשרים אותו.");
    lines.push(`${docs(f.pendingCount)} בהמתנה לבדיקה`);
    const bySource = Object.entries(f.bySource).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${n} ${SOURCE_LABELS[k] ?? SOURCE_LABELS.other}`);
    if (bySource.length > 0) lines.push(bySource.join(" · "));
    lines.push(f.oldestWaitingDays === f.newestWaitingDays ? `ממתינים ${days(f.oldestWaitingDays)}` : `ממתינים בין ${days(f.newestWaitingDays)} ל־${days(f.oldestWaitingDays)}`);
    for (const doc of row.context.documents) {
      selectable.push({ id: doc.id, label: `${doc.originalFilename?.trim() || `מסמך מ־${heDate(doc.createdAt)}`}` });
    }
    options.push({ decision: "ACCEPT", label: "לבדיקת המסמכים", href: handoffFor(row) });
    if (row.targets.length > 1) options.push({ decision: "MODIFY", label: "רק חלק מהם", href: null });
  }
  options.push({ decision: "NOT_NOW", label: "לא עכשיו", href: null });
  options.push({ decision: "REJECT", label: "לא רלוונטי", href: null });

  /* ── after: decision, ledger, assessment — sequence only ── */
  const after: string[] = [];
  const performed = row.actions.filter((a) => a.eventType === "PERFORMED");
  const reversed = row.actions.filter((a) => a.eventType === "REVERSED");
  const withdrawn = row.actions.filter((a) => a.eventType === "WITHDRAWN");
  if (d) {
    const reason = d.reasonCode && (REASON_LABELS as Record<string, string>)[d.reasonCode];
    if (d.decision === "REJECT") {
      after.push(`דחית את ההמלצה ב־${heDate(d.decidedAt)}${reason ? ` (${reason})` : ""}. Dubiz לא יציע אותה שוב, אלא אם המצב ישתנה באופן מהותי.`);
    } else if (d.decision === "NOT_NOW") {
      after.push(`ביקשת לחזור לזה אחרי ${d.deferUntil ? heDate(d.deferUntil) : "מועד מאוחר יותר"}. עד אז Dubiz לא יציע את זה שוב, אלא אם המצב ישתנה באופן מהותי.`);
    } else {
      const part = d.decision === "MODIFY" && d.targets ? ` (${docs(d.targets.length)})` : "";
      after.push(`אישרת ב־${heDate(d.decidedAt)}${part}. Dubiz לא יזכיר את זה שוב בזמן שהטיפול נמשך.`);
    }
  }
  if (row.type === "SETTLE_OVERDUE_INSTALLMENT") {
    const settled = row.observations.filter((o) => o.kind === "INSTALLMENT_SETTLED");
    const unsettled = row.observations.filter((o) => o.kind === "INSTALLMENT_SETTLEMENT_REVERSED");
    if (performed.length > 0) {
      const at = performed[performed.length - 1].occurredAt;
      after.push(d && (d.decision === "ACCEPT" || d.decision === "MODIFY")
        ? `לאחר ההמלצה והפעולה, התשלום נרשם (תאריך תשלום ${heDate(at)}).`
        : `לאחר ההמלצה, נרשם תשלום (תאריך תשלום ${heDate(at)}).`);
    }
    if (settled.length > unsettled.length) {
      const s = settled[settled.length - 1];
      after.push(s.valueInt != null ? `התשלום כוסה במלואו, ${days(Math.max(0, s.valueInt))} אחרי המועד.` : "התשלום כוסה במלואו.");
    }
    if (reversed.length > 0 || unsettled.length > 0) after.push("אחר כך התשלום בוטל או שויך מחדש, ולכן הוא שוב פתוח.");
    if (withdrawn.length > 0) after.push("התשלום בוטל בהתחייבות, ולכן ההמלצה כבר לא חלה עליו.");
  } else {
    const f = ev.facts as ReviewBacklogFacts;
    const reviewed = new Set(performed.map((a) => a.targetId)).size;
    if (reviewed > 0) after.push(`לאחר ההמלצה, נבדקו ${reviewed} מתוך ${docs(row.targets.length)}.`);
    const end = row.observations.find((o) => o.kind === "REVIEW_BACKLOG_AT_WINDOW_END");
    if (end && end.valueInt != null) {
      after.push(`ב־${heDate(end.observedAt)} חיכו לבדיקה ${docs(end.valueInt)}, לעומת ${f.pendingCount} כשההמלצה נוצרה.`);
    }
    if (withdrawn.length > 0) after.push(`${docs(new Set(withdrawn.map((a) => a.targetId)).size)} יצאו מתור הבדיקה בלי בדיקה (נמחקו או נכשלו).`);
  }
  if (row.assessment?.actionState === "PRECEDED_RECOMMENDATION") after.push("הפעולה נרשמה עוד לפני שההמלצה נוצרה.");
  if (row.assessment?.attribution === "OBSERVED_SEQUENCE") after.push("כל זה מתאר את סדר הדברים בזמן בלבד.");

  /* ── stage and status ── */
  const accepted = d && (d.decision === "ACCEPT" || d.decision === "MODIFY");
  const completed = row.assessment?.actionState === "COMPLETED" || row.assessment?.outcomeState === "OBSERVED";
  let stage: OwnerRecommendationView["stage"];
  let status: string;
  if (row.status === "ACTIVE" && !d) { stage = "waiting"; status = `מחכה להחלטה שלך · בתוקף עד ${heDate(row.validUntil)}`; }
  else if (accepted && !completed && row.outcomeWindowEnd.getTime() > asOf.getTime() && row.status !== "SUPERSEDED") { stage = "in_progress"; status = "בטיפול"; }
  else {
    stage = "closed";
    status = accepted && completed ? "טופל"
      : d?.decision === "REJECT" ? "נדחה"
      : d?.decision === "NOT_NOW" ? `נדחה ל־${d.deferUntil ? heDate(d.deferUntil) : "מועד מאוחר יותר"}`
      : row.status === "RESOLVED" ? "המצב השתנה וההמלצה כבר לא נדרשת"
      : row.status === "EXPIRED" ? (accepted ? "תקופת המעקב הסתיימה" : "פג תוקף בלי החלטה")
      : row.status === "SUPERSEDED" ? "הוחלפה בהמלצה עדכנית"
      : "הסתיים";
  }

  return {
    id: row.id, version: row.version, type: row.type, stage, what, summary, why,
    evidence: { lines, capturedAt: ev.capturedAt.toISOString(), capturedNote, intact: ev.intact },
    options, selectable, status, after,
    decidable: row.status === "ACTIVE",
    handoff: accepted ? handoffFor(row, d?.targets) : null,
    decision: d ? { decision: d.decision, label: DECISION_LABELS[d.decision], at: d.decidedAt.toISOString() } : null,
    issuedAt: row.issuedAt.toISOString(),
    validUntil: row.validUntil.toISOString(),
  };
}

/** Owner-visible words that would claim a cause or credit Dubiz. The view never produces them. */
export const CAUSAL_PHRASES = ["בזכות", "הודות", "בגלל ההמלצה", "כתוצאה מההמלצה", "גרמה", "גרם ל", "Dubiz עזר", "חסכת", "הצלחת"] as const;
