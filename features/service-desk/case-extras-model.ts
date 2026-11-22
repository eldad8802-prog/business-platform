/**
 * Service Desk UI 1.3 — pure helpers for the case panels (QA, quote, pickup calls, loans). The server stays the
 * authority; these only shape what the screen shows and sends.
 */
export type QaItem = { key: string; label: string; required: boolean };
export type QaResults = Record<string, "PASS" | "FAIL">;

/** What the checklist still needs before it counts as done (the server's rule, shown before sending). */
export function qaProgress(items: readonly QaItem[], results: QaResults, everyCheckRecorded: boolean) {
  const mustRecord = items.filter((i) => i.required || everyCheckRecorded);
  const missing = mustRecord.filter((i) => results[i.key] === undefined).length;
  const requiredFailed = items.filter((i) => i.required && results[i.key] === "FAIL").length;
  const failed = items.filter((i) => results[i.key] === "FAIL").length;
  return { recorded: Object.keys(results).filter((k) => items.some((i) => i.key === k)).length, total: items.length, missing, failed, requiredFailed, complete: missing === 0 && failed === 0 };
}

/**
 * Why "the checks passed" cannot be confirmed now — the server's rule (owner 2026-11-21: no failed check, nothing that
 * must be recorded missing), with the checks named — or null when it can. Judged on what the SERVER holds (the saved
 * results); unsaved changes in the panel are named too, because PASS_QA reads only what was saved.
 */
export function qaPassBlocker(qa: { template: { items: readonly QaItem[]; everyCheckRecorded: boolean } | null; results: QaResults; completed: boolean } | null, draft?: QaResults): string | null {
  if (!qa || !qa.template) return null;
  const items = qa.template.items;
  const failed = items.filter((i) => qa.results[i.key] === "FAIL").map((i) => i.label);
  const missing = items.filter((i) => (i.required || qa.template!.everyCheckRecorded) && qa.results[i.key] === undefined).map((i) => i.label);
  const unsaved = draft !== undefined && items.some((i) => (draft[i.key] ?? null) !== (qa.results[i.key] ?? null));
  if (failed.length) return `לא ניתן לאשר שהבדיקות עברו: ${failed.length === 1 ? `הבדיקה "${failed[0]}" לא עברה` : `${failed.length} בדיקות לא עברו (${failed.join(", ")})`}. מחזירים לעבודה, ואחרי התיקון בודקים שוב.`;
  if (missing.length) return `לפני האישור צריך לרשום את כל הבדיקות. חסרות: ${missing.join(", ")}.`;
  if (unsaved) return "יש שינויים בבדיקות שעוד לא נשמרו. שומרים ואז מאשרים.";
  if (!qa.completed) return "הבדיקות עוד לא הושלמו.";
  return null;
}

/** Only known keys with PASS / FAIL are sent (the server refuses anything else). */
export function qaBody(items: readonly QaItem[], results: QaResults): QaResults {
  const out: QaResults = {};
  for (const i of items) if (results[i.key] === "PASS" || results[i.key] === "FAIL") out[i.key] = results[i.key];
  return out;
}

export const PICKUP_OUTCOME_TEXT = { REACHED: "דיברנו עם הלקוח", LEFT_MESSAGE: "השארנו הודעה", NO_ANSWER: "אין מענה" } as const;

/** The pickup line for the case header: how many documented calls and the last one. */
export function pickupSummary(calls: readonly { calledAt: string; outcome: keyof typeof PICKUP_OUTCOME_TEXT }[], now: Date): string | null {
  if (!calls.length) return null;
  const last = [...calls].sort((a, b) => Date.parse(b.calledAt) - Date.parse(a.calledAt))[0];
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(last.calledAt)) / 864e5));
  const when = days === 0 ? "היום" : days === 1 ? "אתמול" : `לפני ${days} ימים`;
  return `${calls.length === 1 ? "תזכורת אחת" : `${calls.length} תזכורות`} · אחרונה ${when}: ${PICKUP_OUTCOME_TEXT[last.outcome]}`;
}

export type LoanRow = { id: number; itemName: string; returnedAt: string | null };
export const openLoans = (loans: readonly LoanRow[]) => loans.filter((l) => l.returnedAt === null);

/** Decision 5: a reminder at handover, never a block. */
export function loanReminder(loans: readonly LoanRow[], status: string): string | null {
  const open = openLoans(loans);
  if (!open.length || !["READY", "WORK_DONE", "QA"].includes(status)) return null;
  return open.length === 1 ? `לפני המסירה: לקבל בחזרה את ${open[0].itemName}` : `לפני המסירה: לקבל בחזרה ${open.length} פריטים חלופיים`;
}

