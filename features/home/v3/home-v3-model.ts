/**
 * HOME v3 — the view-model behind the approved mobile / tablet / desktop Home.
 *
 * Pure functions only: every figure the three layouts draw is decided here,
 * from wire shapes the existing APIs already return, and nothing here can
 * invent a value. A source that failed stays "failed" all the way to the
 * screen; a count that a source may have cut is never presented as exact.
 *
 * What the money figures ARE (and the info affordance on the card says so):
 *   הכנסות  — payments collected and verified through Dubiz (PaymentTransaction
 *             PAID). Cash, cheques and transfers outside Dubiz are not in it.
 *   הוצאות  — payments recorded against the business's payables (cash out,
 *             booked on its Israeli paid date). Per DAY only: no source holds
 *             the hour an expense was paid, so the hourly chart draws no
 *             expense bars. TODO(future): hourly cash-out.
 *   נטו     — הכנסות − הוצאות, from exactly those two numbers, never estimated.
 */

import type { BriefingApi } from "@/lib/obligations/secretary-client";
import type { BusinessStatusItem } from "@/lib/business-status/types";
import { buildTodayRows } from "@/features/home/lib/home-model";
import { obligationHref } from "@/lib/navigation/home-routes";
import { HE_T } from "@/features/home/lib/home-i18n";
import { intlTag, type Locale } from "@/lib/i18n/config";
import { formatAmount } from "@/lib/i18n/format";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

/* ------------------------------------------------------------ load state -- */

export type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; value: T };

export const LOADING = { state: "loading" } as const;
export const FAILED = { state: "failed" } as const;
export function ready<T>(value: T): Load<T> {
  return { state: "ready", value };
}
export function valueOf<T>(load: Load<T>): T | null {
  return load.state === "ready" ? load.value : null;
}

/* ---------------------------------------------------------------- money -- */

/** "₪12,700" — whole shekels, grouped the way the references group them. Other locales use Intl. */
export function formatShekel(n: number, locale: Locale = "he"): string {
  const rounded = Math.round(Math.abs(n));
  if (locale !== "he") return formatAmount(n < 0 && rounded !== 0 ? -rounded : rounded, "ILS", { locale });
  return `${n < 0 && rounded !== 0 ? "−" : ""}₪${rounded.toLocaleString("en-US")}`;
}

/** The big net figure is drawn as "₪" + number; this is the number part. */
export function formatNumber(n: number): string {
  const rounded = Math.round(Math.abs(n));
  return `${n < 0 && rounded !== 0 ? "−" : ""}${rounded.toLocaleString("en-US")}`;
}

/**
 * Money in a currency other than ILS, carried BESIDE a ₪ figure that does not include it. The
 * server never adds currencies together (audit B2/B3); the screen shows the ₪ figure and marks
 * that other currencies exist, listing each one.
 */
export type OtherCurrencyAmount = { currency: string; total: string };

/** Every non-ILS entry of a wire `totalsByCurrency` (`total` or `amount`). Absent / malformed → []. */
export function otherCurrenciesOf(totals: unknown): OtherCurrencyAmount[] {
  if (!Array.isArray(totals)) return [];
  const out: OtherCurrencyAmount[] = [];
  for (const entry of totals) {
    if (!entry || typeof entry !== "object") continue;
    const { currency, total, amount } = entry as { currency?: unknown; total?: unknown; amount?: unknown };
    const value = typeof total === "string" ? total : typeof amount === "string" ? amount : null;
    if (typeof currency !== "string" || currency === "ILS" || value === null) continue;
    out.push({ currency, total: value });
  }
  return out;
}

/** "$300 · €50" — each currency in its own symbol, never converted or added. */
export function formatOtherCurrencies(others: readonly OtherCurrencyAmount[], locale: Locale = "he"): string {
  return others.map((o) => formatAmount(o.total, o.currency, { locale })).join(" · ");
}

export function toNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/* ----------------------------------------------------------- dates / time -- */

const IL = "Asia/Jerusalem";

/** "YYYY-MM-DD" of `d` on the Israeli calendar. */
export function israelDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IL, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function israelHour(d: Date): number {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: IL, hour: "2-digit", hour12: false }).format(d));
  return h === 24 ? 0 : h;
}

