/**
 * Daily Tasks — the agenda, as pure decisions (Daily Tasks spec sections 7, 8.1–8.5, 8.7).
 *
 * The agenda merges the owner's own tasks (Task rows) with items from the business (source adapters), applies the
 * owner's display state (handled for today, snoozed, pinned), groups, caps, counts and orders — and says honestly
 * whether the picture is complete. Nothing here reads a database, a clock or the environment: the service supplies
 * `today`, `now`, the adapters' results and the stored state, and the tests prove the rules without a database.
 *
 * Fixed rules, each explainable in one sentence:
 *   - Bucket by Jerusalem calendar day: OVERDUE (due before today), TODAY (due today, or a fact waiting for the
 *     owner now), NO_DATE (no due day, or a queue without one), UPCOMING (due in the next 7 days, folded).
 *   - Only OVERDUE and TODAY are counted. Amount never raises severity; learning never moves an item.
 *   - Order inside a bucket: pinned ("חשוב") first, then source severity, then the due day (overdue: oldest first;
 *     upcoming: nearest first), then the age of the fact (oldest first), then a stable key.
 *   - A source with more than three items in one bucket becomes ONE queue row ("7 שיחות מחכות לתשובה"); supplier
 *     payments and leads are never grouped, each has its own date and context.
 *   - OVERDUE and TODAY show at most 12 rows each, with "עוד N"; the count is always the full one.
 *   - A source that failed or hit its fetch cap makes the picture PARTIAL: the count is marked "N+" and the empty
 *     state ("הכול תחת שליטה") is never shown.
 */
