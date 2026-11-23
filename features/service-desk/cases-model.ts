/**
 * Service Desk UI 1.3 — the cases list and the case screen: pure view model (no React, no network, no clock of its own).
 *
 * Owner-approved behaviour (repairs vs service spec, 2026-11-19):
 *   - the entry screen IS the list: search, a few filters, a clean list; no separate dashboard;
 *   - "needs attention" first, with an EXPLAINED reason, never an arbitrary score;
 *   - the case screen leads with the status and the next action; sections that need attention open by themselves;
 *   - wording follows the activity (a repair case vs a service call), not one lab vocabulary for everyone.
 * Hebrew only. Every function here is deterministic: `now` is passed in.
 */

export type CaseStatus =
  | "OPEN" | "SCHEDULED" | "CHECKED_IN" | "DIAGNOSING" | "QUOTE_PENDING" | "IN_REPAIR" | "EXTERNAL" | "QA" | "READY"
  | "DELIVERED" | "CLOSED" | "CANCELLED" | "ABANDONED" | "WORK_DONE";

export type CaseKind = "IN_SHOP" | "FIELD" | "REMOTE" | string;

/** The list row as the server returns it (GET /api/service-desk/cases). */
export type CaseRowData = {
  id: number;
  caseNumber: number;
  /** Optimistic concurrency: every write sends the version it saw. */
  version?: number;
  kind: CaseKind;
  status: CaseStatus;
  holdReason: string | null;
  customerId?: number;
  customerName: string | null;
  problemExcerpt?: string | null;
  subjectName?: string | null;
  workType?: string | null;
  openedAt: string;
  updatedAt: string;
  /** When the case entered its current state (the list API; absent elsewhere — the last update is used then). */
  statusSince?: string;
};

/**
 * The status colour family (owner-approved palette, 2026-11-24 — no green in the module): new = neutral, active = blue
 * (work in progress), attention = amber (waiting), ready / done = light bordeaux with a check (positive, completed),
 * danger = red (cancelled / not collected). Every tone is also carried by the status words, never by colour alone.
 */
export type Tone = "new" | "active" | "attention" | "ready" | "done" | "danger";

const STATUS_LABEL: Readonly<Record<CaseStatus, string>> = {
  OPEN: "נפתח",
  SCHEDULED: "מתואם",
  CHECKED_IN: "התקבל",
  DIAGNOSING: "באבחון",
  QUOTE_PENDING: "ממתין לאישור הצעה",
  IN_REPAIR: "בעבודה",
  EXTERNAL: "אצל ספק",
  QA: "בבדיקה",
  READY: "מוכן למסירה",
  DELIVERED: "נמסר",
  CLOSED: "נסגר",
  CANCELLED: "בוטל",
  ABANDONED: "לא נאסף",
  WORK_DONE: "העבודה הסתיימה",
};

const HOLD_LABEL: Readonly<Record<string, string>> = {
  PARTS: "ממתין לחלקים",
  CUSTOMER: "ממתין ללקוח",
};

export function statusLabel(status: CaseStatus): string {
  return STATUS_LABEL[status] ?? "בטיפול";
}

export const CLOSED_STATUSES: readonly CaseStatus[] = ["DELIVERED", "CLOSED", "CANCELLED", "ABANDONED"];