/** The Israeli calendar day `days` before `key` (keys are civil dates, so UTC maths is exact). */
export function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** "יום ה׳, 22 באוקטובר". */
export function formatLongDate(d: Date, locale: Locale = "he"): string {
  const weekday = new Intl.DateTimeFormat(intlTag(locale), { timeZone: IL, weekday: "short" }).format(d);
  const dayMonth = new Intl.DateTimeFormat(intlTag(locale), { timeZone: IL, day: "numeric", month: "long" }).format(d);
  return `${weekday}, ${dayMonth}`;
}

/** "09:24" today, "אתמול" yesterday, otherwise "3 באוק׳". */
export function formatWhen(iso: string, now: Date, t: Translator = HE_T, locale: Locale = "he"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const key = israelDateKey(d);
  const today = israelDateKey(now);
  if (key === today) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: IL, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  if (key === shiftDateKey(today, -1)) return t("home.model.yesterday");
  return new Intl.DateTimeFormat(intlTag(locale), { timeZone: IL, day: "numeric", month: "short" }).format(d);
}

/** The prominent date chip of an upcoming payment: month above, day below. */
export function dateChip(isoOrKey: string, locale: Locale = "he"): { month: string; day: string } | null {
  const d = new Date(isoOrKey.length === 10 ? `${isoOrKey}T12:00:00Z` : isoOrKey);
  if (Number.isNaN(d.getTime())) return null;
  return {
    month: new Intl.DateTimeFormat(intlTag(locale), { timeZone: IL, month: "short" }).format(d),
    day: new Intl.DateTimeFormat("en-GB", { timeZone: IL, day: "numeric" }).format(d),
  };
}

/* ------------------------------------------------------------- cashflow -- */

export type CashflowPeriod = "day" | "week" | "month";

/** The chart's hours, per the approved design: 06:00 → 21:00, one bar each. */
export const CHART_FIRST_HOUR = 6;
export const CHART_LAST_HOUR = 21;

export type CashflowBar = {
  key: string;
  /** "12:00" / "יום ג׳" — the column's own name, used for the readout and aria. */
  label: string;
  income: number;
  /** `null` when no source holds this bar's expenses (hours). */
  expense: number | null;
};

export type CashflowSeries = {
  period: CashflowPeriod;
  bars: CashflowBar[];
  /** The whole period's money in — including hours outside the drawn 06–21 window. */
  income: number;
  /** `null` when the expense source could not be read. */
  expense: number | null;
  /** Whether bars carry expenses at all (false for the hourly view). */
  expenseByBar: boolean;
  defaultIndex: number;
  /** Present only when money in another currency came in; `income` / bars never include it. */
  incomeOtherCurrencies?: OtherCurrencyAmount[];
};

export function netOf(series: Pick<CashflowSeries, "income" | "expense">): number | null {
  return series.expense === null ? null : series.income - series.expense;
}

function hourLabel(h: number): string {
  return `${h < 10 ? "0" : ""}${h}:00`;
}

/**
 * Today, by hour. `hours` is `/api/home/day`'s 24 Israeli hours of money
 * collected; expenses exist only as the day's total.
 */
export function buildDaySeries(input: {
  hours: string[];
  incomeTotal: string;
  expenseToday: string | null;
  now: Date;
  incomeOtherCurrencies?: OtherCurrencyAmount[];
}): CashflowSeries {
  const bars: CashflowBar[] = [];
  for (let h = CHART_FIRST_HOUR; h <= CHART_LAST_HOUR; h++) {
    bars.push({ key: `h${h}`, label: hourLabel(h), income: toNumber(input.hours[h]) ?? 0, expense: null });
  }
  const hour = israelHour(input.now);
  const clamped = Math.min(Math.max(hour, CHART_FIRST_HOUR), CHART_LAST_HOUR);
  return {
    period: "day",
    bars,
    income: toNumber(input.incomeTotal) ?? 0,
    expense: toNumber(input.expenseToday),
    expenseByBar: false,
    defaultIndex: clamped - CHART_FIRST_HOUR,
    ...(input.incomeOtherCurrencies?.length ? { incomeOtherCurrencies: input.incomeOtherCurrencies } : {}),
  };
}

function weekdayShort(locale: Locale): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(intlTag(locale), { timeZone: IL, weekday: "short" });
}

/**
 * The last seven Israeli days, today included. Income per day is the exact
 * difference of `/api/home/collection?period=week`'s cumulative points;
 * expenses per day are each day's own `/api/business-cost?date=` cash out.
 * Every day's expense must be known, or the week is not drawn at all.
 */
