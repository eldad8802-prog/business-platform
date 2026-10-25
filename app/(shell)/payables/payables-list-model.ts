/**
 * Payables list — grouping and the two filters (state, type) over rows the server already returned
 * (owner-approved redesign, 25.10.2026).
 *
 * Pure on purpose: no fetch, no clock of its own, no money. The caller hands in the Israel calendar day it
 * considers "today" and the instant it loaded the rows, so every rule here is testable and the screen can never
 * disagree with the cost engine about what is late.
 *
 * Nothing in this module adds, subtracts or compares amounts. A group header states how MANY rows it holds,
 * never how much they are worth — a total summed in the browser is a second balance that will eventually
 * disagree with the server's.
 *
 * Groups (presentation only — no state is changed to fit them):
 *   OVERDUE  — the next open instalment fell on an Israel day before today (partly paid too).
 *   UPCOMING — not late, and due within the server's attention window (7 days): the server's DUE, and a partly
 *              paid instalment by the same window.
 *   PLANNED  — not late, due later.
 *   CLOSED   — nothing left to do: ended, released, or no instalment still wants money. Each row says WHICH,
 *              from the server's own fields: שולם / טופל, בלי תשלום / לא רלוונטי / בוטל / הסתיים.
 */

import type { CommitmentListApi, ScheduleKind } from "@/lib/payables/payables-client";
import { daysBetweenDayKeys, dayKeyIsBefore, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

export type PayablesGroupKey = "OVERDUE" | "UPCOMING" | "PLANNED" | "CLOSED";
export type PayablesStateFilter = "ALL" | PayablesGroupKey;
export type PayablesTypeFilter = "ALL" | ScheduleKind;

export const GROUP_ORDER: PayablesGroupKey[] = ["OVERDUE", "UPCOMING", "PLANNED", "CLOSED"];

export const GROUP_LABEL: Record<PayablesGroupKey, string> = {
  OVERDUE: "באיחור",
  UPCOMING: "בקרוב",
  PLANNED: "מתוכנן",
  CLOSED: "שולם ונסגר",
};

export const STATE_FILTER_ORDER: PayablesStateFilter[] = ["ALL", ...GROUP_ORDER];
export const STATE_FILTER_LABEL: Record<PayablesStateFilter, string> = { ALL: "הכול", ...GROUP_LABEL };

export const TYPE_FILTER_ORDER: PayablesTypeFilter[] = ["ALL", "RECURRING", "ONE_OFF", "INSTALLMENT_PLAN"];
export const TYPE_FILTER_LABEL: Record<PayablesTypeFilter, string> = {
  ALL: "הכול",
  RECURRING: "חוזרות",
  ONE_OFF: "חד־פעמיות",
  INSTALLMENT_PLAN: "פריסות",
};

/** Groups open on arrival: what needs the owner first. The others fold until asked. */
export const OPEN_BY_DEFAULT: Record<PayablesGroupKey, boolean> = { OVERDUE: true, UPCOMING: true, PLANNED: false, CLOSED: false };

/** The server's attention window (payables-core deriveInstallmentBalance, attentionWindowDays = 7). */
export const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Nothing left to do: the commitment was ended, or no instalment still wants money. Mirrors the cost engine,
 * which never counts a CLOSED or RELEASED commitment as owed.
 */
export function isClosedRow(row: CommitmentListApi): boolean {
  return row.status !== "ACTIVE" || row.next === null;
}

/**
 * Late means the next open instalment fell on an Israeli calendar day BEFORE today. Due today is not late. A
 * partly-paid instalment past its day is late too — the server labels it "שולם חלקית", but the money is still
 * owed.
 */
export function isOverdueRow(row: CommitmentListApi, today: JerusalemDayKey): boolean {
  if (isClosedRow(row) || !row.next) return false;
  return dayKeyIsBefore(jerusalemDayKey(new Date(row.next.dueAt)), today);
}

export function groupOf(row: CommitmentListApi, today: JerusalemDayKey, now: Date): PayablesGroupKey {
  if (isClosedRow(row) || !row.next) return "CLOSED";
  if (isOverdueRow(row, today)) return "OVERDUE";
  // A partly paid instalment goes by its date, with the server's own window (owner, 25.10.2026); every other
  // state is the server's: DUE is within the window, SCHEDULED is beyond it.
  if (row.next.state === "PARTIALLY_PAID") {
    return new Date(row.next.dueAt).getTime() <= now.getTime() + ATTENTION_WINDOW_MS ? "UPCOMING" : "PLANNED";
  }
  return row.next.state === "SCHEDULED" ? "PLANNED" : "UPCOMING";
}

export function matchesType(row: CommitmentListApi, type: PayablesTypeFilter): boolean {
  return type === "ALL" || row.scheduleKind === type;
}

/** What a closed row is, in the server's own terms — never "paid" for something that was only handled. */
export type ClosedKind = "PAID" | "HANDLED" | "RELEASED" | "CANCELLED" | "ENDED";
export const CLOSED_LABEL: Record<ClosedKind, string> = {
  PAID: "שולם",
  HANDLED: "טופל, בלי תשלום",
  RELEASED: "לא רלוונטי",
  CANCELLED: "בוטל",
  ENDED: "הסתיים",
};

export function closedKindOf(row: CommitmentListApi): ClosedKind | null {
  if (!isClosedRow(row)) return null;
  if (row.status === "RELEASED") return "RELEASED";
  if (row.status === "ACTIVE" || row.next === null) {
    if (row.attention === "PAID") return "PAID";
    if (row.attention === "SETTLED_LEGACY") return "HANDLED";
    if (row.attention === "CANCELLED") return "CANCELLED";
  }
  return "ENDED";
}

export function isPartlyPaid(row: CommitmentListApi): boolean {
  return !isClosedRow(row) && row.next?.state === "PARTIALLY_PAID";
}

/** "באיחור 5 ימים" · "היום" · "מחר" · "בעוד 5 ימים" · "בעוד חודשיים" — Israel calendar days. */
export function relativeDue(dueAt: string, today: JerusalemDayKey): string {
  const days = daysBetweenDayKeys(today, jerusalemDayKey(new Date(dueAt)));
  if (days < 0) return days === -1 ? "באיחור יום אחד" : `באיחור ${-days} ימים`;
  if (days === 0) return "היום";
  if (days === 1) return "מחר";
  const months = Math.round(days / 30);
  if (months <= 1) return `בעוד ${days} ימים`;
  return months === 2 ? "בעוד חודשיים" : `בעוד ${months} חודשים`;
}

/**
 * The row's icon, from its name — the same everyday categories as the Secretary's "נגדיר את ההתחייבויות"
 * (ביטוח לאומי before ביטוח). A commitment has no category field and none is added; an unknown name gets 📄.
 */
const ICON_RULES: Array<[RegExp, string]> = [
  [/ביטוח לאומי/, "👥"],
  [/שכירות|שכ"ד|דירה|משרד/, "🏠"],
  [/ארנונה|עירייה|עיריית/, "🏛️"],
  [/חשמל/, "⚡"],
  [/מים|תאגיד/, "💧"],
  [/אינטרנט|בזק|סיבים/, "🌐"],
  [/טלפון|סלולר|פלאפון|פרטנר|סלקום|הוט|גולן/, "☎️"],
  [/ביטוח/, "🛡️"],
  [/רואה חשבון|רו"ח|הנהלת חשבונות/, "📊"],
  [/מע"מ|מעמ|מס הכנסה/, "🧾"],
];
export function iconFor(row: Pick<CommitmentListApi, "title" | "payeeNameSnapshot">): string {
  const text = `${row.title} ${row.payeeNameSnapshot}`;
  return ICON_RULES.find(([re]) => re.test(text))?.[1] ?? "📄";
}

export type PayablesListGroup = { key: PayablesGroupKey; label: string; rows: CommitmentListApi[] };

export type PayablesListView = {
  /** Groups in GROUP_ORDER that the state filter allows and that hold rows (after the type filter). */
  groups: PayablesListGroup[];
  /** Rows per state chip, after the type filter. */
  counts: Record<PayablesStateFilter, number>;
  /** Rows after both filters, in display order. */
  visible: CommitmentListApi[];
};

export function buildPayablesList(input: {
  rows: CommitmentListApi[];
  today: JerusalemDayKey;
  now: Date;
  state: PayablesStateFilter;
  type: PayablesTypeFilter;
}): PayablesListView {
  const { rows, today, now, state, type } = input;
  const typed = rows.filter((row) => matchesType(row, type));
  const byGroup = new Map<PayablesGroupKey, CommitmentListApi[]>(GROUP_ORDER.map((k) => [k, []]));
  for (const row of typed) byGroup.get(groupOf(row, today, now))!.push(row);

  const counts = { ALL: typed.length } as Record<PayablesStateFilter, number>;
  for (const k of GROUP_ORDER) counts[k] = byGroup.get(k)!.length;

  const groups = GROUP_ORDER.filter((k) => state === "ALL" || state === k)
    .map((key) => ({ key, label: GROUP_LABEL[key], rows: byGroup.get(key)! }))
    .filter((g) => g.rows.length > 0);

  return { groups, counts, visible: groups.flatMap((g) => g.rows) };
}
