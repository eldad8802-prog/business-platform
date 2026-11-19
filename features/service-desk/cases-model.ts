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
};

export type Tone = "attention" | "active" | "ready" | "done";

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
  if (isClosed(status)) return "done";
  if (status === "READY" || status === "WORK_DONE") return "ready";
  if (status === "QUOTE_PENDING" || status === "OPEN" || holdReason) return "attention";
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
 * Why a case needs the owner now — one short, explained sentence — or null. No score, no hidden weighting:
 * the reason names what is waiting and for how long.
 */
export function attentionReason(c: Pick<CaseRowData, "status" | "holdReason" | "updatedAt" | "kind">, now: Date): string | null {
  const waited = daysBetween(c.updatedAt, now);
  switch (c.status) {
    case "READY":
      return waited >= 2 ? `מוכן ולא נאסף · ${daysText(waited)}` : "מוכן — לעדכן את הלקוח";
    case "QUOTE_PENDING":
      return `הצעת מחיר ממתינה לתשובת הלקוח · ${daysText(waited)}`;
    case "OPEN":
      return c.kind === "FIELD" ? "צריך לתאם ביקור" : "צריך לקלוט את הפריט";
    case "WORK_DONE":
      return "העבודה הסתיימה — לסגור את הקריאה";
    default:
      if (c.holdReason) return `${HOLD_LABEL[c.holdReason] ?? "בהמתנה"} · ${daysText(waited)}`;
      return null;
  }
}

/** The next step the owner takes, in plain words, for the case screen's top card. */
export function nextActionLabel(status: CaseStatus, kind: CaseKind, holdReason: string | null = null): string | null {
  if (status === "IN_REPAIR" && holdReason === "PARTS") return "כשהחלקים מגיעים — להחזיר לעבודה";
  if (status === "IN_REPAIR" && holdReason) return "כשהלקוח חוזר — להחזיר לעבודה";
  const field = kind === "FIELD" || kind === "REMOTE";
  switch (status) {
    case "OPEN": return field ? "לתאם ביקור" : "לקלוט את הפריט";
    case "SCHEDULED": return "להתחיל את הביקור";
    case "CHECKED_IN": return "להתחיל אבחון";
    case "DIAGNOSING": return "להחליט: לתקן או לשלוח הצעת מחיר";
    case "QUOTE_PENDING": return "לרשום את תשובת הלקוח להצעה";
    case "IN_REPAIR": return field ? "לסיים את העבודה" : "לסיים את התיקון";
    case "EXTERNAL": return "לרשום חזרה מהספק";
    case "QA": return "להשלים את הבדיקות";
    case "READY": return "למסור ללקוח";
    case "WORK_DONE": return "לסגור את הקריאה";
    default: return null;
  }
}

export type ListFilter = "all" | "attention" | "active" | "ready" | "closed";

export const LIST_FILTERS: readonly { key: ListFilter; label: string }[] = [
  { key: "all", label: "הכל" },
  { key: "attention", label: "דורשים טיפול" },
  { key: "active", label: "בעבודה" },
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

export type JournalItem = { seq: number; eventType: string; toStatus: string; occurredAt: string; actor: string };

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
};

export function eventLabel(e: Pick<JournalItem, "eventType" | "toStatus">): string {
  return EVENT_LABEL[e.eventType] ?? `עודכן: ${statusLabel(e.toStatus as CaseStatus)}`;
}

/** Newest first, for the history section. */
export function historyItems(events: readonly JournalItem[]): JournalItem[] {
  return [...events].sort((a, b) => b.seq - a.seq);
}
