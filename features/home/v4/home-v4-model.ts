/**
 * HOME v4 — the view-model. Pure: no I/O, no React, no clock of its own (every function takes `now`).
 *
 * The screen has four fixed areas, always in this order, whatever the time of day or the amount of activity:
 *   תמונת מצב · המזכירה שלי · היום שלי · בשבילך
 * Each area shows ONE thing up front (two metrics, one recommendation, one upcoming item, one smart item) and
 * reaches the rest by expanding or by going to its screen. More activity never adds cards.
 *
 * Truth rules (carried from HOME v3 and extended):
 *   - a figure is shown only from a real source; a failed source says "לא נטען", never 0;
 *   - a count a source may have cut is shown as "N+" (exact: false);
 *   - a module that is OFF, or a scope the person lacks, produces NOTHING — no empty card, no locked tile;
 *   - the calm state ("אין כרגע דברים דחופים") is shown only when every source answered and nothing was cut;
 *   - nothing is invented to fill a space: an area with nothing true to say is quiet or absent.
 */
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/config";
import type { HomeHistory } from "@/lib/services/home/home-history-model";

import { allows, type BusinessKind, type HomeAccess, type HomeModule, type HomeScope, type Requirement } from "./home-access";
import {
  formatShekel,
  israelDateKey,
  type ActivityItem,
  type CountClaim,
  type Load,
  type WaitingItem,
  type WaitingKind,
  type WaitingModel,
} from "../v3/home-v3-model";

/** "8+" isolated left-to-right, so a right-to-left line never draws it as "+8". */
export function cappedText(n: number): string {
  return "\u2066" + n + "+\u2069"; // LEFT-TO-RIGHT ISOLATE … POP DIRECTIONAL ISOLATE
}

/* =========================================================== snapshot ===== */

export type MetricKey =
  | "receiptsMonth"
  | "receiptsToday"
  | "openService"
  | "todayTasks"
  | "waitingLeads"
  | "toCollect"
  | "docsReview"
  | "todayAppointments";

export type MetricDef = {
  key: MetricKey;
  format: "money" | "count";
  req: Requirement;
  /** Where a tap goes — the screen that shows exactly what the figure counts. */
  href: string;
};

export const METRICS: Record<MetricKey, MetricDef> = {
  receiptsMonth: { key: "receiptsMonth", format: "money", req: { modules: ["billing"], scope: "money" }, href: "/collection" },
  receiptsToday: { key: "receiptsToday", format: "money", req: { modules: ["billing"], scope: "money" }, href: "/collection" },
  openService: { key: "openService", format: "count", req: { modules: ["service_desk"], scope: "operations" }, href: "/service-desk" },
  todayTasks: { key: "todayTasks", format: "count", req: { modules: ["daily_tasks"], scope: "operations" }, href: "/tasks" },
  waitingLeads: { key: "waitingLeads", format: "count", req: { scope: "customers" }, href: "/leads?view=needsAction" },
  toCollect: { key: "toCollect", format: "count", req: { modules: ["billing"], scope: "money" }, href: "/collection" },
  docsReview: { key: "docsReview", format: "count", req: { modules: ["documents"], scope: "documents" }, href: "/documents/inbox" },
  todayAppointments: { key: "todayAppointments", format: "count", req: { modules: ["appointments"], scope: "operations" }, href: "/calendar" },
};

/** Default order per business kind: the first two are the main pair. Money first everywhere it is available. */
export const DEFAULT_METRIC_ORDER: Record<BusinessKind, MetricKey[]> = {
  service: ["receiptsMonth", "openService", "todayTasks", "toCollect", "waitingLeads", "todayAppointments", "docsReview", "receiptsToday"],
  booking: ["receiptsMonth", "todayAppointments", "waitingLeads", "toCollect", "todayTasks", "docsReview", "receiptsToday", "openService"],
  sales: ["receiptsMonth", "waitingLeads", "toCollect", "todayAppointments", "todayTasks", "docsReview", "receiptsToday", "openService"],
  general: ["receiptsMonth", "waitingLeads", "toCollect", "todayTasks", "docsReview", "todayAppointments", "receiptsToday", "openService"],
};

