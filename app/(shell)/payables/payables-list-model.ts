/**
 * Payables list — grouping, quick filter and search over rows the server
 * already returned.
 *
 * Pure on purpose: no fetch, no clock of its own, no money. The caller hands in
 * the Israel calendar day it considers "today", so every rule here is testable
 * and the screen can never disagree with the cost engine about what is late.
 *
 * Nothing in this module adds, subtracts or compares amounts. A group header
 * states how MANY rows it holds, never how much they are worth — a total
 * summed in the browser is a second balance that will eventually disagree with
 * the server's.
 */

import type { CommitmentListApi, ScheduleKind } from "@/lib/payables/payables-client";
import { dayKeyIsBefore, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

export type PayablesGroupKey = "OVERDUE" | "UPCOMING" | "PLANNED" | "CLOSED";
export type PayablesFilter = "ALL" | "OVERDUE" | ScheduleKind;

export const GROUP_ORDER: PayablesGroupKey[] = ["OVERDUE", "UPCOMING", "PLANNED", "CLOSED"];

export const GROUP_LABEL: Record<PayablesGroupKey, string> = {
  OVERDUE: "המועד עבר",
  UPCOMING: "מועדים קרובים",
  PLANNED: "מתוכנן",
  CLOSED: "שולם / נסגר",
};

export const FILTER_ORDER: PayablesFilter[] = ["ALL", "OVERDUE", "RECURRING", "ONE_OFF", "INSTALLMENT_PLAN"];

export const FILTER_LABEL: Record<PayablesFilter, string> = {
  ALL: "הכול",
  OVERDUE: "המועד עבר",
  RECURRING: "מתחדשות",
  ONE_OFF: "חד־פעמיות",
  INSTALLMENT_PLAN: "פריסות",
};

/**
 * Nothing left to do: the commitment was ended, or no instalment still wants
 * money. Mirrors the cost engine, which never counts a CLOSED or RELEASED
 * commitment as owed.
 */
export function isClosedRow(row: CommitmentListApi): boolean {
  return row.status !== "ACTIVE" || row.next === null;
}

/**
 * Late means the next open instalment fell on an Israeli calendar day BEFORE
 * today. Due today is not late. A partly-paid instalment past its day is late
 * too — the server labels it "שולם חלקית", but the money is still owed.
 */
export function isOverdueRow(row: CommitmentListApi, today: JerusalemDayKey): boolean {
  if (isClosedRow(row) || !row.next) return false;
  return dayKeyIsBefore(jerusalemDayKey(new Date(row.next.dueAt)), today);
}

export function groupOf(row: CommitmentListApi, today: JerusalemDayKey): PayablesGroupKey {
  if (isClosedRow(row)) return "CLOSED";
  if (isOverdueRow(row, today)) return "OVERDUE";
  return row.next?.state === "SCHEDULED" ? "PLANNED" : "UPCOMING";
}

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase("he-IL");
}

/** By the commitment's name or the payee's — nothing else is searched. */
export function matchesSearch(row: CommitmentListApi, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  return normalize(row.title).includes(q) || normalize(row.payeeNameSnapshot).includes(q);
}

export function matchesFilter(row: CommitmentListApi, filter: PayablesFilter, today: JerusalemDayKey): boolean {
  if (filter === "ALL") return true;
  if (filter === "OVERDUE") return isOverdueRow(row, today);
  return row.scheduleKind === filter;
}

export type PayablesListGroup = { key: PayablesGroupKey; label: string; rows: CommitmentListApi[] };

export type PayablesListView = {
  /** Non-empty groups only, in GROUP_ORDER; each keeps the server's order. */
  groups: PayablesListGroup[];
  /** Rows per chip, after search and the closed toggle — before the chip itself. */
  counts: Record<PayablesFilter, number>;
  /** The rows in display order, flattened (first one is the default selection). */
  visible: CommitmentListApi[];
  /** Rows the closed toggle allows, before search and chips. */
  inScope: number;
};

export function buildPayablesList(input: {
  rows: CommitmentListApi[];
  today: JerusalemDayKey;
  query: string;
  filter: PayablesFilter;
  includeClosed: boolean;
}): PayablesListView {
  const { rows, today, query, filter, includeClosed } = input;
  // Mirrors the server's open scope (every ACTIVE commitment, fully paid ones included), so the
  // default view hides nothing the old list showed; a fully paid ACTIVE row sits under "שולם / נסגר".
  const scoped = rows.filter((row) => includeClosed || row.status === "ACTIVE");
  const searched = scoped.filter((row) => matchesSearch(row, query));

  const counts = Object.fromEntries(
    FILTER_ORDER.map((f) => [f, searched.filter((row) => matchesFilter(row, f, today)).length]),
  ) as Record<PayablesFilter, number>;

  const shown = searched.filter((row) => matchesFilter(row, filter, today));
  const groups = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABEL[key],
    rows: shown.filter((row) => groupOf(row, today) === key),
  })).filter((g) => g.rows.length > 0);

  return { groups, counts, visible: groups.flatMap((g) => g.rows), inScope: scoped.length };
}
