/**
 * Verify — payables list grouping, quick filter and search.
 * Run: npm run verify:payables-list
 *
 * Pure: no database, no network, no clock (today is fixed). The decisive check
 * is the last one — the list's "המועד עבר" group must be exactly the set of
 * commitments the cost engine calls overdue for the same ledger, by the same
 * Israel-calendar-day rule, so the screen and the summary box never disagree.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type { CommitmentListApi, DerivedState, ScheduleKind } from "@/lib/payables/payables-client";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { overdueObligations } from "@/lib/services/business-cost/business-cost-intelligence";
import type { CostCommitment } from "@/lib/services/business-cost/business-cost-core";
import {
  FILTER_LABEL,
  GROUP_LABEL,
  buildPayablesList,
  groupOf,
  isOverdueRow,
  matchesSearch,
} from "./payables-list-model";

let checks = 0;
function ok(label: string, condition: boolean) {
  assert.ok(condition, label);
  checks += 1;
}
function eq<T>(label: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, `${label} (got ${JSON.stringify(actual)})`);
  checks += 1;
}

/* ─────────────────────────────── the ledger ─────────────────────────────── */

// 2026-10-22 12:00 in Israel.
const NOW = new Date("2026-10-22T09:00:00Z");
const TODAY = jerusalemDayKey(NOW);

type Inst = { id: number; seq: number; dueAt: string; amountMinor: number; paidMinor: number; state: DerivedState; status?: "SCHEDULED" | "CANCELLED" | "SETTLED_LEGACY" };
type Fixture = { id: number; title: string; payee: string; kind: ScheduleKind; status: "ACTIVE" | "CLOSED" | "RELEASED"; installments: Inst[] };

const LEDGER: Fixture[] = [
  // Late by a whole day.
  { id: 1, title: "ארנונה", payee: "עיריית חיפה", kind: "ONE_OFF", status: "ACTIVE", installments: [
    { id: 11, seq: 1, dueAt: "2026-10-20T21:00:00Z", amountMinor: 120050, paidMinor: 0, state: "OVERDUE" },
  ] },
  // Due TODAY in Israel (00:30) while still 21 October in UTC — not late. The
  // server's instant compare already says OVERDUE; the list must not.
  { id: 2, title: "חשמל", payee: "חברת החשמל", kind: "RECURRING", status: "ACTIVE", installments: [
    { id: 21, seq: 1, dueAt: "2026-10-21T21:30:00Z", amountMinor: 45000, paidMinor: 0, state: "OVERDUE" },
  ] },
  // Partly paid and past its day: still late.
  { id: 3, title: "רכב ליסינג", payee: "ליסינג בע״מ", kind: "INSTALLMENT_PLAN", status: "ACTIVE", installments: [
    { id: 31, seq: 1, dueAt: "2026-09-15T10:00:00Z", amountMinor: 100000, paidMinor: 100000, state: "PAID" },
    { id: 32, seq: 2, dueAt: "2026-10-15T10:00:00Z", amountMinor: 100000, paidMinor: 40000, state: "PARTIALLY_PAID" },
    { id: 33, seq: 3, dueAt: "2026-11-15T10:00:00Z", amountMinor: 100000, paidMinor: 0, state: "SCHEDULED" },
  ] },
  // Due in a few days.
  { id: 4, title: "שכירות", payee: "דוד כהן", kind: "RECURRING", status: "ACTIVE", installments: [
    { id: 41, seq: 1, dueAt: "2026-10-25T08:00:00Z", amountMinor: 650000, paidMinor: 0, state: "DUE" },
  ] },
  // Far ahead.
  { id: 5, title: "ביטוח עסק", payee: "הפניקס", kind: "RECURRING", status: "ACTIVE", installments: [
    { id: 51, seq: 1, dueAt: "2026-12-01T08:00:00Z", amountMinor: 30000, paidMinor: 0, state: "SCHEDULED" },
  ] },
  // Fully paid, still ACTIVE: nothing left to do.
  { id: 6, title: "רואה חשבון", payee: "משרד לוי", kind: "ONE_OFF", status: "ACTIVE", installments: [
    { id: 61, seq: 1, dueAt: "2026-10-01T08:00:00Z", amountMinor: 200000, paidMinor: 200000, state: "PAID" },
  ] },
  // Ended with an old open instalment: closed, and the engine never counts it.
  { id: 7, title: "ספק ישן", payee: "Supplier Ltd", kind: "INSTALLMENT_PLAN", status: "CLOSED", installments: [
    { id: 71, seq: 1, dueAt: "2026-09-01T08:00:00Z", amountMinor: 50000, paidMinor: 0, state: "OVERDUE" },
  ] },
  // Late by one minute of Israel's yesterday (23:59), same UTC day as #2.
  { id: 8, title: "אינטרנט", payee: "בזק", kind: "RECURRING", status: "ACTIVE", installments: [
    { id: 81, seq: 1, dueAt: "2026-10-21T20:59:00Z", amountMinor: 9990, paidMinor: 0, state: "OVERDUE" },
  ] },
  // A cancelled old instalment is not "next"; the open one is in the future.
  { id: 9, title: "הדברה", payee: "מדביר", kind: "INSTALLMENT_PLAN", status: "ACTIVE", installments: [
    { id: 91, seq: 1, dueAt: "2026-08-01T08:00:00Z", amountMinor: 20000, paidMinor: 0, state: "CANCELLED", status: "CANCELLED" },
    { id: 92, seq: 2, dueAt: "2026-10-27T08:00:00Z", amountMinor: 20000, paidMinor: 0, state: "DUE" },
  ] },
];

