/**
 * How the Payables list is grouped, filtered and searched. Pure, so it is
 * proven against real rows (`npm run verify:payables-list`).
 *
 * Nothing here computes money or a status:
 *   - each row's state is the server's (`attention`, `next.state`);
 *   - "המועד עבר" is a DATE fact — the next unpaid installment's due day is
 *     before today (Israel calendar). It exists so a partly-paid installment
 *     whose date passed (server state PARTIALLY_PAID) is not filed under
 *     "upcoming". It reconciles with the cost engine's "באיחור" (recorded due
 *     dates before today with money left) without deriving a new status.
 */

import type { CommitmentListApi } from "@/lib/payables/payables-client";
import { civilDaysFromToday } from "@/components/finance-ui/format";

export type ListGroupKey = "PASSED" | "DUE" | "PLANNED" | "DONE";
export type ListFilter = "open" | "passed" | "recurring" | "oneoff" | "plan";

export const GROUP_TITLE: Record<ListGroupKey, string> = {
  PASSED: "המועד עבר",
  DUE: "לתשלום בקרוב",
  PLANNED: "מתוכנן",
  DONE: "שולם / נסגר",
};

export const FILTER_LABEL: Record<ListFilter, string> = {
  open: "הכול",
  passed: "המועד עבר",
  recurring: "מתחדשות",
  oneoff: "חד-פעמיות",
  plan: "פריסות",
};

export function nextDuePassed(row: CommitmentListApi, now: Date): boolean {
  if (!row.next) return false;
  if (row.next.state === "PAID" || row.next.state === "CANCELLED" || row.next.state === "SETTLED_LEGACY") return false;
  if (Number(row.next.remaining) <= 0) return false;
  const days = civilDaysFromToday(row.next.dueAt, now);
  return days !== null && days < 0;
}

export function groupOf(row: CommitmentListApi, now: Date): ListGroupKey {
  if (nextDuePassed(row, now)) return "PASSED";
  const state = row.next?.state ?? row.attention;
  if (state === "OVERDUE" || state === "DUE" || state === "PARTIALLY_PAID") return "DUE";
  if (state === "SCHEDULED") return "PLANNED";
  return "DONE";
}

export function matchesFilter(row: CommitmentListApi, filter: ListFilter, now: Date): boolean {
  switch (filter) {
    case "passed":
      return nextDuePassed(row, now);
    case "recurring":
      return row.scheduleKind === "RECURRING";
    case "oneoff":
      return row.scheduleKind === "ONE_OFF";
    case "plan":
      return row.scheduleKind === "INSTALLMENT_PLAN";
    case "open":
    default:
      return true;
  }
}

export function matchesQuery(row: CommitmentListApi, query: string): boolean {
  const q = query.trim().toLocaleLowerCase("he-IL");
  if (!q) return true;
  return row.title.toLocaleLowerCase("he-IL").includes(q) || row.payeeNameSnapshot.toLocaleLowerCase("he-IL").includes(q);
}

export function groupRows(rows: CommitmentListApi[], now: Date): Array<{ key: ListGroupKey; title: string; rows: CommitmentListApi[] }> {
  const order: ListGroupKey[] = ["PASSED", "DUE", "PLANNED", "DONE"];
  return order
    .map((key) => ({ key, title: GROUP_TITLE[key], rows: rows.filter((r) => groupOf(r, now) === key) }))
    .filter((g) => g.rows.length > 0);
}

export function filterCounts(rows: CommitmentListApi[], now: Date): Record<ListFilter, number> {
  const filters: ListFilter[] = ["open", "passed", "recurring", "oneoff", "plan"];
  return Object.fromEntries(filters.map((f) => [f, rows.filter((r) => matchesFilter(r, f, now)).length])) as Record<ListFilter, number>;
}