export function buildWeekSeries(input: {
  cumulativeIncome: string[];
  incomeTotal: string;
  dayKeys: string[];
  expenses: string[];
  locale?: Locale;
  incomeOtherCurrencies?: OtherCurrencyAmount[];
}): CashflowSeries | null {
  const { cumulativeIncome, dayKeys, expenses } = input;
  const weekday = weekdayShort(input.locale ?? "he");
  if (cumulativeIncome.length !== 7 || dayKeys.length !== 7 || expenses.length !== 7) return null;
  const bars: CashflowBar[] = [];
  let prev = 0;
  let expenseTotal = 0;
  for (let i = 0; i < 7; i++) {
    const cum = toNumber(cumulativeIncome[i]) ?? prev;
    const exp = toNumber(expenses[i]);
    if (exp === null) return null;
    expenseTotal += exp;
    bars.push({
      key: dayKeys[i],
      label: weekday.format(new Date(`${dayKeys[i]}T12:00:00Z`)),
      income: Math.max(0, cum - prev),
      expense: exp,
    });
    prev = cum;
  }
  return {
    period: "week",
    bars,
    income: toNumber(input.incomeTotal) ?? prev,
    expense: expenseTotal,
    expenseByBar: true,
    defaultIndex: 6,
    ...(input.incomeOtherCurrencies?.length ? { incomeOtherCurrencies: input.incomeOtherCurrencies } : {}),
  };
}

/** Bar height in px for an area of `areaPx`, on a scale shared by both directions. */
export function barScale(bars: CashflowBar[], incomeAreaPx: number, expenseAreaPx: number): number {
  const maxIncome = Math.max(0, ...bars.map((b) => b.income));
  const maxExpense = Math.max(0, ...bars.map((b) => b.expense ?? 0));
  const candidates: number[] = [];
  if (maxIncome > 0) candidates.push((incomeAreaPx - 2) / maxIncome);
  if (maxExpense > 0) candidates.push((expenseAreaPx - 2) / maxExpense);
  return candidates.length ? Math.min(...candidates) : 0;
}

export function barPx(value: number | null, scale: number): number {
  if (value === null || value <= 0 || scale <= 0) return 0;
  return Math.max(4, Math.round(value * scale));
}

const NICE_STEPS = [1, 2, 2.5, 5, 10];

function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of NICE_STEPS) if (s * exp >= v) return s * exp;
  return 10 * exp;
}

function niceFloor(v: number): number {
  if (v <= 0) return 0;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (let i = NICE_STEPS.length - 1; i >= 0; i--) if (NICE_STEPS[i] * exp <= v) return NICE_STEPS[i] * exp;
  return exp;
}

/** "2.5K" / "1K" / "800". */
export function compactAmount(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}${+(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1000) return `${sign}${+(a / 1000).toFixed(1)}K`;
  return `${sign}${Math.round(a)}`;
}

export type ChartAxis = {
  /** px per ₪, shared above and below zero. */
  scale: number;
  ticks: Array<{ value: number; label: string }>;
};

/**
 * The desktop chart's value axis: a round top value that fits both the highest
 * income bar (in `incomePx` above zero) and the highest expense bar (in
 * `expensePx` below it), a round middle tick, and a round tick below zero when
 * it fits. With nothing to draw it is a single zero line.
 */
export function chartAxis(bars: CashflowBar[], incomePx: number, expensePx: number): ChartAxis {
  const maxIncome = Math.max(0, ...bars.map((b) => b.income));
  const maxExpense = Math.max(0, ...bars.map((b) => b.expense ?? 0));
  const needed = Math.max(maxIncome, (maxExpense * incomePx) / expensePx);
  const top = niceCeil(needed);
  if (top === 0) return { scale: 0, ticks: [{ value: 0, label: "0" }] };
  const scale = incomePx / top;
  const mid = niceFloor(top * 0.4);
  const ticks = [
    { value: top, label: compactAmount(top) },
    ...(mid > 0 && mid < top ? [{ value: mid, label: compactAmount(mid) }] : []),
    { value: 0, label: "0" },
  ];
  if (mid > 0 && mid * scale <= expensePx - 6) ticks.push({ value: -mid, label: compactAmount(-mid) });
  return { scale, ticks };
}