const minor = (n: number) => (n / 100).toFixed(2);

/** The list row the server would return — `next` as payables-read derives it. */
function toRow(f: Fixture): CommitmentListApi {
  const open = f.installments
    .filter((i) => (i.status ?? "SCHEDULED") === "SCHEDULED" && i.amountMinor - i.paidMinor > 0)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const n = open[0] ?? null;
  return {
    id: f.id,
    title: f.title,
    payeeId: null,
    payeeNameSnapshot: f.payee,
    currency: "ILS",
    scheduleKind: f.kind,
    status: f.status,
    total: null,
    paid: minor(f.installments.reduce((s, i) => s + i.paidMinor, 0)),
    remaining: null,
    installmentCount: f.installments.length,
    next: n ? { id: n.id, sequence: n.seq, dueAt: n.dueAt, scheduled: minor(n.amountMinor), remaining: minor(n.amountMinor - n.paidMinor), state: n.state } : null,
    attention: n ? n.state : "PAID",
    isLegacy: false,
  };
}

/** The same ledger as the cost engine reads it — due dates as Israel civil days. */
function toCost(f: Fixture): CostCommitment {
  return {
    source: "COMMITMENT",
    id: f.id,
    title: f.title,
    payeeName: f.payee,
    payeeKind: null,
    currency: "ILS",
    scheduleKind: f.kind,
    recurrence: f.kind === "RECURRING" ? "MONTHLY" : "NONE",
    recurrenceSeriesId: null,
    status: f.status,
    isLegacy: false,
    endDate: null,
    installments: f.installments.map((i) => ({
      id: i.id,
      sequence: i.seq,
      dueDate: jerusalemDayKey(new Date(i.dueAt)),
      amountMinor: i.amountMinor,
      currency: "ILS",
      status: i.status ?? "SCHEDULED",
      paidMinor: i.paidMinor,
    })),
  };
}

const ROWS = LEDGER.map(toRow);
const byId = (id: number) => ROWS.find((r) => r.id === id)!;
const ids = (rows: CommitmentListApi[]) => rows.map((r) => r.id);

