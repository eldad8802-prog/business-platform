/**
 * Verify — payables list grouping, state + type filters, closed-row kinds (owner-approved redesign, 25.10.2026).
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
  CLOSED_LABEL,
  GROUP_LABEL,
  OPEN_BY_DEFAULT,
  STATE_FILTER_LABEL,
  TYPE_FILTER_LABEL,
  buildPayablesList,
  closedKindOf,
  groupOf,
  iconFor,
  isOverdueRow,
  isPartlyPaid,
  relativeDue,
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
type Fixture = { id: number; title: string; payee: string; kind: ScheduleKind; status: "ACTIVE" | "CLOSED" | "RELEASED"; installments: Inst[]; attention?: DerivedState };

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
  // Partly paid, due in 3 days → by its date: soon.
  { id: 10, title: "מחשב נייד", payee: "מחשבי הדר", kind: "INSTALLMENT_PLAN", status: "ACTIVE", installments: [
    { id: 101, seq: 2, dueAt: "2026-10-25T08:00:00Z", amountMinor: 60000, paidMinor: 20000, state: "PARTIALLY_PAID" },
  ] },
  // Partly paid, due in 3 weeks → by its date: planned (it used to sit under "upcoming").
  { id: 11, title: "ריהוט", payee: "ריהוט משרדי", kind: "INSTALLMENT_PLAN", status: "ACTIVE", installments: [
    { id: 111, seq: 4, dueAt: "2026-11-12T08:00:00Z", amountMinor: 50000, paidMinor: 10000, state: "PARTIALLY_PAID" },
  ] },
  // Released ("כבר לא רלוונטי").
  { id: 12, title: "הדפסות", payee: "דפוס אור", kind: "ONE_OFF", status: "RELEASED", attention: "CANCELLED", installments: [
    { id: 121, seq: 1, dueAt: "2026-09-10T08:00:00Z", amountMinor: 30000, paidMinor: 0, state: "CANCELLED", status: "CANCELLED" },
  ] },
  // Handled without a payment (legacy assertion): closed, never "paid".
  { id: 13, title: "ועד בית", payee: "ועד הבית", kind: "ONE_OFF", status: "ACTIVE", attention: "SETTLED_LEGACY", installments: [
    { id: 131, seq: 1, dueAt: "2026-08-10T08:00:00Z", amountMinor: 12000, paidMinor: 0, state: "SETTLED_LEGACY", status: "SETTLED_LEGACY" },
  ] },
  // Every instalment cancelled.
  { id: 14, title: "מנוי ישן", payee: "שירות ישן", kind: "ONE_OFF", status: "ACTIVE", attention: "CANCELLED", installments: [
    { id: 141, seq: 1, dueAt: "2026-07-10T08:00:00Z", amountMinor: 5000, paidMinor: 0, state: "CANCELLED", status: "CANCELLED" },
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
    attention: f.attention ?? (n ? n.state : "PAID"),
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
  const g = (id: number) => groupOf(byId(id), TODAY, NOW);
  eq("late by a day → overdue", g(1), "OVERDUE");
  eq("due today (Israel) → not overdue", g(2), "UPCOMING");
  ok("due today is never late", !isOverdueRow(byId(2), TODAY));
  eq("partly paid past its day → overdue", g(3), "OVERDUE");
  eq("DUE → soon", g(4), "UPCOMING");
  eq("SCHEDULED → planned", g(5), "PLANNED");
  eq("fully paid → closed", g(6), "CLOSED");
  eq("ended commitment → closed, even with an old open instalment", g(7), "CLOSED");
  eq("23:59 Israel yesterday → overdue", g(8), "OVERDUE");
  eq("cancelled instalment is skipped for next", byId(9).next?.id, 92);
  eq("…and the commitment is soon", g(9), "UPCOMING");
  eq("partly paid in 3 days → soon (by date, server window)", g(10), "UPCOMING");
  eq("partly paid in 3 weeks → planned (by date, server window)", g(11), "PLANNED");
  eq("released → closed", g(12), "CLOSED");
  eq("handled without payment → closed", g(13), "CLOSED");
  eq("all cancelled → closed", g(14), "CLOSED");

  /* ── closed kinds: never "paid" for what was only handled ── */
  eq("closed kinds", [6, 7, 12, 13, 14].map((id) => closedKindOf(byId(id))), ["PAID", "ENDED", "RELEASED", "HANDLED", "CANCELLED"]);
  eq("open rows have no closed kind", [1, 2, 4, 5, 10].map((id) => closedKindOf(byId(id))), [null, null, null, null, null]);
  eq("closed labels", CLOSED_LABEL, { PAID: "שולם", HANDLED: "טופל, בלי תשלום", RELEASED: "לא רלוונטי", CANCELLED: "בוטל", ENDED: "הסתיים" });
  ok("handled is not labelled paid", CLOSED_LABEL.HANDLED !== CLOSED_LABEL.PAID && !CLOSED_LABEL.HANDLED.startsWith("שולם"));
  eq("partly paid tag", [3, 10, 11, 4, 6].map((id) => isPartlyPaid(byId(id))), [true, true, true, false, false]);

  /* ── the list ── */
  const all = buildPayablesList({ rows: ROWS, today: TODAY, now: NOW, state: "ALL", type: "ALL" });
  eq("groups in order", all.groups.map((x) => x.key), ["OVERDUE", "UPCOMING", "PLANNED", "CLOSED"]);
  eq("labels", all.groups.map((x) => x.label), ["באיחור", "בקרוב", "מתוכנן", "שולם ונסגר"]);
  eq("overdue keeps server order", ids(all.groups[0].rows), [1, 3, 8]);
  eq("soon keeps server order", ids(all.groups[1].rows), [2, 4, 9, 10]);
  eq("planned", ids(all.groups[2].rows), [5, 11]);
  eq("closed holds paid, ended, released, handled, cancelled", ids(all.groups[3].rows), [6, 7, 12, 13, 14]);
  eq("state counts", all.counts, { ALL: 14, OVERDUE: 3, UPCOMING: 4, PLANNED: 2, CLOSED: 5 });
  eq("open by default: overdue + soon; planned + closed folded", OPEN_BY_DEFAULT, { OVERDUE: true, UPCOMING: true, PLANNED: false, CLOSED: false });

  /* ── filters ── */
  const late = buildPayablesList({ rows: ROWS, today: TODAY, now: NOW, state: "OVERDUE", type: "ALL" });
  eq("overdue chip = overdue group only", late.groups.map((x) => x.key), ["OVERDUE"]);
  eq("overdue chip rows", ids(late.visible), [1, 3, 8]);
  const closed = buildPayablesList({ rows: ROWS, today: TODAY, now: NOW, state: "CLOSED", type: "ALL" });
  eq("closed chip rows", ids(closed.visible), [6, 7, 12, 13, 14]);
  const recurring = buildPayablesList({ rows: ROWS, today: TODAY, now: NOW, state: "ALL", type: "RECURRING" });
  eq("type: recurring", ids(recurring.visible), [8, 2, 4, 5]);
  eq("counts follow the type", recurring.counts, { ALL: 4, OVERDUE: 1, UPCOMING: 2, PLANNED: 1, CLOSED: 0 });
  const plans = buildPayablesList({ rows: ROWS, today: TODAY, now: NOW, state: "ALL", type: "INSTALLMENT_PLAN" });
  eq("type: plans (incl. closed)", ids(plans.visible), [3, 9, 10, 11, 7]);
  const planSoon = buildPayablesList({ rows: ROWS, today: TODAY, now: NOW, state: "UPCOMING", type: "INSTALLMENT_PLAN" });
  eq("state + type combine", ids(planSoon.visible), [9, 10]);
  const empty = buildPayablesList({ rows: ROWS, today: TODAY, now: NOW, state: "PLANNED", type: "ONE_OFF" });
  eq("no rows: no groups", empty.groups.length, 0);

  /* ── relative dates (Israel days) ── */
  eq(
    "relative",
    ["2026-10-17T08:00:00Z", "2026-10-20T21:00:00Z", "2026-10-22T08:00:00Z", "2026-10-23T08:00:00Z", "2026-10-27T08:00:00Z", "2026-12-22T08:00:00Z", "2027-02-22T08:00:00Z"].map((d) => relativeDue(d, TODAY)),
    ["באיחור 5 ימים", "באיחור יום אחד", "היום", "מחר", "בעוד 5 ימים", "בעוד חודשיים", "בעוד 4 חודשים"],
  );

  /* ── icons: from the name, ביטוח לאומי before ביטוח ── */
  eq(
    "icons",
    [["שכירות", ""], ["ביטוח לאומי", ""], ["ביטוח עסק", "הראל"], ["חשמל", "חברת חשמל"], ["משהו", "מישהו"]].map(([title, payeeNameSnapshot]) => iconFor({ title, payeeNameSnapshot })),
    ["🏠", "👥", "🛡️", "⚡", "📄"],
  );

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
  const listIds = ids(all.groups.find((x) => x.key === "OVERDUE")?.rows ?? []).sort((a, b) => a - b);
  eq("'באיחור' = the engine's overdue commitments", listIds, engineIds);
  eq("engine overdue occurrences", engine.items.map((i) => i.installmentId).sort(), [11, 32, 81]);
  eq("every engine overdue occurrence is a row's next", engine.items.map((i) => i.installmentId).sort(), listIds.map((id) => byId(id).next!.id).sort());

  /* ── wording rule L1, and what left the screen ── */
  const forbidden = "כל החובות";
  const labels = [...Object.values(GROUP_LABEL), ...Object.values(STATE_FILTER_LABEL), ...Object.values(TYPE_FILTER_LABEL), ...Object.values(CLOSED_LABEL)];
  ok("no label says 'all debts'", labels.every((l) => !l.includes(forbidden)));
  const page = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  ok("page.tsx never says 'all debts'", !page.includes(forbidden));
  ok("no summary card, no search on the main screen", !page.includes("<PayablesSummary") && !page.includes('type="search"'));
  ok("cheques and bank stay reachable", page.includes('"/payables/cheques"') && page.includes('"/payables/bank"'));
  ok("a card opens the existing detail screen", page.includes("router.push(`/payables/${row.id}`)"));
  ok("\"התחייבות חדשה\" opens P3, the one creation path", page.includes(`const P3_START = "/secretary?screen=bank";`) && (page.match(/<Link href={P3_START} className={home.newButton}>/g) ?? []).length === 2);
  ok("the old form stays reachable only by its direct link (?new=1)", page.includes(`searchParams.get("new") === "1"`) && page.includes("<CommitmentForm"));

  console.log(`payables-list-model.verify.test.ts: ok (${checks} checks passed)`);
}

main();