/* -------------------------------------------------------------- waiting -- */

export type WaitingKind = "payment" | "stock" | "collection" | "lead";

/** Card palette, from the references: urgent (coral), todo (amber), fresh (teal). */
export type WaitingTone = "urgent" | "todo" | "fresh";

export type WaitingTag = { label: string; style: "urgentSolid" | "urgentSoft" | "todo" | "fresh" };

export type WaitingItem = {
  id: string;
  kind: WaitingKind;
  tone: WaitingTone;
  /** The card's tag on mobile / tablet (urgency). */
  tag: WaitingTag;
  title: string;
  subtitle: string | null;
  /** A formatted amount, only when the source carries one. */
  amount: string | null;
  href: string;
  actionLabel: string;
  /** Lower first. Ties keep source order. */
  rank: number;
};

export type CountClaim = { n: number; exact: boolean };

export type WaitingModel = {
  items: WaitingItem[];
  total: CountClaim;
  byKind: Record<WaitingKind, CountClaim>;
};

/** The business-status caps (lib/business-status/limits.ts) a domain list can hit. */
export const STATUS_CAPS = { global: 50, inventory: 15, leads: 8, payablesOverdue: 10, payablesDueSoon: 8 } as const;
/** `/api/collection/inbox` reads at most this many PENDING requests. */
export const COLLECTION_WAITING_CAP = 200;

export type CollectionWaitingWire = {
  requestId: number;
  customerName: string | null;
  invoiceNumber: string | null;
  amount: string;
  currency: string;
  createdAt: string;
};

// Fallback only, for an item that carries no `inventoryAlertType` (a payload from before the field existed):
// the Hebrew title prefix the inventory translator writes. The kind itself is language-independent.
const STOCK_TITLE = /^מלאי (קריטי|נמוך)/;
const CRITICAL_TITLE = /^מלאי קריטי/;

function stockAlertKind(s: BusinessStatusItem): "critical" | "low" | null {
  if (s.inventoryAlertType) {
    return s.inventoryAlertType === "CRITICAL_STOCK" ? "critical" : s.inventoryAlertType === "LOW_STOCK" ? "low" : null;
  }
  if (!STOCK_TITLE.test(s.title)) return null;
  return CRITICAL_TITLE.test(s.title) ? "critical" : "low";
}

function leadReason(itemId: string): string | null {
  const m = /^leads:([a-z_]+):/.exec(itemId);
  return m ? m[1] : null;
}

/**
 * "מה ממתין לך" — the four real kinds the Secretary can stand behind:
 *   payment     Secretary obligations due late / today / tomorrow (briefing)
 *               + payables installments overdue or due soon (business-status)
 *   stock       critical / low stock alerts (business-status inventory)
 *   collection  every PENDING payment request (collection inbox → waiting)
 *   lead        leads that need the owner (business-status leads)
 * Nothing else is shown here; everything else keeps its own screen.
 */