function main() {
  eq("fixture today is the Israel day", TODAY, "2026-10-22");

  /* ── grouping ── */
  eq("late by a day → overdue", groupOf(byId(1), TODAY), "OVERDUE");
  eq("due today (Israel) → not overdue", groupOf(byId(2), TODAY), "UPCOMING");
  ok("due today is never late", !isOverdueRow(byId(2), TODAY));
  eq("partly paid past its day → overdue", groupOf(byId(3), TODAY), "OVERDUE");
  eq("DUE → upcoming", groupOf(byId(4), TODAY), "UPCOMING");
  eq("SCHEDULED → planned", groupOf(byId(5), TODAY), "PLANNED");
  eq("fully paid → closed", groupOf(byId(6), TODAY), "CLOSED");
  eq("ended commitment → closed, even with an old open instalment", groupOf(byId(7), TODAY), "CLOSED");
  eq("23:59 Israel yesterday → overdue", groupOf(byId(8), TODAY), "OVERDUE");
  eq("cancelled instalment is skipped for next", byId(9).next?.id, 92);
  eq("…and the commitment is upcoming", groupOf(byId(9), TODAY), "UPCOMING");

  const open = buildPayablesList({ rows: ROWS, today: TODAY, query: "", filter: "ALL", includeClosed: false });
  eq("ended hidden without the toggle; fully paid ACTIVE still shown (as the server's open scope)", open.groups.map((g) => g.key), ["OVERDUE", "UPCOMING", "PLANNED", "CLOSED"]);
  eq("open view: only the fully paid ACTIVE row under paid/closed", ids(open.groups[3].rows), [6]);
  eq("overdue keeps server order", ids(open.groups[0].rows), [1, 3, 8]);
  eq("upcoming keeps server order", ids(open.groups[1].rows), [2, 4, 9]);
  eq("in scope without closed", open.inScope, 8);
  eq("visible = groups flattened", ids(open.visible), [1, 3, 8, 2, 4, 9, 5, 6]);
  eq("group labels", open.groups.map((g) => g.label), ["המועד עבר", "מועדים קרובים", "מתוכנן", "שולם / נסגר"]);

  const all = buildPayablesList({ rows: ROWS, today: TODAY, query: "", filter: "ALL", includeClosed: true });
  eq("closed group appears with the toggle", all.groups.map((g) => g.key), ["OVERDUE", "UPCOMING", "PLANNED", "CLOSED"]);
  eq("closed group holds paid + ended", ids(all.groups[3].rows), [6, 7]);
  eq("closed label", all.groups[3].label, "שולם / נסגר");

  /* ── filters ── */
  eq("chip counts (open)", open.counts, { ALL: 8, OVERDUE: 3, RECURRING: 4, ONE_OFF: 2, INSTALLMENT_PLAN: 2 });
  eq("chip counts (incl. closed)", all.counts, { ALL: 9, OVERDUE: 3, RECURRING: 4, ONE_OFF: 2, INSTALLMENT_PLAN: 3 });
  const late = buildPayablesList({ rows: ROWS, today: TODAY, query: "", filter: "OVERDUE", includeClosed: true });
  eq("overdue chip = overdue group only", late.groups.map((g) => g.key), ["OVERDUE"]);
  eq("overdue chip rows", ids(late.visible), [1, 3, 8]);
  const recurring = buildPayablesList({ rows: ROWS, today: TODAY, query: "", filter: "RECURRING", includeClosed: false });
  eq("recurring chip", ids(recurring.visible), [8, 2, 4, 5]);
  const plans = buildPayablesList({ rows: ROWS, today: TODAY, query: "", filter: "INSTALLMENT_PLAN", includeClosed: true });
  eq("plans chip (incl. closed)", ids(plans.visible), [3, 9, 7]);
  const oneOff = buildPayablesList({ rows: ROWS, today: TODAY, query: "", filter: "ONE_OFF", includeClosed: false });
  eq("one-off chip (open)", ids(oneOff.visible), [1, 6]);

  /* ── search ── */
  ok("search by title", matchesSearch(byId(4), "שכיר"));
  ok("search by payee", matchesSearch(byId(4), "כהן"));
  ok("search ignores case on Latin payees", matchesSearch(byId(7), "supplier"));
  ok("search trims", matchesSearch(byId(1), "  ארנונה  "));
  ok("empty search matches", matchesSearch(byId(1), "   "));
  ok("no match", !matchesSearch(byId(1), "חשמל"));
  const searched = buildPayablesList({ rows: ROWS, today: TODAY, query: "חשמל", filter: "ALL", includeClosed: false });
  eq("search narrows groups", ids(searched.visible), [2]);
  eq("counts follow the search", searched.counts, { ALL: 1, OVERDUE: 0, RECURRING: 1, ONE_OFF: 0, INSTALLMENT_PLAN: 0 });
  const none = buildPayablesList({ rows: ROWS, today: TODAY, query: "אין כזה", filter: "ALL", includeClosed: false });
  eq("no results: no groups", none.groups.length, 0);
  eq("no results: scope still non-empty", none.inScope, 8);
  const searchAndChip = buildPayablesList({ rows: ROWS, today: TODAY, query: "ליסינג", filter: "OVERDUE", includeClosed: false });
  eq("search + chip combine", ids(searchAndChip.visible), [3]);

  /* ── parity with the cost engine ── */
  const engine = overdueObligations({
    asOf: TODAY,
    timeZone: "Asia/Jerusalem",
    baseCurrency: "ILS",
    commitments: LEDGER.map(toCost),
    payments: [],
    ownerAffirmedBackboneCaptured: true,
  });
  const engineIds = [...new Set(engine.items.map((i) => i.commitmentId))].sort((a, b) => a - b);
  const listIds = ids(all.groups.find((g) => g.key === "OVERDUE")?.rows ?? []).sort((a, b) => a - b);
  eq("'המועד עבר' = the engine's overdue commitments", listIds, engineIds);
  eq("engine overdue occurrences", engine.items.map((i) => i.installmentId).sort(), [11, 32, 81]);
  eq("every engine overdue occurrence is a row's next", engine.items.map((i) => i.installmentId).sort(), listIds.map((id) => byId(id).next!.id).sort());

  /* ── wording rule L1 ── */
  const forbidden = "כל החובות";
  const labels = [...Object.values(GROUP_LABEL), ...Object.values(FILTER_LABEL)];
  ok("no label says 'all debts'", labels.every((l) => !l.includes(forbidden)));
  for (const file of ["payables-list-model.ts", "payables-summary.tsx", "page.tsx"]) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    ok(`${file} never says 'all debts'`, !text.includes(forbidden));
  }
  const summary = fs.readFileSync(path.join(__dirname, "payables-summary.tsx"), "utf8");
  ok("summary heading says recorded", summary.includes("מועדים רשומים"));
  ok("summary states what is left out", summary.includes("מועדים חודשיים שעוד לא נוצרו לא נכללים"));

  console.log(`payables-list-model.verify.test.ts: ok (${checks} checks passed)`);
}

main();