/** The metrics this business + person may see, in display order (the owner's chosen pair first, when still valid). */
export function metricOrder(access: HomeAccess, chosenPrimary: readonly string[] | null): MetricKey[] {
  const available = DEFAULT_METRIC_ORDER[access.kind].filter((k) => allows(access, METRICS[k].req));
  const chosen = (chosenPrimary ?? []).filter((k): k is MetricKey => (available as string[]).includes(k)).slice(0, 2);
  return [...chosen, ...available.filter((k) => !chosen.includes(k))];
}

export type MetricValue =
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "ready";
      /** Display text: "₪12,450" or "8" / "8+". */
      text: string;
      /** A real zero — the source answered and counted nothing. Never set for a failure. */
      zero: boolean;
      /** Money in another currency exists and is NOT in the figure. */
      mixed: boolean;
      exact: boolean;
    };

export function moneyMetric(load: Load<{ amount: string; mixed: boolean }>, locale: Locale): MetricValue {
  if (load.state !== "ready") return load;
  const n = Number(load.value.amount);
  if (!Number.isFinite(n)) return { state: "failed" };
  return { state: "ready", text: formatShekel(n, locale), zero: n === 0, mixed: load.value.mixed, exact: true };
}

export function countMetric(load: Load<CountClaim>): MetricValue {
  if (load.state !== "ready") return load;
  const { n, exact } = load.value;
  return { state: "ready", text: exact ? String(n) : `${n}+`, zero: exact && n === 0, mixed: false, exact };
}

/* ====================================================== service desk ===== */

/** The case statuses that mean "work still open" (not delivered / closed / cancelled / abandoned). */
export const OPEN_CASE_STATUSES = new Set([
  "OPEN", "SCHEDULED", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "QA", "READY",
]);

/** Open cases among the newest page; exact only when the page held every case (`nextBeforeId === null`). */
export function openCasesClaim(wire: { cases?: { status: string }[]; nextBeforeId?: number | null }): CountClaim {
  const n = (wire.cases ?? []).filter((c) => OPEN_CASE_STATUSES.has(c.status)).length;
  return { n, exact: (wire.nextBeforeId ?? null) === null };
}

/* ========================================================== secretary ===== */

const KIND_REQ: Record<WaitingKind, Requirement> = {
  payment: { scope: "money" },
  collection: { modules: ["billing"], scope: "money" },
  stock: { modules: ["inventory"], scope: "operations" },
  lead: { scope: "customers" },
  intake: { scope: "customers" },
};

/** The list each kind opens when there is more than one item. */
const KIND_LIST_HREF: Record<WaitingKind, string | null> = {
  payment: "/secretary?today=1",
  lead: "/leads?view=needsAction",
  stock: "/inventory",
  collection: "/collection",
  intake: null,
};

/** Kinds whose items must stay in view until handled: they can only be put off until tomorrow, never dismissed. */
const LATER_ONLY: ReadonlySet<WaitingKind> = new Set<WaitingKind>(["payment"]);

/** Per group: "not relevant" holds while the same items are waiting; "later" holds for the rest of the Israeli day. */
export type SecretaryDismissals = Record<string, { mode: "dismiss" } | { mode: "later"; day: string }>;

export type SecretaryView =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "first" }
  | { state: "calm"; exact: boolean }
  | {
      state: "ready";
      kind: WaitingKind;
      title: string;
      body: string;
      cta: string;
      href: string;
      /** Every update the person may see (the chip), with its exactness. */
      updates: CountClaim;
      /** The key the dismissal is stored under — changes when the waiting items change. */
      groupKey: string;
      dismissMode: "dismiss" | "later";
    };

/**
 * Keep the stored dismissals small: a "later" from a past day no longer holds, and only the newest "not relevant"
 * entries are kept (an old one refers to a group of items that has long changed anyway).
 */
export function pruneDismissals(d: SecretaryDismissals, today: string, keep = 30): SecretaryDismissals {
  const entries = Object.entries(d).filter(([, v]) => v.mode === "dismiss" || v.day === today);
  return Object.fromEntries(entries.slice(-keep));
}

export function groupKeyOf(kind: WaitingKind, items: WaitingItem[]): string {
  return `${kind}:${items.map((i) => i.id).sort().join(",")}`;
}