import { addCalendarDays, daysBetweenDayKeys, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

// ── Sources ─────────────────────────────────────────────────────────────────────────────────────

/** The eight first-version sources (spec section 4: S01, S02, S06, S13/S14, S16, S23, S25). */
export type SourceKind =
  | "supplier_payment"
  | "customer_debt"
  | "invoice_review"
  | "lead"
  | "conversation"
  | "documents_queue"
  | "stock";

export const SOURCE_KINDS: readonly SourceKind[] = [
  "supplier_payment", "customer_debt", "invoice_review", "lead", "conversation", "documents_queue", "stock",
];

export const SOURCE_NAMES: Readonly<Record<SourceKind, string>> = {
  supplier_payment: "תשלומים לספקים",
  customer_debt: "גבייה מלקוחות",
  invoice_review: "חשבוניות לבדיקה",
  lead: "לידים",
  conversation: "שיחות שמחכות לתשובה",
  documents_queue: "מסמכים לבדיקה",
  stock: "מלאי",
};

/** "N <things>" for a grouped queue row. */
export function queueTitle(kind: SourceKind, n: number): string {
  switch (kind) {
    case "conversation": return `${n} שיחות מחכות לתשובה`;
    case "stock": return `${n} פריטים במלאי נמוך`;
    case "invoice_review": return `${n} חשבוניות ממתינות לבדיקה`;
    case "customer_debt": return `${n} לקוחות לגבייה`;
    case "documents_queue": return `${n} מסמכים מחכים לבדיקה`;
    case "lead": return `${n} לידים`;
    case "supplier_payment": return `${n} תשלומים לספקים`;
  }
}

/** Never grouped: each item has its own due day and context (spec 4.4). */
const NEVER_GROUPED: ReadonlySet<SourceKind> = new Set<SourceKind>(["supplier_payment", "lead"]);

export type Severity = "HIGH" | "NORMAL";
export type Placement = "BY_DATE" | "TODAY" | "NO_DATE";
/** Where "remind me later" is stored (spec 3.3): in the domain (lead, payment) or as display state. */
export type SnoozeSlot = "LEAD" | "PAYMENT" | "STATE";

export type SourceItem = {
  sourceKind: SourceKind;
  /** What the item is (`lead:17`). */
  dedupeKey: string;
  /** The treatment cycle (8.5). */
  cycleKey: string;
  /** Rises within a cycle when new evidence arrives (8.5). */
  evidenceVersion: string;
  placement: Placement;
  /** The domain's due day, when it has one. */
  dueOn: JerusalemDayKey | null;
  severity: Severity;
  title: string;
  /** One fact line built from source fields, a fixed template — never model text. */
  fact: string;
  /** When the fact happened (oldest first inside a bucket). ISO. */
  factAt: string | null;
  action: { label: string; href: string };
  snooze: SnoozeSlot;
  /** Supplier payment: the reminder was postponed while the payment stays due (3.5). */
  reminderPostponed?: { until: JerusalemDayKey } | null;
  /** Supplier payments keep the secretary's own order on a shared day (7.3 exception). */
  orderHint?: number;
  /** The domain entity, for routed actions and dedupe across sources. */
  entity?: { kind: "obligation" | "lead" | "customer" | "conversation" | "billing_document" | "inventory_alert"; id: number };
  /** S16 is muted when S14 shows the same customer (8.2). */
  customerId?: number | null;
  /** Domain facts the details panel shows (never journaled). */
  details?: Record<string, string | number | boolean | null>;
};

export type SourceStatus = "OK" | "FAILED" | "DISABLED" | "CAPPED";
export type SourceResult = { kind: SourceKind; status: SourceStatus; items: SourceItem[] };

/** The owner's stored display state over one item in one cycle (TaskSourceState). */
export type StoredState = {
  dedupeKey: string;
  cycleKey: string;
  /** The evidence version when the owner last acted (snooze compares against it). */
  evidenceVersion: string;
  acknowledgedOn: JerusalemDayKey | null;
  ackEvidenceVersion: string | null;
  snoozedUntil: string | null;
  pinnedAt: string | null;
  dismissedAt: string | null;
};

// ── Owner tasks ─────────────────────────────────────────────────────────────────────────────────

export type ManualTask = {
  id: number;
  title: string;
  note: string | null;
  dueOn: JerusalemDayKey | null;
  pinned: boolean;
  version: number;
  seriesId: number | null;
  sequence: number | null;
  /** A human cadence for a series occurrence ("כל יום שלישי"). */
  cadence: string | null;
  link: { kind: "customer" | "supplier" | "lead" | "document"; id: number; label: string | null } | null;
  createdAt: string;
};

/** An active series without an open occurrence: computed, not stored, until the sync repairs it (8.7). */
export type PendingRepair = { seriesId: number; title: string; dueOn: JerusalemDayKey; cadence: string | null };

// ── Rows and the agenda ─────────────────────────────────────────────────────────────────────────

export type Bucket = "OVERDUE" | "TODAY" | "NO_DATE" | "UPCOMING";
export const BUCKETS: readonly Bucket[] = ["OVERDUE", "TODAY", "NO_DATE", "UPCOMING"];
export const BUCKET_TITLES: Readonly<Record<Bucket, string>> = {
  OVERDUE: "באיחור",
  TODAY: "היום",
  NO_DATE: "ללא תאריך",
  UPCOMING: "בהמשך השבוע",
};
export const COUNTED: ReadonlySet<Bucket> = new Set<Bucket>(["OVERDUE", "TODAY"]);
export const ROW_CAP = 12;
export const UPCOMING_DAYS = 7;
export const GROUP_OVER = 3;

export type Tag = { tone: "over" | "snooze" | "pin" | "today" | "rep" | "upd" | "new"; text: string };

export type AgendaRow =
  | { type: "TASK"; key: string; bucket: Bucket; pinned: boolean; task: ManualTask; tags: Tag[] }
  | { type: "SOURCE"; key: string; bucket: Bucket; pinned: boolean; item: SourceItem; tags: Tag[]; dimmed: boolean }
  | { type: "QUEUE"; key: string; bucket: Bucket; pinned: false; sourceKind: SourceKind; title: string; fact: string; members: SourceItem[]; action: { label: string; href: string };
      /** T-C5: members already handled today, and how many arrived (or changed) since — shown as "חדשים: N". */
      handledToday: SourceItem[]; newCount: number | null; tags: Tag[] }
  | { type: "REPAIR"; key: string; bucket: Bucket; pinned: false; repair: PendingRepair; tags: Tag[] };

export type BucketView = { bucket: Bucket; title: string; rows: AgendaRow[]; shown: number; total: number; items: number };

export type Integrity = "COMPLETE" | "REPAIR_PENDING" | "PARTIAL" | "SYNC_FAILED";

export type Agenda = {
  dayKey: JerusalemDayKey;
  buckets: BucketView[];
  /** OVERDUE + TODAY items (queue members counted one by one). */
  count: number;
  /** True when a counted source failed or hit its cap: show "N+". */
  countPartial: boolean;
  doneToday: number;
  sources: { kind: SourceKind; status: SourceStatus; name: string }[];
  /** Every applicable state; COMPLETE only when it is the only one. */
  integrity: Integrity[];
  /** Only here may the empty state "הכול תחת שליטה" be shown. */
  emptyAllowed: boolean;
};

// ── Display state ───────────────────────────────────────────────────────────────────────────────

export type VisibleItem = { item: SourceItem; pinned: boolean };

/**
 * Apply the owner's state to the adapters' items (8.5): "handled for today" holds for the day it was given and
 * only while the evidence is the same; a display snooze holds until its day and only while the evidence is the
 * same; state never carries into a new cycle (the key includes the cycle).
 */
export function applyDisplayState(items: SourceItem[], states: StoredState[], today: JerusalemDayKey, now: Date): VisibleItem[] {
  const byKey = new Map(states.map((s) => [`${s.dedupeKey}|${s.cycleKey}`, s]));
  const out: VisibleItem[] = [];
  for (const item of items) {
    const s = byKey.get(`${item.dedupeKey}|${item.cycleKey}`);
    if (s) {
      if (s.acknowledgedOn === today && s.ackEvidenceVersion === item.evidenceVersion) continue;
      if (item.snooze === "STATE" && s.snoozedUntil && new Date(s.snoozedUntil) > now && s.evidenceVersion === item.evidenceVersion) continue;
    }
    out.push({ item, pinned: !!s?.pinnedAt });
  }
  return out;
}

/** The items "handled for today" hides — still on the same evidence. A grouped queue needs them (T-C5). */
export function acknowledgedToday(items: SourceItem[], states: StoredState[], today: JerusalemDayKey): SourceItem[] {
  const byKey = new Map(states.map((s) => [`${s.dedupeKey}|${s.cycleKey}`, s]));
  return items.filter((item) => {
    const s = byKey.get(`${item.dedupeKey}|${item.cycleKey}`);
    return !!s && s.acknowledgedOn === today && s.ackEvidenceVersion === item.evidenceVersion;
  });
}

/** S16 is muted when an S14 lead row is shown for the same customer (8.2). */
export function muteDuplicates(items: VisibleItem[]): VisibleItem[] {
  const leadCustomers = new Set(items.filter((v) => v.item.sourceKind === "lead" && v.item.customerId).map((v) => v.item.customerId));
  return items.filter((v) => !(v.item.sourceKind === "conversation" && v.item.customerId && leadCustomers.has(v.item.customerId)));
}

// ── Buckets ─────────────────────────────────────────────────────────────────────────────────────

/** Where an item with this placement and due day goes; null = beyond the window (not on the agenda). */
export function bucketFor(placement: Placement, dueOn: JerusalemDayKey | null, today: JerusalemDayKey): Bucket | null {
  if (placement === "NO_DATE") return "NO_DATE";
  if (placement === "TODAY") return dueOn && dueOn < today ? "OVERDUE" : "TODAY";
  if (!dueOn) return "NO_DATE";
  if (dueOn < today) return "OVERDUE";
  if (dueOn === today) return "TODAY";
  return daysBetweenDayKeys(today, dueOn) <= UPCOMING_DAYS ? "UPCOMING" : null;
}

export function overdueLabel(dueOn: JerusalemDayKey, today: JerusalemDayKey): string {
  const d = daysBetweenDayKeys(dueOn, today);
  if (d === 1) return "באיחור יום";
  if (d === 2) return "באיחור יומיים";
  return `באיחור ${d} ימים`;
}

/** "13.10" — the short Israeli date the mockups use. */
export function shortDate(day: JerusalemDayKey): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
}

