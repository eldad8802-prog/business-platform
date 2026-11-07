/**
 * ר1 — what the manual record of a quote amounts to. Pure: no DB, no clock (the caller passes "today").
 *
 * Every rule here is about the OWNER'S OWN RECORD — never about delivery, reading or the customer's actual answer.
 *
 *   in force      an event that no CORRECTION points at.
 *   response      the latest in-force RESPONSE_ACCEPTED / RESPONSE_DECLINED recorded on the CURRENT version of the
 *                 quote (same quoteContentHash). A NOTE is never a response. A response on an older version is
 *                 shown as history and decides nothing.
 *   sent          the latest in-force MARKED_SENT on the current version.
 *
 *   S08 (validity ends)     closed by an in-force response on the current version (and, as before, by conversion,
 *                           a moved date or "not relevant").
 *   S09 (no reply recorded) due QUOTE_FOLLOWUP_DAYS after the latest in-force MARKED_SENT on the current version,
 *                           while there is no in-force response on it; a newer MARKED_SENT restarts the count.
 */
export const QUOTE_FOLLOWUP_DAYS = 3;

export type ShareEventKind = "DOWNLOADED" | "SHARE_SHEET_OPENED" | "MARKED_SENT" | "RESPONSE_ACCEPTED" | "RESPONSE_DECLINED" | "NOTE" | "CORRECTION";
export const SHARE_EVENT_KINDS: readonly ShareEventKind[] = ["DOWNLOADED", "SHARE_SHEET_OPENED", "MARKED_SENT", "RESPONSE_ACCEPTED", "RESPONSE_DECLINED", "NOTE", "CORRECTION"];
export const CORRECTABLE_KINDS: ReadonlySet<ShareEventKind> = new Set(["MARKED_SENT", "RESPONSE_ACCEPTED", "RESPONSE_DECLINED"]);
export const COPY_EVENT_KINDS: ReadonlySet<ShareEventKind> = new Set(["DOWNLOADED", "SHARE_SHEET_OPENED", "MARKED_SENT"]);

export type ShareEventRow = {
  id: number;
  kind: ShareEventKind;
  copyId: number | null;
  correctsEventId: number | null;
  quoteContentHash: string;
  createdAt: Date;
};

export type ShareState = {
  response: { kind: "ACCEPTED" | "DECLINED"; eventId: number; at: Date } | null;
  sent: { eventId: number; at: Date; copyId: number | null } | null;
  correctedIds: Set<number>;
  /** in-force responses recorded on an older version of the quote */
  staleResponses: number;
};

const newest = (a: ShareEventRow, b: ShareEventRow) => (a.createdAt.getTime() === b.createdAt.getTime() ? b.id - a.id : b.createdAt.getTime() - a.createdAt.getTime());

export function deriveShareState(events: readonly ShareEventRow[], currentHash: string): ShareState {
  const correctedIds = new Set(events.filter((e) => e.kind === "CORRECTION" && e.correctsEventId !== null).map((e) => e.correctsEventId as number));
  const inForce = events.filter((e) => e.kind !== "CORRECTION" && !correctedIds.has(e.id)).sort(newest);
  const responses = inForce.filter((e) => e.kind === "RESPONSE_ACCEPTED" || e.kind === "RESPONSE_DECLINED");
  const current = responses.find((e) => e.quoteContentHash === currentHash) ?? null;
  const sent = inForce.find((e) => e.kind === "MARKED_SENT" && e.quoteContentHash === currentHash) ?? null;
  return {
    response: current ? { kind: current.kind === "RESPONSE_ACCEPTED" ? "ACCEPTED" : "DECLINED", eventId: current.id, at: current.createdAt } : null,
    sent: sent ? { eventId: sent.id, at: sent.createdAt, copyId: sent.copyId } : null,
    correctedIds,
    staleResponses: responses.filter((e) => e.quoteContentHash !== currentHash).length,
  };
}

/** S08: does the owner's record close the validity reminder? */
export function closesValidityReminder(state: ShareState): boolean {
  return state.response !== null;
}

/** S09: whole Israel days between the sent day and today ≥ QUOTE_FOLLOWUP_DAYS, and no response on this version. */
export function followUpDue(state: ShareState, sentDayToToday: number | null): boolean {
  if (!state.sent || state.response) return false;
  return sentDayToToday !== null && sentDayToToday >= QUOTE_FOLLOWUP_DAYS;
}

export type ShareEventInput = {
  kind: ShareEventKind;
  copyId: number | null;
  channel: "WHATSAPP" | "EMAIL" | "PRINT" | "OTHER" | null;
  note: string | null;
  correctsEventId: number | null;
};

export class ShareEventValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "ShareEventValidationError";
  }
}

const CHANNELS = new Set(["WHATSAPP", "EMAIL", "PRINT", "OTHER"]);
const positiveInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/** The event body, as the database will accept it — or a Hebrew reason. */
export function parseShareEventInput(raw: Record<string, unknown>): ShareEventInput {
  const kind = raw.kind;
  if (typeof kind !== "string" || !(SHARE_EVENT_KINDS as readonly string[]).includes(kind)) throw new ShareEventValidationError("kind", "סוג רישום לא מוכר");
  const k = kind as ShareEventKind;
  const copyId = raw.copyId === undefined || raw.copyId === null ? null : positiveInt(raw.copyId);
  if (raw.copyId !== undefined && raw.copyId !== null && copyId === null) throw new ShareEventValidationError("copyId", "עותק לא תקין");
  if (COPY_EVENT_KINDS.has(k) !== (copyId !== null)) throw new ShareEventValidationError("copyId", COPY_EVENT_KINDS.has(k) ? "הרישום חייב להתייחס לעותק שנשמר" : "רישום זה אינו מתייחס לעותק");
  const channel = raw.channel === undefined || raw.channel === null ? null : String(raw.channel);
  if (channel !== null && (!CHANNELS.has(channel) || k !== "MARKED_SENT")) throw new ShareEventValidationError("channel", "ערוץ לא תקין");
  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string") throw new ShareEventValidationError("note", "הערה לא תקינה");
    note = raw.note.replace(/\r\n?/g, "\n").trim() || null;
    // eslint-disable-next-line no-control-regex
    if (note && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) throw new ShareEventValidationError("note", "ההערה מכילה תווים לא חוקיים");
    if (note && [...note].length > 2000) throw new ShareEventValidationError("note", "עד 2,000 תווים");
  }
  if (k === "NOTE" && !note) throw new ShareEventValidationError("note", "יש לכתוב הערה");
  const correctsEventId = raw.correctsEventId === undefined || raw.correctsEventId === null ? null : positiveInt(raw.correctsEventId);
  if ((k === "CORRECTION") !== (correctsEventId !== null)) throw new ShareEventValidationError("correctsEventId", k === "CORRECTION" ? "יש לבחור רישום לתיקון" : "רישום זה אינו תיקון");
  return { kind: k, copyId, channel: channel as ShareEventInput["channel"], note, correctsEventId };
}