export function isClosed(status: CaseStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

export function statusTone(status: CaseStatus, holdReason: string | null = null): Tone {
  if (status === "CANCELLED" || status === "ABANDONED") return "danger";
  if (isClosed(status)) return "done";
  if (status === "READY" || status === "WORK_DONE") return "ready";
  if (status === "QUOTE_PENDING" || holdReason) return "attention";
  if (status === "OPEN" || status === "SCHEDULED" || status === "CHECKED_IN") return "new";
  return "active";
}

/** A service call (on site / remote) speaks of a "קריאה"; a repair at the business of a "תיק". */
export function caseNoun(kind: CaseKind): "תיק" | "קריאה" {
  return kind === "FIELD" || kind === "REMOTE" ? "קריאה" : "תיק";
}

const DAY = 24 * 60 * 60 * 1000;

function daysBetween(fromIso: string, now: Date): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

function daysText(n: number): string {
  if (n <= 0) return "היום";
  if (n === 1) return "מאתמול";
  if (n === 2) return "יומיים";
  return `${n} ימים`;
}

/**
 * «ממתינים לך» (owner decision 2026-11-24): a case waits for the business only when the next step is the business's and
 * it is overdue, or a finished call must be closed now. Existing statuses only; no score. The days count from when the
 * case entered its current state (statusSince), not from the last update — a note or a location never resets them.
 *   WORK_DONE immediately · READY ≥ 2 days · QUOTE_PENDING ≥ 3 · on hold ≥ 3 · EXTERNAL ≥ 7 · QA / CHECKED_IN / OPEN ≥ 1.
 * Everything else (diagnosis, work in progress, scheduled, closed, or below its threshold) is not waiting.
 */
export const WAITING_THRESHOLD_DAYS = { READY: 2, QUOTE_PENDING: 3, HOLD: 3, EXTERNAL: 7, QA: 1, CHECKED_IN: 1, OPEN: 1 } as const;

/** Days the case has been in its current state. */
export function waitingDays(c: Pick<CaseRowData, "statusSince" | "updatedAt">, now: Date): number {
  return daysBetween(c.statusSince ?? c.updatedAt, now);
}

/** The explained reason a case waits for the business now — or null (it is not in «ממתינים לך»). */
export function attentionReason(c: Pick<CaseRowData, "status" | "holdReason" | "updatedAt" | "kind" | "statusSince">, now: Date): string | null {
  const n = waitingDays(c, now);
  const T = WAITING_THRESHOLD_DAYS;
  const field = c.kind === "FIELD" || c.kind === "REMOTE";
  switch (c.status) {
    case "WORK_DONE": return "העבודה הסתיימה — לקבוע חיוב ולסגור את הקריאה";
    case "READY": return n >= T.READY ? `מוכן ולא נאסף · ${daysText(n)} — להתקשר ללקוח` : null;
    case "QUOTE_PENDING": return n >= T.QUOTE_PENDING ? `הצעה בלי תשובה · ${daysText(n)} — להתקשר ללקוח` : null;
    case "EXTERNAL": return n >= T.EXTERNAL ? `אצל ספק · ${daysText(n)} — לבדוק מול הספק` : null;
    case "QA": return n >= T.QA ? `בבדיקות · ${daysText(n)} — לסיים את הבדיקות` : null;
    case "CHECKED_IN": return n >= T.CHECKED_IN ? `ממתין לאבחון · ${daysText(n)}` : null;
    case "OPEN": return n >= T.OPEN ? (field ? `לא תואם · ${daysText(n)}` : `לא נקלט · ${daysText(n)}`) : null;
    default:
      if (c.holdReason) return n >= T.HOLD ? `${HOLD_LABEL[c.holdReason] ?? "בהמתנה"} · ${daysText(n)} — לבדוק` : null;
      return null;
  }
}

/** The next step of a case that is not waiting, as one short grey line in the list (nothing disappears from view). */
export function nextStepHint(c: Pick<CaseRowData, "status" | "holdReason" | "kind">): string | null {
  const field = c.kind === "FIELD" || c.kind === "REMOTE";
  if (c.holdReason) return "הבא: להחזיר לעבודה";
  switch (c.status) {
    case "OPEN": return field ? "הבא: לתאם ולהתחיל" : "הבא: לקלוט את הפריט";
    case "SCHEDULED": return "הבא: הביקור";
    case "CHECKED_IN": return "הבא: להתחיל אבחון";
    case "DIAGNOSING": return "הבא: לתקן או לשלוח הצעה";
    case "QUOTE_PENDING": return "הבא: תשובת הלקוח להצעה";
    case "IN_REPAIR": return field ? "הבא: לסיים את העבודה" : "הבא: לסיים את התיקון";
    case "EXTERNAL": return "הבא: לקבל מהספק";
    case "QA": return "הבא: לסמן את הבדיקות";
    case "READY": return "הבא: למסור ללקוח";
    case "WORK_DONE": return "הבא: לסגור את הקריאה";
    default: return null;
  }
}

/** The next step the owner takes, in plain words, for the case screen's top card. */
export type NextActionContext = {
  /** The intake has its condition and accessories recorded: what is left is the owner's confirmation. */
  intakeReady?: boolean;
  /** READY / WORK_DONE with no charge decided yet: the handover waits for it. */
  chargeMissing?: boolean;
  /** QA: the saved checklist has a failed check (the case goes back to work). */
  qaFailed?: boolean;
};

/**
 * The next step the owner takes, in plain words, for the case screen's top card. A step already done is never named
 * as the next one: a recorded intake asks for its confirmation, not for the intake again (pilot review 2026-11-21).
 */
export function nextActionLabel(status: CaseStatus, kind: CaseKind, holdReason: string | null = null, ctx: NextActionContext = {}): string | null {
  if (status === "IN_REPAIR" && holdReason === "PARTS") return "כשהחלקים מגיעים — להחזיר לעבודה";
  if (status === "IN_REPAIR" && holdReason) return "כשהלקוח חוזר — להחזיר לעבודה";
  const field = kind === "FIELD" || kind === "REMOTE";
  switch (status) {
    case "OPEN": return field ? "לתאם ביקור" : ctx.intakeReady ? "לאשר את הקליטה" : "לקלוט את הפריט";
    case "SCHEDULED": return "להתחיל את הביקור";
    case "CHECKED_IN": return "להתחיל אבחון";
    case "DIAGNOSING": return "להחליט: לתקן או לשלוח הצעת מחיר";
    case "QUOTE_PENDING": return "לרשום את תשובת הלקוח להצעה";
    case "IN_REPAIR": return field ? "לסיים את העבודה" : "לסיים את התיקון";
    case "EXTERNAL": return "לרשום חזרה מהספק";
    case "QA": return ctx.qaFailed ? "בדיקה לא עברה — להחזיר לעבודה" : "להשלים את הבדיקות";
    case "READY": return ctx.chargeMissing ? "לקבוע חיוב ואז למסור ללקוח" : "למסור ללקוח";
    case "WORK_DONE": return ctx.chargeMissing ? "לקבוע חיוב ואז לסגור את הקריאה" : "לסגור את הקריאה";
    default: return null;
  }
}

export type ListFilter = "all" | "attention" | "active" | "ready" | "closed";

/** Three filters (owner decision 2026-11-24): the active cases (with «ממתינים לך» first), ready, closed. */
export const LIST_FILTERS: readonly { key: ListFilter; label: string }[] = [
  { key: "all", label: "פעילים" },
  { key: "ready", label: "מוכנים" },
  { key: "closed", label: "סגורים" },
];

function matchesFilter(c: CaseRowData, f: ListFilter, now: Date): boolean {
  switch (f) {
    case "all": return true;
    case "attention": return attentionReason(c, now) !== null;
    case "active": return !isClosed(c.status) && c.status !== "READY" && c.status !== "WORK_DONE";
    case "ready": return c.status === "READY" || c.status === "WORK_DONE";
    case "closed": return isClosed(c.status);
  }
}

function normalise(s: string): string {
  return s.normalize("NFC").replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Search: case number (with or without "#"), customer, subject or problem text. */
export function matchesQuery(c: CaseRowData, query: string): boolean {
  const q = normalise(query).replace(/^#/, "");
  if (!q) return true;
  if (/^\d+$/.test(q) && String(c.caseNumber).includes(q)) return true;
  const hay = normalise([c.customerName, c.subjectName, c.problemExcerpt].filter(Boolean).join(" "));
  return hay.includes(q);
}

export type ListSections = {
  attention: { row: CaseRowData; reason: string }[];
  rest: CaseRowData[];
  total: number;
  shown: number;
};

/**
 * The list as shown: filtered and searched; with the "all" filter, cases that need attention come first in their own
 * group (each with its reason), the rest by last update. Closed cases are only shown under "סגורים" or a search.
 */
export function buildListSections(rows: readonly CaseRowData[], opts: { filter: ListFilter; query: string; now: Date }): ListSections {
  const { filter, query, now } = opts;
  const searched = rows.filter((r) => matchesQuery(r, query));
  const visible = searched.filter((r) => matchesFilter(r, filter, now) && (filter === "closed" || query.trim() !== "" || !isClosed(r.status)));
  const byUpdate = (a: CaseRowData, b: CaseRowData) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id;
  if (filter === "all" || filter === "attention") {
    const attention: { row: CaseRowData; reason: string }[] = [];
    const rest: CaseRowData[] = [];
    for (const r of [...visible].sort(byUpdate)) {
      const reason = attentionReason(r, now);
      if (reason) attention.push({ row: r, reason });
      else if (filter === "all") rest.push(r);
    }
    // «ממתינים לך»: who waits longest comes first; a tie by case number (no score, no hidden weighting).
    const since = (r: CaseRowData) => Date.parse(r.statusSince ?? r.updatedAt);
    attention.sort((x, y) => since(x.row) - since(y.row) || x.row.caseNumber - y.row.caseNumber);
    return { attention, rest, total: rows.length, shown: attention.length + rest.length };
  }
  const rest = [...visible].sort(byUpdate);
  return { attention: [], rest, total: rows.length, shown: rest.length };
}

/** The short description line of a row: the subject (when there is one), then the problem. */
export function rowDescription(c: Pick<CaseRowData, "subjectName" | "problemExcerpt">): string {
  const parts = [c.subjectName?.trim(), c.problemExcerpt?.trim()].filter((x): x is string => !!x);
  return parts.length ? parts.join(" · ") : "ללא תיאור";
}

export function formatShortDate(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" }).format(d);
  return new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", timeZone: "Asia/Jerusalem" }).format(d);
}

// ── Case screen ──────────────────────────────────────────────────────────────────────────────────

export type CaseCardData = CaseRowData & {
  problemDescription: string | null;
  parentCaseId: number | null;
  coverage: { source: string; decision: string } | null;
  cancellationRequested: boolean;
  stamps: Partial<Record<"checkedInAt" | "readyAt" | "deliveredAt" | "closedAt" | "cancelledAt" | "abandonedAt", string | null>>;
  intake: { conditionNote: string | null; accessoriesNote: string | null; conditionRecorded: boolean; accessoriesRecorded: boolean } | null;
};

export type JournalItem = {
  seq: number; eventType: string; toStatus: string; occurredAt: string; actor: string; payload?: unknown;
  /** The acting user (the journal read): their profile name, whether the row was found, and the stored id. */
  actorUserId?: number | null; actorName?: string | null; actorKnown?: boolean;
};

export type SectionKey = "details" | "intake" | "quote" | "checks" | "handover" | "history";

/** Which sections the case screen shows for this case, and which of them open by themselves (they need attention). */
export function caseSections(c: Pick<CaseCardData, "kind" | "status" | "intake">): { key: SectionKey; title: string; open: boolean }[] {
  const held = c.kind === "IN_SHOP";
  const s: { key: SectionKey; title: string; open: boolean }[] = [
    { key: "details", title: held ? "הפריט והתקלה" : "פרטי העבודה", open: true },
  ];
  if (held) s.push({ key: "intake", title: "קליטה", open: c.status === "OPEN" || c.intake === null });
  s.push({ key: "quote", title: "הצעת מחיר", open: c.status === "QUOTE_PENDING" || c.status === "DIAGNOSING" });
  s.push({ key: "checks", title: "בדיקות", open: c.status === "QA" });
  if (held) s.push({ key: "handover", title: "מסירה", open: c.status === "READY" });
  s.push({ key: "history", title: "היסטוריה", open: false });
  return s;
}

const EVENT_LABEL: Readonly<Record<string, string>> = {
  "case.opened": "נפתח",
  "case.scheduled": "תואם ביקור",
  "case.rescheduled": "הביקור תואם מחדש",
  "case.checked_in": "הפריט נקלט",
  "case.diagnosis_started": "התחיל אבחון",
  "quote.sent": "נשלחה הצעת מחיר",
  "quote.revised": "הצעת המחיר עודכנה",
  "quote.approved": "הלקוח אישר את ההצעה",
  "quote.rejected": "הלקוח דחה את ההצעה",
  "repair.started": "העבודה התחילה",
  "repair.finished": "העבודה הסתיימה",
  "hold.set": "הועבר להמתנה",
  "hold.cleared": "חזר לעבודה",
  "external.sent": "נשלח לספק",
  "external.returned": "חזר מהספק",
  "qa.passed": "הבדיקות עברו",
  "qa.failed": "הבדיקות לא עברו — חזרה לעבודה",
  "case.not_repairable": "סומן כלא ניתן לתיקון",
  "case.delivered": "נמסר ללקוח",
  "case.closed": "נסגר",
  "case.completed": "נסגר באישור בעל העסק",
  "case.cancelled": "בוטל",
  "case.abandoned": "סומן כלא נאסף",
  "case.details_changed": "הפרטים עודכנו",
  // records (the status stays): named for what was recorded, never "updated: <status>"
  "case.technician_assigned": "שובץ טכנאי",
  "intake.recorded": "פרטי הקליטה נרשמו",
  "qa.recorded": "הבדיקות נרשמו",
  "charge.recorded": "החיוב נרשם",
  "billing.linked": "קושר מסמך חיוב",
  "billing.unlinked": "הוסר קישור למסמך חיוב",
  "case.cancellation_requested": "התבקש ביטול",
  // migration 20261222090000 (once applied): the light case work, with who acted
  "case.work_details_recorded": "פרטי העבודה עודכנו",
  "loan.lent": "ניתן ציוד חלופי",
  "loan.returned": "הוחזר ציוד חלופי",
  "task.linked": "קושרה משימה",
  "task.unlinked": "הוסר קישור למשימה",
};

/** Names the screen already holds for ids the journal stores (a loan's item, a task's title) — never stored in the journal. */
export type HistoryNames = { loans?: Readonly<Record<number, string>>; tasks?: Readonly<Record<number, string>> };

const ACTOR_LABEL: Readonly<Record<string, string>> = { OWNER_USER: "בעל העסק", CUSTOMER_LINK: "הלקוח", SYSTEM: "המערכת" };

/** Who acted, as the journal records it (the actor kind; no name is stored on the event). */
export function actorLabel(actor: string | undefined): string | null {
  return actor ? ACTOR_LABEL[actor] ?? null : null;
}

/**
 * Who acted, for a history line (owner decision 2026-11-24): the user's real name as the system knows it; when it is
 * missing, words that say so — never an invented name, never an e-mail. The system and the customer keep their words.
 */
export function actorText(e: Pick<JournalItem, "actor" | "actorUserId" | "actorName" | "actorKnown">): string | null {
  if (e.actor !== "OWNER_USER") return actorLabel(e.actor);
  if (e.actorName === undefined) return actorLabel(e.actor); // an older read without names
  if (e.actorName) return e.actorName;
  if (e.actorUserId === null || e.actorUserId === undefined || e.actorKnown === false) return "משתמש לא מזוהה";
  return "משתמש ללא שם";
}

const ils = (agorot: number) => `₪${(agorot / 100).toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The history line of an event: its name, and — only from what the journal actually stores (the closed payload of
 * tokens and numbers) — the detail that matters: the QA counts, a handover with an open balance, the charge, the way
 * the customer answered a quote. Nothing is inferred; a reason text is never in the journal, so it is never shown here.
 */
export function eventLabel(e: Pick<JournalItem, "eventType" | "toStatus"> & { payload?: unknown }, names: HistoryNames = {}): string {
  const base = EVENT_LABEL[e.eventType] ?? "עדכון בתיק";
  const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
  switch (e.eventType) {
    case "qa.recorded": {
      const passed = num(p.passed), failed = num(p.failed);
      if (passed === null && failed === null) return base;
      return `${base} · ${passed ?? 0} עברו${failed ? `, ${failed} לא עברו` : ""}`;
    }
    case "case.delivered":
    case "case.completed":
      return p.debtOverride === true ? `${base} · עם יתרה פתוחה, באישור בעל העסק (הסיבה נשמרה)` : base;
    case "charge.recorded":
      if (p.mode === "NO_CHARGE") return `${base} · ללא חיוב`;
      return num(p.amountAgorot) !== null ? `${base} · ${ils(num(p.amountAgorot)!)}` : base;
    case "quote.approved":
    case "quote.rejected":
      return p.method === "PHONE" ? `${base} · בטלפון` : p.method === "IN_PERSON" ? `${base} · פנים אל פנים` : base;
    case "case.work_details_recorded": {
      const parts: string[] = [];
      if (p.locationChanged === true) parts.push(p.locationSet === true ? "מיקום הפריט עודכן" : "מיקום הפריט נמחק");
      if (p.estimatedChanged === true) {
        const d = typeof p.estimatedReadyOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.estimatedReadyOn) ? p.estimatedReadyOn : null;
        parts.push(d ? `סיום משוער: ${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}` : "תאריך הסיום המשוער הוסר");
      }
      return parts.length ? parts.join(" · ") : base;
    }
    case "loan.lent":
    case "loan.returned": {
      const n = num(p.loanId) !== null ? names.loans?.[num(p.loanId)!] : undefined;
      return n ? `${base}: ${n}` : base;
    }
    case "task.linked":
    case "task.unlinked": {
      const n = num(p.taskId) !== null ? names.tasks?.[num(p.taskId)!] : undefined;
      return n ? `${base}: ${n}` : base;
    }
    default:
      return base;
  }
}

/** A history line from a record kept outside the journal (a loan, a pickup call): real stored times only. */
export type SideHistoryItem = { key: string; text: string; occurredAt: string };

/** The loans the journal already records (migration 20261222090000): their side lines are not repeated. */
export function journaledLoanIds(events: readonly JournalItem[]): Set<number> {
  const out = new Set<number>();
  for (const e of events) {
    if (e.eventType !== "loan.lent" && e.eventType !== "loan.returned") continue;
    const id = (e.payload as { loanId?: unknown } | undefined)?.loanId;
    if (typeof id === "number") out.add(id);
  }
  return out;
}

/** The journal and the side records, newest first, as one list for the history section. */
export function mergedHistory(events: readonly JournalItem[], side: readonly SideHistoryItem[], names: HistoryNames = {}): { key: string; text: string; occurredAt: string; actor: string | null }[] {
  const rows = [
    ...events.map((e) => ({ key: `e${e.seq}`, text: eventLabel(e, names), occurredAt: e.occurredAt, actor: actorText(e), order: e.seq })),
    ...side.map((x) => ({ key: x.key, text: x.text, occurredAt: x.occurredAt, actor: null as string | null, order: 0 })),
  ];
  return rows.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.order - a.order).map((r) => ({ key: r.key, text: r.text, occurredAt: r.occurredAt, actor: r.actor }));
}

/** Newest first, for the history section. */
export function historyItems(events: readonly JournalItem[]): JournalItem[] {
  return [...events].sort((a, b) => b.seq - a.seq);
}