export function buildWaiting(input: {
  briefing: BriefingApi | null;
  status: BusinessStatusItem[] | null;
  collectionWaiting: CollectionWaitingWire[] | null;
  now: Date;
  t?: Translator;
  locale?: Locale;
}): WaitingModel {
  const t = input.t ?? HE_T;
  const locale = input.locale ?? "he";
  const urgentTag: WaitingTag = { label: t("home.model.tag.urgent"), style: "urgentSolid" };
  const toPayTag: WaitingTag = { label: t("home.model.tag.toPay"), style: "urgentSoft" };
  const todoTag: WaitingTag = { label: t("home.model.tag.todo"), style: "todo" };
  const handle = t("home.model.actionHandle");
  const items: WaitingItem[] = [];
  const statusComplete = input.status !== null && input.status.length < STATUS_CAPS.global;

  // payment — Secretary obligations
  if (input.briefing) {
    for (const row of buildTodayRows(input.briefing, input.now, t)) {
      const urgent = row.badge === "late" || row.badge === "today";
      items.push({
        id: `obligation:${row.obligationId}`,
        kind: "payment",
        tone: "urgent",
        tag: urgent ? urgentTag : toPayTag,
        title: row.title,
        subtitle: t("home.model.paymentSubtitle"),
        amount: formatShekelString(row.amount, row.currency, locale),
        href: obligationHref(row.obligationId),
        actionLabel: handle,
        rank: urgent ? 0 : 2,
      });
    }
  }

  let payablesOverdue = 0;
  let payablesDueSoon = 0;
  let stockCount = 0;

  for (const s of input.status ?? []) {
    if (s.domain === "payables") {
      const overdue = s.itemId.startsWith("payables:overdue:");
      if (overdue) payablesOverdue++;
      else payablesDueSoon++;
      items.push({
        id: s.itemId,
        kind: "payment",
        tone: "urgent",
        tag: overdue ? urgentTag : toPayTag,
        title: s.title,
        subtitle: s.summary,
        amount: null,
        href: s.primaryAction.href,
        actionLabel: handle,
        rank: overdue ? 0 : 2,
      });
    } else if (s.domain === "inventory" && stockAlertKind(s) !== null) {
      stockCount++;
      const critical = stockAlertKind(s) === "critical";
      items.push({
        id: s.itemId,
        kind: "stock",
        tone: "todo",
        tag: todoTag,
        title: s.title,
        subtitle: s.summary,
        amount: null,
        href: s.primaryAction.href,
        actionLabel: handle,
        rank: critical ? 1 : 3,
      });
    } else if (s.domain === "leads") {
      const fresh = leadReason(s.itemId) === "new_unhandled";
      items.push({
        id: s.itemId,
        kind: "lead",
        tone: "fresh",
        tag: fresh ? { label: t("home.model.tag.fresh"), style: "fresh" } : todoTag,
        title: s.title,
        subtitle: s.summary,
        amount: null,
        href: s.primaryAction.href,
        actionLabel: t("home.model.actionView"),
        rank: 2,
      });
    }
  }

  for (const w of input.collectionWaiting ?? []) {
    items.push({
      id: `collection:${w.requestId}`,
      kind: "collection",
      tone: "fresh",
      tag: { label: t("home.model.tag.waiting"), style: "fresh" },
      title: t("home.model.collectionTitle"),
      subtitle: w.customerName?.trim()
        ? t("home.model.customer", { name: w.customerName.trim() })
        : w.invoiceNumber
          ? t("home.model.invoice", { number: w.invoiceNumber })
          : null,
      amount: formatShekelString(w.amount, w.currency, locale),
      href: "/collection",
      actionLabel: handle,
      rank: 2,
    });
  }

  const ordered = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.rank - b.item.rank || a.i - b.i)
    .map(({ item }) => item);

  const obligationsKnown = input.briefing !== null;
  const count = (kind: WaitingKind) => ordered.filter((i) => i.kind === kind).length;
  const byKind: Record<WaitingKind, CountClaim> = {
    payment: {
      n: count("payment"),
      exact:
        obligationsKnown &&
        statusComplete &&
        payablesOverdue < STATUS_CAPS.payablesOverdue &&
        payablesDueSoon < STATUS_CAPS.payablesDueSoon,
    },
    stock: { n: count("stock"), exact: statusComplete && stockCount < STATUS_CAPS.inventory },
    collection: {
      n: count("collection"),
      exact: input.collectionWaiting !== null && input.collectionWaiting.length < COLLECTION_WAITING_CAP,
    },
    lead: leadsWaitingClaim(input.status),
  };
  const total: CountClaim = {
    n: ordered.length,
    exact: Object.values(byKind).every((c) => c.exact),
  };
  return { items: ordered, total, byKind };
}

/**
 * Leads waiting for the owner — the ONE definition the Home uses everywhere
 * ("מה מחכה" chips and cards, and the sidebar's לידים badge): the lead items of
 * /api/business-status, which the canonical `evaluateLeadAttention` produces
 * (follow-up overdue / due today, new and untouched, customer wrote, awaiting
 * an owner decision, quote with no activity, stalled). Exact only when neither
 * the leads cap nor the global cap could have cut the list.
 */
export function leadsWaitingClaim(status: BusinessStatusItem[] | null): CountClaim {
  if (status === null) return { n: 0, exact: false };
  const n = status.filter((s) => s.domain === "leads").length;
  return { n, exact: status.length < STATUS_CAPS.global && n < STATUS_CAPS.leads };
}

/** "5" when the count is proven whole, "5+" when a source may have cut it. */
export function countText(c: CountClaim): string {
  return c.exact ? String(c.n) : `${c.n}+`;
}