export type QuoteDocRow = { id: number; status: string; converted: boolean };
/** Quote documents worth offering: not converted to an invoice, not cancelled. The server checks the rest. */
export const offerableQuoteDocs = <T extends QuoteDocRow>(docs: readonly T[], alreadySent: readonly number[], onOtherCases: readonly number[] = []) =>
  docs.filter((d) => !d.converted && d.status !== "CANCELLED" && d.status !== "VOID" && !alreadySent.includes(d.id) && !onOtherCases.includes(d.id));

/**
 * The SERVICE status of a quote version on this case (ServiceQuote.state) — the customer's answer as the owner recorded
 * it. It is not the billing document's status: a billing QUOTE is never issued (it stays a draft in billing by design),
 * so the case and billing answer two different questions. The screen names both, never one for the other.
 */
export const QUOTE_STATE_TEXT: Readonly<Record<string, string>> = {
  SENT: "ממתינה לתשובת הלקוח",
  APPROVED: "הלקוח אישר",
  REJECTED: "הלקוח דחה",
  WITHDRAWN: "בוטלה",
  SUPERSEDED: "הוחלפה בהצעה מעודכנת",
};

/** The billing document's own status, in billing's words (for the line under a quote). */
export function billingStatusText(status: string): string {
  return status === "DRAFT" ? "טיוטה במסמכים" : status === "ISSUED" ? "הופק במסמכים" : status === "PENDING_REVIEW" ? "ממתין לבדיקה במסמכים" : status;
}

/** A billing document's name on screen: its number when billing gave it one, else its type and that it has no number yet. */
export function docName(kind: string, number: string | null): string {
  return number ? `${kind} ${number}` : `${kind} (טרם קיבלה מספר)`;
}

export const ils = (agorot: number) => `₪${(agorot / 100).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Shekels typed by the owner → integer agorot, or null when it is not a positive amount with at most 2 decimals. */
export function parseShekels(raw: string): number | null {
  const t = raw.trim().replace(/[₪,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const agorot = Math.round(Number(t) * 100);
  return agorot > 0 && Number.isSafeInteger(agorot) ? agorot : null;
}

export type BalanceLike = { state: string; openBalanceAgorot: number | null; reason?: string; detail?: { chargeAgorot: number | null; overpaidAgorot: number } };

/**
 * What the case's balance means for the handover, in one honest sentence, and whether the handover is blocked.
 * UNKNOWN blocks (the server refuses — never bypassed, never invented); an open debt needs the owner's reason at the
 * handover; settled / no charge hand over freely.
 */
export function chargeSummary(b: BalanceLike | null): { text: string; blocksHandover: boolean; needsDebtReason: boolean } {
  if (!b) return { text: "לא הצלחנו לקרוא את מצב החיוב. רעננו לפני המסירה.", blocksHandover: true, needsDebtReason: false };
  switch (b.state) {
    case "NO_CHARGE": return { text: "נקבע: ללא חיוב.", blocksHandover: false, needsDebtReason: false };
    case "SETTLED":
      return { text: b.detail?.overpaidAgorot ? `שולם במלואו (שולם ביתר ${ils(b.detail.overpaidAgorot)}).` : "שולם במלואו.", blocksHandover: false, needsDebtReason: false };
    case "OPEN":
      return { text: `יתרה פתוחה: ${ils(b.openBalanceAgorot ?? 0)} (מתועדת בחשבונית). מסירה עם יתרה רק באישור בעל העסק ועם סיבה.`, blocksHandover: false, needsDebtReason: true };
    case "CHARGE_NOT_DOCUMENTED":
      return { text: `חיוב של ${ils(b.detail?.chargeAgorot ?? b.openBalanceAgorot ?? 0)}, ועוד לא קושר לו מסמך תשלום. אפשר לקשר חשבונית או קבלה שהופקו, או למסור עם יתרה פתוחה באישור בעל העסק ועם סיבה.`, blocksHandover: false, needsDebtReason: (b.openBalanceAgorot ?? 0) > 0 };
    default: {
      const why = b.reason === "NO_CHARGE_DECISION" || b.reason === "NOT_LINKED" ? "עוד לא נקבע חיוב לתיק."
        : b.reason === "DRAFT_PENDING" ? "אחד המסמכים המקושרים עדיין טיוטה."
        : b.reason === "FOREIGN_CURRENCY" ? "מסמך מקושר אינו בשקלים."
        : b.reason === "CONFLICT" ? "המסמכים המקושרים לא תואמים את החיוב שנקבע."
        : "לא הצלחנו לחשב את היתרה.";
      return { text: `${why} לפני המסירה צריך לקבוע חיוב (סכום או "ללא חיוב").`, blocksHandover: true, needsDebtReason: false };
    }
  }
}

/** The quote step is open while diagnosing / repairing (send) or while a sent quote waits (revise). */
export function quoteMode(status: string): "send" | "revise" | null {
  if (status === "DIAGNOSING" || status === "IN_REPAIR") return "send";
  if (status === "QUOTE_PENDING") return "revise";
  return null;
}