function isHidden(key: string, d: SecretaryDismissals, today: string): boolean {
  const entry = d[key];
  if (!entry) return false;
  return entry.mode === "dismiss" || entry.day === today;
}

/** A brand-new business: nothing has ever happened in it (proven by history, never inferred from zeros). */
export function isBrandNew(history: HomeHistory | null): boolean {
  if (!history) return false;
  return !history.income && !history.collection && !history.documents && !history.leads && !history.conversations && !history.obligations;
}

export function buildSecretary(input: {
  waiting: Load<WaitingModel>;
  /** Some source behind `waiting` failed: what is shown is what could be read. */
  partial: boolean;
  access: HomeAccess;
  history: HomeHistory | null;
  dismissals: SecretaryDismissals;
  now: Date;
  t: Translator;
}): SecretaryView {
  const { waiting, access, t } = input;
  if (waiting.state !== "ready") return waiting;
  const today = israelDateKey(input.now);

  const visible = waiting.value.items.filter((i) => allows(access, KIND_REQ[i.kind]));
  const visibleKinds = new Set(visible.map((i) => i.kind));
  const updates: CountClaim = {
    n: visible.length,
    exact: !input.partial && [...visibleKinds].every((k) => waiting.value.byKind[k].exact),
  };

  // Groups in the order of their most urgent item (the list is already ranked).
  const groups = new Map<WaitingKind, WaitingItem[]>();
  for (const item of visible) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);

  for (const [kind, items] of groups) {
    const key = groupKeyOf(kind, items);
    if (isHidden(key, input.dismissals, today)) continue;
    const claim = waiting.value.byKind[kind];
    const count = items.length;
    const k = `home.v4.secretary.kind.${kind}` as const;
    const title = count === 1 && claim.exact ? t(`${k}.one` as MessageKey) : t(`${k}.many` as MessageKey, { count: claim.exact ? count : cappedText(count) });
    const href = count === 1 ? items[0].href : KIND_LIST_HREF[kind] ?? items[0].href;
    return {
      state: "ready",
      kind,
      title,
      body: t(`${k}.body` as MessageKey),
      cta: t(`${k}.cta` as MessageKey),
      href,
      updates,
      groupKey: key,
      dismissMode: LATER_ONLY.has(kind) ? "later" : "dismiss",
    };
  }

  if (visible.length === 0 && isBrandNew(input.history)) return { state: "first" };
  // Calm is claimed only when nothing was cut and every source answered; otherwise "I found nothing" (unsure).
  return { state: "calm", exact: updates.exact };
}

/* ============================================================== today ===== */

export type TodayAppointment = {
  id: number;
  status: string;
  kind: string;
  startsAt: string | null;
  endsAt: string | null;
  title: string | null;
  customerName?: string | null;
};

export type TodayTask = { id: number; title: string; dueOn: string | null; dueMinute?: number | null; bucket: string };

/** A source the area may use: off (module not active / not permitted), or a load. */
export type Source<T> = { state: "off" } | Load<T>;

export type TodayEntry = {
  id: string;
  type: "meeting" | "task";
  /** "11:30", or null for an item with no time of day. */
  time: string | null;
  title: string;
  subtitle: string | null;
  href: string;
};

export type TodayView =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "ready";
      next: TodayEntry | null;
      restMeetings: number;
      restTasks: number;
      /** One of the sources failed: what is shown is partial. */
      partial: boolean;
    };

const IL = "Asia/Jerusalem";