// ── Ordering ────────────────────────────────────────────────────────────────────────────────────

function rowSeverity(r: AgendaRow): number {
  if (r.type === "SOURCE") return r.item.severity === "HIGH" ? 0 : 1;
  if (r.type === "QUEUE") return r.members.some((m) => m.severity === "HIGH") ? 0 : 1;
  return 1;
}
function rowDue(r: AgendaRow): JerusalemDayKey | null {
  if (r.type === "TASK") return r.task.dueOn;
  if (r.type === "SOURCE") return r.item.dueOn;
  if (r.type === "REPAIR") return r.repair.dueOn;
  return null;
}
function rowFactAt(r: AgendaRow): string | null {
  if (r.type === "SOURCE") return r.item.factAt;
  if (r.type === "QUEUE") return r.members.map((m) => m.factAt).filter((x): x is string => !!x).sort()[0] ?? null;
  if (r.type === "TASK") return r.task.createdAt;
  return null;
}

/** The fixed in-bucket order (7.3). A postponed supplier-payment reminder goes to the end of its bucket (3.5). */
export function compareRows(bucket: Bucket) {
  return (a: AgendaRow, b: AgendaRow): number => {
    const dimA = a.type === "SOURCE" && a.dimmed ? 1 : 0;
    const dimB = b.type === "SOURCE" && b.dimmed ? 1 : 0;
    if (dimA !== dimB) return dimA - dimB;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const s = rowSeverity(a) - rowSeverity(b);
    if (s) return s;
    const da = rowDue(a), db = rowDue(b);
    if (da && db && da !== db) return da < db ? -1 : 1; // overdue: oldest first; upcoming: nearest first — both ascending
    if (da && !db) return -1;
    if (!da && db) return 1;
    // Supplier payments on one day keep the secretary's order (amount as its tie-breaker, 7.3 exception).
    if (a.type === "SOURCE" && b.type === "SOURCE" && a.item.orderHint !== undefined && b.item.orderHint !== undefined) {
      return a.item.orderHint - b.item.orderHint;
    }
    const fa = rowFactAt(a), fb = rowFactAt(b);
    if (fa && fb && fa !== fb) return fa < fb ? -1 : 1;
    void bucket;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
}

// ── Assembly ────────────────────────────────────────────────────────────────────────────────────

export type AgendaInput = {
  today: JerusalemDayKey;
  now: Date;
  tasks: ManualTask[];
  repairs: PendingRepair[];
  results: SourceResult[];
  states: StoredState[];
  doneToday: number;
  syncFailed: boolean;
};

function taskTags(t: ManualTask, bucket: Bucket, today: JerusalemDayKey, pinned: boolean): Tag[] {
  const tags: Tag[] = [];
  if (bucket === "OVERDUE" && t.dueOn) tags.push({ tone: "over", text: overdueLabel(t.dueOn, today) });
  if (pinned) tags.push({ tone: "pin", text: "חשוב" });
  if (t.cadence) tags.push({ tone: "rep", text: t.cadence });
  return tags;
}

function sourceTags(i: SourceItem, bucket: Bucket, today: JerusalemDayKey, pinned: boolean): Tag[] {
  const tags: Tag[] = [];
  if (bucket === "OVERDUE" && i.dueOn) tags.push({ tone: "over", text: overdueLabel(i.dueOn, today) });
  if (i.reminderPostponed) {
    const when = i.reminderPostponed.until === addCalendarDays(today, 1) ? "למחר" : `ל־${shortDate(i.reminderPostponed.until)}`;
    tags.push({ tone: "snooze", text: `התזכורת נדחתה ${when} · עדיין לא שולם` });
  }
  if (pinned) tags.push({ tone: "pin", text: "חשוב" });
  return tags;
}

export function buildAgenda(input: AgendaInput): Agenda {
  const { today, now } = input;
  const rows: AgendaRow[] = [];

  for (const t of input.tasks) {
    const bucket = bucketFor("BY_DATE", t.dueOn, today);
    if (!bucket) continue;
    rows.push({ type: "TASK", key: `task:${t.id}`, bucket, pinned: t.pinned, task: t, tags: taskTags(t, bucket, today, t.pinned) });
  }
  for (const r of input.repairs) {
    const bucket = bucketFor("BY_DATE", r.dueOn, today);
    if (!bucket) continue;
    const tags: Tag[] = [{ tone: "upd", text: "מתעדכנת…" }];
    if (r.cadence) tags.push({ tone: "rep", text: r.cadence });
    rows.push({ type: "REPAIR", key: `repair:${r.seriesId}`, bucket, pinned: false, repair: r, tags });
  }

  const allItems = input.results.flatMap((r) => (r.status === "DISABLED" ? [] : r.items));
  const visible = muteDuplicates(applyDisplayState(allItems, input.states, today, now));
  const handled = new Map<string, SourceItem[]>();
  for (const item of acknowledgedToday(allItems, input.states, today)) {
    const bucket = bucketFor(item.placement, item.dueOn, today);
    if (!bucket) continue;
    const k = `${item.sourceKind}|${bucket}`;
    handled.set(k, [...(handled.get(k) ?? []), item]);
  }
  const bySourceBucket = new Map<string, { bucket: Bucket; items: VisibleItem[] }>();
  for (const v of visible) {
    const bucket = bucketFor(v.item.placement, v.item.dueOn, today);
    if (!bucket) continue;
    const k = `${v.item.sourceKind}|${bucket}`;
    const g = bySourceBucket.get(k) ?? { bucket, items: [] };
    g.items.push(v);
    bySourceBucket.set(k, g);
  }
  for (const [k, g] of bySourceBucket) {
    const kind = k.split("|")[0] as SourceKind;
    const pinnedOnes = g.items.filter((v) => v.pinned);
    const rest = g.items.filter((v) => !v.pinned);
    // A queue handled for today comes back as ONE row when something new arrives (T-C5): the handled members
    // stay in the group, only the new ones are counted ("חדשים: N").
    const handledHere = NEVER_GROUPED.has(kind) ? [] : handled.get(k) ?? [];
    const groupable = !NEVER_GROUPED.has(kind) && (rest.length > GROUP_OVER || (handledHere.length > 0 && rest.length > 0 && rest.length + handledHere.length > GROUP_OVER));
    for (const v of groupable ? pinnedOnes : g.items) {
      const dimmed = !!v.item.reminderPostponed;
      rows.push({ type: "SOURCE", key: v.item.dedupeKey, bucket: g.bucket, pinned: v.pinned, item: v.item, tags: sourceTags(v.item, g.bucket, today, v.pinned), dimmed });
    }
    if (groupable) {
      const members = rest.map((v) => v.item);
      const all = [...members, ...handledHere];
      const oldest = all.map((m) => m.factAt).filter((x): x is string => !!x).sort()[0] ?? null;
      const newCount = handledHere.length > 0 ? members.length : null;
      rows.push({
        type: "QUEUE", key: `queue:${kind}:${g.bucket}`, bucket: g.bucket, pinned: false, sourceKind: kind,
        title: queueTitle(kind, all.length),
        fact: oldest ? `הוותיק מחכה מ־${shortDate(oldest.slice(0, 10))} · פתח לרשימה` : "פתח לרשימה",
        members, action: { label: "פתח", href: all[0].action.href },
        handledToday: handledHere, newCount,
        tags: newCount !== null ? [{ tone: "new", text: `חדשים: ${newCount}` }] : [],
      });
    }
  }

  const buckets: BucketView[] = BUCKETS.map((bucket) => {
    const inBucket = rows.filter((r) => r.bucket === bucket).sort(compareRows(bucket));
    const items = inBucket.reduce((n, r) => n + (r.type === "QUEUE" ? r.members.length : 1), 0);
    const shown = COUNTED.has(bucket) ? Math.min(ROW_CAP, inBucket.length) : inBucket.length;
    return { bucket, title: BUCKET_TITLES[bucket], rows: inBucket, shown, total: inBucket.length, items };
  });

  const count = buckets.filter((b) => COUNTED.has(b.bucket)).reduce((n, b) => n + b.items, 0);
  const statuses = input.results.map((r) => ({ kind: r.kind, status: r.status, name: SOURCE_NAMES[r.kind] }));
  const partial = input.results.some((r) => r.status === "FAILED" || r.status === "CAPPED");
  const integrity: Integrity[] = [];
  if (input.repairs.length > 0) integrity.push("REPAIR_PENDING");
  if (partial) integrity.push("PARTIAL");
  if (input.syncFailed && input.repairs.length > 0) integrity.push("SYNC_FAILED");
  if (integrity.length === 0) integrity.push("COMPLETE");
  const emptyAllowed = integrity.length === 1 && integrity[0] === "COMPLETE" && count === 0;

  return { dayKey: today, buckets, count, countPartial: partial, doneToday: input.doneToday, sources: statuses, integrity, emptyAllowed };
}