/** The desktop header line: "5 דברים מחכים לך, 2 מהם תשלומים". */
export function waitingSentence(model: WaitingModel, t: Translator = HE_T): string | null {
  const { total, byKind } = model;
  if (total.n === 0) return total.exact ? t("home.model.sentence.noneProven") : null;
  const head = total.exact
    ? total.n === 1
      ? t("home.model.sentence.one")
      : t("home.model.sentence.many", { count: total.n })
    : t("home.model.sentence.moreThan", { count: total.n });
  const payments = byKind.payment;
  if (payments.n === 0 || !payments.exact) return head;
  return payments.n === 1
    ? t("home.model.sentence.paymentOne", { head })
    : t("home.model.sentence.paymentMany", { head, count: payments.n });
}

function formatShekelString(amount: string, currency: string, locale: Locale = "he"): string | null {
  const n = toNumber(amount);
  if (n === null) return null;
  if (currency === "ILS" || !currency) return formatShekel(n, locale);
  if (locale !== "he") return formatAmount(Math.round(n), currency, { locale });
  return `${Math.round(n).toLocaleString("en-US")} ${currency}`;
}

/* ------------------------------------------------------------- activity -- */

export type ActivityKind = "collected" | "lead" | "document";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  at: string;
  href: string;
};

export type PaidWire = {
  requestId: number;
  customerName: string | null;
  invoiceNumber: string | null;
  amount: string;
  currency: string;
  paidAt: string | null;
};

export type LeadWire = {
  id: number;
  name: string | null;
  status: string;
  sourceChannel: string | null;
  phone: string | null;
  createdAt: string;
};

export type DocumentWire = {
  documentId: number;
  createdAt: string;
  status: string;
  source: string | null;
  extracted: { amount: number | string | null; vendorName: string | null; direction?: string | null } | null;
};

export const SOURCE_LABEL: Record<string, string> = {
  email: "מהמייל",
  whatsapp: "WhatsApp",
  file: "העלאה",
};

const SOURCE_KEY: Record<string, MessageKey> = {
  email: "home.model.source.email",
  whatsapp: "home.model.source.whatsapp",
  file: "home.model.source.file",
};

/** The document source's label in the active language; null for an unknown source. */
export function sourceLabel(source: string | null | undefined, t: Translator = HE_T): string | null {
  const key = source ? SOURCE_KEY[source] : undefined;
  return key ? t(key) : null;
}

/**
 * "פעולות אחרונות" — events that already exist as rows, each with its own
 * timestamp: money that was collected and verified, leads that were created,
 * documents that came in. Newest first. No audit events, no inferred actions.
 */
export function buildActivity(input: {
  paid: PaidWire[] | null;
  leads: LeadWire[] | null;
  documents: DocumentWire[] | null;
  limit: number;
  t?: Translator;
  locale?: Locale;
}): ActivityItem[] {
  const t = input.t ?? HE_T;
  const locale = input.locale ?? "he";
  const out: ActivityItem[] = [];
  for (const p of input.paid ?? []) {
    if (!p.paidAt) continue;
    const amount = formatShekelString(p.amount, p.currency, locale);
    out.push({
      id: `paid:${p.requestId}`,
      kind: "collected",
      title: t("home.model.activity.collected"),
      detail: [p.invoiceNumber ? t("home.model.invoice", { number: p.invoiceNumber }) : null, p.customerName?.trim() || null, amount]
        .filter(Boolean)
        .join(" · ") || null,
      at: p.paidAt,
      href: "/collection",
    });
  }
  for (const l of input.leads ?? []) {
    out.push({
      id: `lead:${l.id}`,
      kind: "lead",
      title: t("home.model.activity.lead"),
      detail: l.name?.trim() || l.phone || null,
      at: l.createdAt,
      href: `/leads/${l.id}`,
    });
  }
  for (const d of input.documents ?? []) {
    const amount = toNumber(d.extracted?.amount ?? null);
    out.push({
      id: `doc:${d.documentId}`,
      kind: "document",
      title: t("home.model.activity.document"),
      detail:
        [d.extracted?.vendorName?.trim() || null, amount !== null ? formatShekel(amount, locale) : null, sourceLabel(d.source, t)]
          .filter(Boolean)
          .join(" · ") || null,
      at: d.createdAt,
      href: d.status === "needs_review" ? `/documents/review/${d.documentId}` : "/documents",
    });
  }
  return out
    .filter((a) => !Number.isNaN(new Date(a.at).getTime()))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, input.limit);
}