function hhmm(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: IL, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

function minuteLabel(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function israelMinuteOfDay(d: Date): number {
  const [h, m] = hhmm(d).split(":").map(Number);
  return (h === 24 ? 0 : h) * 60 + m;
}

const LIVE_APPOINTMENT = new Set(["PROPOSED", "CONFIRMED"]);

export function buildToday(input: {
  appointments: Source<TodayAppointment[]>;
  tasks: Source<TodayTask[]>;
  now: Date;
  t: Translator;
}): TodayView {
  const { appointments, tasks, now, t } = input;
  const sources = [appointments, tasks];
  if (sources.every((s) => s.state === "off")) return { state: "hidden" };
  const on = sources.filter((s) => s.state !== "off");
  if (on.some((s) => s.state === "loading")) return { state: "loading" };
  if (on.every((s) => s.state === "failed")) return { state: "failed" };

  const today = israelDateKey(now);
  const nowMs = now.getTime();
  const nowMinute = israelMinuteOfDay(now);

  type Ranked = TodayEntry & { sort: number };
  const meetings: Ranked[] = [];
  if (appointments.state === "ready") {
    for (const a of appointments.value) {
      if (!a.startsAt || !LIVE_APPOINTMENT.has(a.status) || a.kind === "BLOCK") continue;
      const start = new Date(a.startsAt);
      if (Number.isNaN(start.getTime()) || israelDateKey(start) !== today) continue;
      const end = a.endsAt ? new Date(a.endsAt).getTime() : start.getTime();
      if (end < nowMs) continue; // already over
      const who = a.customerName?.trim() || null;
      meetings.push({
        id: `appointment:${a.id}`,
        type: "meeting",
        time: hhmm(start),
        title: a.title?.trim() || (who ? who : t("home.v4.today.meeting")),
        subtitle: a.title?.trim() && who ? who : null,
        href: "/calendar",
        sort: start.getTime(),
      });
    }
  }

  const taskEntries: Ranked[] = [];
  if (tasks.state === "ready") {
    for (const task of tasks.value) {
      if (task.bucket !== "TODAY" && task.bucket !== "OVERDUE") continue;
      const timed = task.bucket === "TODAY" && typeof task.dueMinute === "number";
      // A timed task whose time has passed is no longer "coming up" — it still counts in the rest of the day.
      taskEntries.push({
        id: `task:${task.id}`,
        type: "task",
        time: timed ? minuteLabel(task.dueMinute as number) : null,
        title: task.title,
        subtitle: null,
        href: "/tasks",
        sort: timed && (task.dueMinute as number) >= nowMinute ? nowMs + ((task.dueMinute as number) - nowMinute) * 60_000 : Number.POSITIVE_INFINITY,
      });
    }
  }

  // The next item: the earliest timed thing still ahead; else the first untimed task of the day.
  const timedAhead = [...meetings, ...taskEntries.filter((e) => Number.isFinite(e.sort))].sort((a, b) => a.sort - b.sort);
  const nextRanked = timedAhead[0] ?? taskEntries[0] ?? null;
  const next: TodayEntry | null = nextRanked
    ? { id: nextRanked.id, type: nextRanked.type, time: nextRanked.time, title: nextRanked.title, subtitle: nextRanked.subtitle, href: nextRanked.href }
    : null;

  return {
    state: "ready",
    next,
    restMeetings: meetings.filter((m) => m.id !== next?.id).length,
    restTasks: taskEntries.filter((m) => m.id !== next?.id).length,
    partial: on.some((s) => s.state === "failed"),
  };
}

/** "בהמשך: עוד 2 פגישות ו־3 משימות" — or null when nothing else is planned. */
export function restOfDayLine(meetings: number, tasks: number, t: Translator): string | null {
  const parts: string[] = [];
  if (meetings > 0) parts.push(meetings === 1 ? t("home.v4.today.meetingsOne") : t("home.v4.today.meetingsMany", { count: meetings }));
  if (tasks > 0) {
    if (parts.length === 0) parts.push(tasks === 1 ? t("home.v4.today.tasksLeadOne") : t("home.v4.today.tasksLeadMany", { count: tasks }));
    else parts.push(tasks === 1 ? t("home.v4.today.tasksOne") : t("home.v4.today.tasksMany", { count: tasks }));
  }
  if (parts.length === 0) return null;
  return `${t("home.v4.today.restPrefix")} ${parts.join(t("home.v4.today.and"))}`;
}

/* ============================================================ for you ===== */

export type ForYouType = "quotes" | "recommendation" | "insight" | "activity" | "tool";
export const FOR_YOU_TYPES: readonly ForYouType[] = ["quotes", "recommendation", "insight", "activity", "tool"];

export type ForYouItem = {
  id: string;
  type: ForYouType;
  eyebrow: string | null;
  title: string;
  body: string | null;
  cta: string;
  href: string;
};

export type ForYouPrefs = { hiddenTypes: ForYouType[]; dismissedIds: string[] };

export type QuoteWire = { id: number; convertedToInvoice?: boolean; validUntil?: string | null };
export type RecommendationLite = { type: string; what: string; summary: string; href: string; id?: string };
export type InsightLite = { id?: number | string; title: string; body: string | null; href: string };

/** Quotes still waiting for the customer's answer: not converted, and not past their validity. */
export function waitingQuotes(quotes: QuoteWire[], now: Date): number {
  const today = israelDateKey(now);
  return quotes.filter((q) => !q.convertedToInvoice && (!q.validUntil || q.validUntil.slice(0, 10) >= today)).length;
}

type ToolIntro = { key: "documents" | "billing" | "appointments" | "leads"; req: Requirement; never: (h: HomeHistory) => boolean; href: string };

/** Tools a business already has, offered once it has never used them (history-proven). Never an upgrade. */
const TOOL_INTROS: ToolIntro[] = [
  { key: "documents", req: { modules: ["documents"], scope: "documents" }, never: (h) => !h.documents, href: "/documents/upload" },
  { key: "billing", req: { modules: ["billing"], scope: "money" }, never: (h) => !h.income && !h.collection, href: "/billing?create=1" },
  // No appointment history flag exists: the calendar is introduced only to a business that has never done anything.
  { key: "appointments", req: { modules: ["appointments"], scope: "operations" }, never: (h) => isBrandNew(h), href: "/calendar?new=1" },
  { key: "leads", req: { scope: "customers" }, never: (h) => !h.leads, href: "/leads?new=1" },
];

/** Which secretary kind would duplicate a For-you item. */
const RECOMMENDATION_DUPLICATES: Record<string, WaitingKind> = { SETTLE_OVERDUE_INSTALLMENT: "payment" };
const ACTIVITY_DUPLICATES: Record<string, WaitingKind> = { lead: "lead" };

export type ForYouView = { state: "loading" } | { state: "none" } | { state: "ready"; item: ForYouItem };

export function buildForYou(input: {
  access: HomeAccess;
  quotes: Source<QuoteWire[]>;
  recommendation: Source<RecommendationLite | null>;
  insight: Load<InsightLite | null>;
  activity: Load<ActivityItem[]>;
  history: Load<HomeHistory>;
  /** The kind the secretary is showing right now — never repeated here. */
  secretaryKind: WaitingKind | null;
  /** The kind of the business's "My day" entry — the appointments intro is skipped when the day already has some. */
  hasAppointmentsToday: boolean;
  prefs: ForYouPrefs;
  now: Date;
  t: Translator;
}): ForYouView {
  const { access, prefs, t } = input;
  const hidden = new Set(prefs.hiddenTypes);
  const dismissed = new Set(prefs.dismissedIds);
  const pending = (s: Source<unknown>) => s.state === "loading";
  // Wait for every source this area may draw from, so the item does not change under the person's finger.
  if ([input.quotes, input.recommendation, input.insight, input.activity, input.history].some(pending)) return { state: "loading" };

  const candidates: ForYouItem[] = [];

  if (!hidden.has("quotes") && input.quotes.state === "ready" && allows(access, { modules: ["business_documents"], scope: "money" })) {
    const n = waitingQuotes(input.quotes.value, input.now);
    if (n > 0) {
      candidates.push({
        id: `quotes:${n}`,
        type: "quotes",
        eyebrow: null,
        title: n === 1 ? t("home.v4.forYou.quotes.one") : t("home.v4.forYou.quotes.many", { count: n }),
        body: t("home.v4.forYou.quotes.body"),
        cta: t("home.v4.forYou.quotes.cta"),
        href: "/business-documents/quotes",
      });
    }
  }

  if (!hidden.has("recommendation") && input.recommendation.state === "ready" && input.recommendation.value) {
    const r = input.recommendation.value;
    if (RECOMMENDATION_DUPLICATES[r.type] !== input.secretaryKind) {
      candidates.push({ id: `recommendation:${r.id ?? r.type}`, type: "recommendation", eyebrow: null, title: r.what, body: r.summary || null, cta: t("home.v4.forYou.recommendationCta"), href: r.href });
    }
  }

  if (!hidden.has("insight") && input.insight.state === "ready" && input.insight.value) {
    const i = input.insight.value;
    candidates.push({ id: `insight:${i.id ?? i.title}`, type: "insight", eyebrow: null, title: i.title, body: i.body, cta: t("home.v4.forYou.insightCta"), href: i.href });
  }

  if (!hidden.has("activity") && input.activity.state === "ready") {
    const a = input.activity.value.find((x) => ACTIVITY_DUPLICATES[x.kind] !== input.secretaryKind);
    if (a) {
      candidates.push({ id: `activity:${a.id}`, type: "activity", eyebrow: t("home.v4.forYou.activityEyebrow"), title: a.title, body: a.detail, cta: t("home.v4.forYou.activityCta"), href: a.href });
    }
  }

  if (!hidden.has("tool") && input.history.state === "ready") {
    const h = input.history.value;
    for (const intro of TOOL_INTROS) {
      if (!allows(access, intro.req) || !intro.never(h)) continue;
      if (intro.key === "appointments" && input.hasAppointmentsToday) continue;
      const k = `home.v4.forYou.tool.${intro.key}` as const;
      candidates.push({
        id: `tool:${intro.key}`,
        type: "tool",
        eyebrow: t("home.v4.forYou.toolEyebrow"),
        title: t(`${k}.title` as MessageKey),
        body: t(`${k}.body` as MessageKey),
        cta: t(`${k}.cta` as MessageKey),
        href: intro.href,
      });
    }
  }

  // A brand-new business has no activity worth a card: the tool intro leads there.
  const brandNew = input.history.state === "ready" && isBrandNew(input.history.value);
  const ordered = brandNew ? [...candidates.filter((c) => c.type === "tool"), ...candidates.filter((c) => c.type !== "tool")] : candidates;
  const item = ordered.find((c) => !dismissed.has(c.id));
  return item ? { state: "ready", item } : { state: "none" };
}

/* ======================================================== create sheet ===== */

export type CreateAction = {
  key: string;
  labelKey: "task" | "appointment" | "invoice" | "paymentRequest" | "lead" | "customer" | "upload" | "commitment" | "product";
  href: string;
  icon: "task" | "calendar" | "invoice" | "payments" | "lead" | "customer" | "upload" | "secretary" | "inventory";
  req: Requirement;
};

/**
 * "+" owns creation: each entry STARTS something (a deep link that opens the real create flow). Listed only when
 * the module is ON and the person holds the scope; "coming soon" entries are not creation and are not listed.
 */
export const CREATE_ACTIONS: CreateAction[] = [
  { key: "task", labelKey: "task", href: "/tasks?new=1", icon: "task", req: { modules: ["daily_tasks"], scope: "operations" } },
  { key: "appointment", labelKey: "appointment", href: "/calendar?new=1", icon: "calendar", req: { modules: ["appointments"], scope: "operations" } },
  { key: "invoice", labelKey: "invoice", href: "/billing?create=1", icon: "invoice", req: { modules: ["billing"], scope: "money" } },
  { key: "payment-request", labelKey: "paymentRequest", href: "/collection/new", icon: "payments", req: { modules: ["billing"], scope: "money" } },
  { key: "lead", labelKey: "lead", href: "/leads?new=1", icon: "lead", req: { scope: "customers" } },
  { key: "customer", labelKey: "customer", href: "/customers?new=1", icon: "customer", req: { scope: "customers" } },
  { key: "upload", labelKey: "upload", href: "/documents/upload", icon: "upload", req: { modules: ["documents"], scope: "documents" } },
  { key: "commitment", labelKey: "commitment", href: "/secretary?screen=bank", icon: "secretary", req: { scope: "money" } },
  { key: "product", labelKey: "product", href: "/inventory/items/create", icon: "inventory", req: { modules: ["inventory"], scope: "operations" } },
];

/** Business kind decides only the ORDER of the permitted actions (what this business creates most comes first). */
const CREATE_FIRST: Record<BusinessKind, string[]> = {
  service: ["task", "invoice", "payment-request", "customer"],
  booking: ["appointment", "invoice", "payment-request", "customer"],
  sales: ["lead", "invoice", "payment-request", "customer"],
  general: ["invoice", "payment-request", "upload", "lead"],
};

export function createActionsFor(access: HomeAccess): CreateAction[] {
  const permitted = CREATE_ACTIONS.filter((a) => allows(access, a.req));
  const first = CREATE_FIRST[access.kind];
  const rank = (a: CreateAction) => {
    const i = first.indexOf(a.key);
    return i === -1 ? first.length + CREATE_ACTIONS.indexOf(a) : i;
  };
  return [...permitted].sort((a, b) => rank(a) - rank(b));
}

/* ============================================================== tools ===== */

export type ToolLite = { key: string; group: string; feature?: string; comingSoon?: boolean };

/** Map a tool's platform feature to a Home module (the tool registry tags only these). */
const TOOL_FEATURE_MODULE: Record<string, HomeModule> = {
  appointments: "appointments",
  service_desk: "service_desk",
  daily_tasks: "daily_tasks",
};

/**
 * The platform feature each registry tool depends on, for tools the registry does not tag itself (it tags only the
 * default-OFF ones). Every key is a real catalog key (platform-feature-catalog.ts); a tool absent here is core.
 */
const TOOL_KEY_MODULES: Record<string, HomeModule[]> = {
  invoices: ["billing"],
  collection: ["billing"],
  documents: ["documents"],
  "documents-email": ["documents"],
  uploads: ["documents"],
  conversations: ["inbox"],
  bots: ["starter_bot"],
  coupons: ["revenue"],
  inventory: ["inventory"],
  suppliers: ["inventory"],
};

/** The scope a tool family needs. */
const GROUP_SCOPE: Record<string, HomeScope> = { money: "money", customers: "customers", operations: "operations" };

/** Tools this business + person can open right now. Coming-soon and OFF-feature tools are not "available". */
export function availableTools<T extends ToolLite>(tools: readonly T[], access: HomeAccess): T[] {
  return tools.filter((tool) => {
    if (tool.comingSoon) return false;
    const scope = GROUP_SCOPE[tool.group] ?? "operations";
    const mod = tool.feature ? TOOL_FEATURE_MODULE[tool.feature] : undefined;
    if (tool.feature && !mod) return false; // an unknown feature is never assumed ON
    return allows(access, { scope, modules: [...(mod ? [mod] : []), ...(TOOL_KEY_MODULES[tool.key] ?? [])] });
  });
}

/** Capabilities that exist in Dubiz but are not active here — for "יכולות נוספות" only, never the workspace. */
export function inactiveTools<T extends ToolLite>(tools: readonly T[], access: HomeAccess): T[] {
  const available = new Set(availableTools(tools, access).map((t) => t.key));
  return tools.filter((t) => !available.has(t.key));
}

/** At or below this many tools the screen is one clean grid: no favourites strip, no search, no categories. */
export const SIMPLE_TOOLS_MAX = 8;

/**
 * Conversations and documents left the bottom bar (owner decision 18.11), so they lead every business's tools:
 * first in the default favourites and first in the simple grid. Then what the business kind uses most.
 */
export const BAR_LEAVERS = ["conversations", "documents"] as const;

const DEFAULT_FAVORITES: Record<BusinessKind, string[]> = {
  service: [...BAR_LEAVERS, "service-desk", "invoices", "collection", "customers"],
  booking: [...BAR_LEAVERS, "calendar", "customers", "invoices", "collection"],
  sales: [...BAR_LEAVERS, "leads", "customers", "invoices", "collection"],
  general: [...BAR_LEAVERS, "invoices", "collection", "customers"],
};

/** The simple grid's order: the tools that left the bar first, then the registry order. */
export function simpleToolOrder<T extends ToolLite>(available: readonly T[]): T[] {
  const lead = BAR_LEAVERS.map((k) => available.find((t) => t.key === k)).filter((t): t is T => Boolean(t));
  return [...lead, ...available.filter((t) => !lead.includes(t))];
}

export function favoriteTools<T extends ToolLite>(available: readonly T[], kind: BusinessKind, chosen: readonly string[] | null): T[] {
  const keys = chosen ?? DEFAULT_FAVORITES[kind];
  return keys.map((k) => available.find((t) => t.key === k)).filter((t): t is T => Boolean(t));
}
