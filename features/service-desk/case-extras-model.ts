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
  return { recorded: Object.keys(results).filter((k) => items.some((i) => i.key === k)).length, total: items.length, missing, failed, complete: missing === 0 && requiredFailed === 0 };
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
export const offerableQuoteDocs = <T extends QuoteDocRow>(docs: readonly T[], alreadySent: readonly number[]) =>
  docs.filter((d) => !d.converted && d.status !== "CANCELLED" && d.status !== "VOID" && !alreadySent.includes(d.id));

/** The quote step is open while diagnosing / repairing (send) or while a sent quote waits (revise). */
export function quoteMode(status: string): "send" | "revise" | null {
  if (status === "DIAGNOSING" || status === "IN_REPAIR") return "send";
  if (status === "QUOTE_PENDING") return "revise";
  return null;
}