/* ----------------------------------------------------- upcoming payments -- */

export type UpcomingWire = { title: string; dueDate: string; amount: string };

export type UpcomingRow = UpcomingWire & {
  /** Due before the cost engine's own "today" (asOf) and still unpaid. */
  overdue: boolean;
};

/**
 * "התחייבויות קרובות" — still-unpaid payments already past their date first
 * (the engine's `overdue` window: recorded, due before asOf), then the next 30
 * days. Overdue is read from the data that already exists — the window it came
 * from and its date against the engine's asOf — never re-derived or stored.
 */
export function buildUpcomingRows(
  cost: { asOf: string; upcoming: { overdue: { items: UpcomingWire[] }; next30Days: { items: UpcomingWire[] } } },
  limit: number,
): UpcomingRow[] {
  const overdue = cost.upcoming.overdue.items.map((i) => ({ ...i, overdue: true }));
  const coming = cost.upcoming.next30Days.items.map((i) => ({ ...i, overdue: i.dueDate < cost.asOf }));
  return [...overdue, ...coming].slice(0, limit);
}

/* ------------------------------------------------------------ inventory -- */

export type InventoryItemWire = {
  id: number;
  name: string;
  currentQuantity: number;
  minimumQuantity: number;
  unitType: string;
  isActive: boolean;
  updatedAt: string;
  alerts?: Array<{ type: string; isResolved?: boolean }>;
};

export type StockRow = {
  id: number;
  name: string;
  quantityText: string;
  state: "critical" | "low" | "ok";
  /** 0–1 of the threshold-based scale: full bar = twice the minimum. */
  fill: number;
  updatedToday: boolean;
};

const UNIT_KEY: Record<string, MessageKey> = {
  UNIT: "home.model.unit.UNIT",
  ML: "home.model.unit.ML",
  GRAM: "home.model.unit.GRAM",
  KG: "home.model.unit.KG",
  LITER: "home.model.unit.LITER",
  BOX: "home.model.unit.BOX",
};

/**
 * "מצב המלאי" — only items that HAVE a threshold can be drawn on the
 * threshold scale (full bar = 2 × minimumQuantity, clamped). Most pressing first.
 */
export function buildStockRows(items: InventoryItemWire[], now: Date, limit: number, t: Translator = HE_T): StockRow[] {
  const today = israelDateKey(now);
  return items
    .filter((i) => i.isActive && i.minimumQuantity > 0)
    .sort((a, b) => a.currentQuantity / a.minimumQuantity - b.currentQuantity / b.minimumQuantity)
    .slice(0, limit)
    .map((i): StockRow => {
      const open = (i.alerts ?? []).filter((a) => a.isResolved !== true);
      const state: StockRow["state"] = open.some((a) => a.type === "CRITICAL_STOCK")
        ? "critical"
        : open.some((a) => a.type === "LOW_STOCK") || i.currentQuantity <= i.minimumQuantity
          ? "low"
          : "ok";
      const qty = Number.isInteger(i.currentQuantity) ? String(i.currentQuantity) : i.currentQuantity.toFixed(1);
      return {
        id: i.id,
        name: i.name,
        quantityText: `${qty} ${UNIT_KEY[i.unitType] ? t(UNIT_KEY[i.unitType]) : ""}`.trim(),
        state,
        fill: Math.min(1, Math.max(0, i.currentQuantity / (2 * i.minimumQuantity))),
        updatedToday: israelDateKey(new Date(i.updatedAt)) === today,
      };
    });
}

/* --------------------------------------------------------- conversations -- */

export const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  EMAIL: "אימייל",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  PHONE: "טלפון",
  OTHER: "ערוץ אחר",
};

const CHANNEL_KEY: Record<string, MessageKey> = {
  WHATSAPP: "home.model.channel.WHATSAPP",
  EMAIL: "home.model.channel.EMAIL",
  INSTAGRAM: "home.model.channel.INSTAGRAM",
  FACEBOOK: "home.model.channel.FACEBOOK",
  PHONE: "home.model.channel.PHONE",
  OTHER: "home.model.channel.OTHER",
};

/** A conversation channel's label in the active language; the raw channel when unknown. */
export function channelLabel(channel: string, t: Translator = HE_T): string {
  const key = CHANNEL_KEY[channel];
  return key ? t(key) : channel;
}
