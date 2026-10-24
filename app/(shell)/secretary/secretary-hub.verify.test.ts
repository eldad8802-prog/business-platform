/**
 * Secretary hub proof (`npm run verify:secretary-hub`) — version B, owner-approved 23.10.2026.
 *
 * Proves the rules the owner set: leads never reach the Secretary; handled ≠ completed ≠ paid; a forecast is
 * never shown as paid; the day cost is the server's calendar-day figure; the two main actions open the
 * existing flows (P3 and the task centre's create form, only with daily_tasks ON); nothing new is fetched
 * or written beyond the existing GET endpoints.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";
import type { BriefingApi, ObligationApi } from "@/lib/obligations/secretary-client";
import type { AgendaRow, ManualTask } from "@/lib/services/tasks/agenda-core";
import { calendarEvents, hubCards, monthGrid, obligationKind, ownTasks, shiftMonth, todayTasks, type HubAgenda } from "./secretary-hub-model";

let failures = 0;
let checks = 0;
function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function task(id: number, title: string, dueOn: string | null, link: ManualTask["link"] = null): ManualTask {
  return { id, title, note: null, dueOn, pinned: false, version: 3, seriesId: null, sequence: null, cadence: null, link, createdAt: "2026-10-01T08:00:00Z" };
}
const taskRow = (t: ManualTask, bucket: AgendaRow["bucket"]): AgendaRow => ({ type: "TASK", key: `task:${t.id}`, bucket, pinned: false, task: t, tags: [] });
const sourceRow = (title: string, bucket: AgendaRow["bucket"]) =>
  ({ type: "SOURCE", key: `lead:${title}`, bucket, pinned: false, item: { sourceKind: "LEAD", dedupeKey: `lead:${title}`, title }, tags: [], dimmed: false }) as unknown as AgendaRow;

function ob(id: number, name: string, state: ObligationApi["state"], amount: string, dueAt: string, ledger: ObligationApi["ledger"] = null): ObligationApi {
  return {
    id, obligeeName: name, amount, currency: "ILS", dueAt, state, source: "MANUAL", recurrence: "MONTHLY", recurrenceSeriesId: null, note: null,
    followUpAt: null, settlementAssertedBy: null, metAt: state === "MET" ? dueAt : null, releasedAt: null, createdAt: dueAt, updatedAt: dueAt, ledger,
  };
}

// ── Leads never reach the hub ──
const agenda: HubAgenda = {
  dayKey: "2026-10-23",
  buckets: [
    { bucket: "OVERDUE", rows: [taskRow(task(1, "להתקשר לרואה החשבון", "2026-10-20"), "OVERDUE"), sourceRow("ליד חדש מהאתר", "OVERDUE")] },
    { bucket: "TODAY", rows: [taskRow(task(2, "לחזור לליד", "2026-10-23", { kind: "lead", id: 7, label: "דנה" }), "TODAY"), taskRow(task(3, "להזמין נייר", "2026-10-23", { kind: "supplier", id: 4, label: "דפוס אור" }), "TODAY")] },
    { bucket: "NO_DATE", rows: [taskRow(task(4, "לסדר את המחסן", null), "NO_DATE")] },
    { bucket: "UPCOMING", rows: [taskRow(task(5, "לחדש ביטוח", "2026-10-27"), "UPCOMING"), { type: "QUEUE", key: "queue:LEAD:UPCOMING", bucket: "UPCOMING", pinned: false } as unknown as AgendaRow] },
  ],
};
const mine = ownTasks(agenda);
check(mine.map((t) => t.task.id).join(",") === "1,3,4,5", "only manual tasks, never a lead-linked task or a source/queue item", mine.map((t) => t.task.id).join(","));
check(!mine.some((t) => /ליד/.test(t.task.title) && t.task.link?.kind === "lead"), "the lead-linked task is out");
check(todayTasks(mine).map((t) => t.task.id).join(",") === "1,3", "today = overdue + today buckets only");

// ── handled ≠ paid; released is not on the calendar ──
check(obligationKind(ob(1, "שכירות", "OPEN", "6500.00", "2026-11-01T09:00:00Z")) === "DUE", "OPEN → payment due");
check(obligationKind(ob(2, "ארנונה", "MET", "800.00", "2026-10-10T09:00:00Z", { commitmentId: 1, installmentId: 2, paid: "800.00", remaining: "0.00" })) === "PAID", "MET + ledger remaining 0 → paid");
check(obligationKind(ob(3, "חשמל", "MET", "400.00", "2026-10-12T09:00:00Z", { commitmentId: 1, installmentId: 3, paid: "0.00", remaining: "400.00" })) === "HANDLED", "MET with money left → handled, not paid");
check(obligationKind(ob(4, "מים", "MET", "120.00", "2026-10-14T09:00:00Z", { commitmentId: 1, installmentId: 4, paid: "0.00", remaining: "0.00" })) === "HANDLED", "MET with nothing paid → handled, not paid");
check(obligationKind(ob(5, "ישן", "MET", "90.00", "2026-10-15T09:00:00Z")) === "HANDLED", "legacy MET (no ledger) → handled, never claimed paid");
check(obligationKind(ob(6, "בוטל", "RELEASED", "90.00", "2026-10-16T09:00:00Z")) === null, "RELEASED → not on the calendar");

// ── Forecast stays a forecast ──
const win = (items: BusinessCostSummaryApi["upcoming"]["next30Days"]["items"]) => ({ from: "2026-10-23", to: "2026-11-22", total: "0", recorded: "0", projected: "0", items });
const summary = {
  asOf: "2026-10-23",
  currency: "ILS",
  baseline: {
    daily: "290.12", weekly: "0", monthly: "8800.00", annual: "0",
    calendarDay: { month: "2026-10", daysInMonth: 31, daily: "283.87" },
    lines: [], uncertain: "0", uncertainItems: [], debtServiceMonthly: "0", debtServiceLines: [],
    affirmation: { affirmed: true, affirmedOn: "2026-10-01" }, completeness: { state: "COMPLETE", reasons: [] },
  },
  upcoming: {
    overdue: win([]),
    next7Days: win([]),
    currentMonth: win([{ title: "שכירות", dueDate: "2026-10-28", amount: "6500.00", basis: "PROJECTED" }]),
    next30Days: win([
      { title: "שכירות", dueDate: "2026-10-28", amount: "6500.00", basis: "PROJECTED" },
      { title: "ארנונה", dueDate: "2026-11-01", amount: "800.00", basis: "RECORDED" },
    ]),
  },
} as unknown as BusinessCostSummaryApi;
const events = calendarEvents({
  obligations: [ob(1, "ארנונה", "OPEN", "800.00", "2026-11-01T09:00:00Z", { commitmentId: 9, installmentId: 1, paid: "300.00", remaining: "500.00" }), ob(2, "חשמל", "MET", "400.00", "2026-10-12T09:00:00Z", { commitmentId: 1, installmentId: 3, paid: "400.00", remaining: "0.00" })],
  tasks: mine,
  summary,
});
const projected = events.filter((e) => e.kind === "PROJECTED");
check(projected.length === 1 && projected[0].day === "2026-10-28", "one projected date, deduplicated across windows", JSON.stringify(projected));
check(!events.some((e) => e.kind === "PROJECTED" && e.title === "ארנונה"), "a RECORDED item is not repeated as a forecast");
check(events.find((e) => e.key === "o:1")?.amount === "500.00", "an open ledger item shows the server's remaining, not a sum");
check(events.find((e) => e.key === "o:2")?.kind === "PAID", "a fully paid ledger item is paid");
check(!events.some((e) => e.kind === "TASK" && e.title === "לסדר את המחסן"), "a task without a due day is not placed on a day");
check(events.some((e) => e.kind === "TASK" && e.day === "2026-10-27"), "an upcoming task sits on its due day");
check(events.every((e, i) => i === 0 || events[i - 1].day <= e.day), "events are in day order");

// ── Cards ──
const briefing = {
  state: "BUSY", oriented: true,
  attention: [
    { reason: "OVERDUE", obligation: ob(10, "א", "OPEN", "1.00", "2026-10-20T09:00:00Z") },
    { reason: "DUE_TODAY", obligation: ob(11, "ב", "OPEN", "1.00", "2026-10-23T09:00:00Z") },
    { reason: "DUE_SOON", obligation: ob(12, "ג", "OPEN", "1.00", "2026-10-26T09:00:00Z") },
    { reason: "DUE_SOON", obligation: ob(13, "ד", "OPEN", "1.00", "2026-10-27T09:00:00Z") },
  ],
  watching: [], counts: { open: 9, attention: 4, breakToday: 2, watching: 5 }, generatedAt: "2026-10-23T06:00:00Z",
} as unknown as BriefingApi;
const fmt = (d: string) => `${d} ₪`;
const cards = hubCards({ briefing, tasks: mine, summary, formatMoney: fmt });
const card = (k: string) => cards.find((c) => c.key === k)!;
check(cards.map((c) => c.label).join("|") === "משימות פתוחות|התחייבויות פתוחות|תשלומים קרובים|עלות יומית", "the four cards, in order");
check(card("tasks").value === "4", "open tasks = manual tasks only", String(card("tasks").value));
check(card("open").value === "9", "open commitments = the server's count");
check(card("upcoming").value === "3", "upcoming payments = due today + this week (server reasons)");
check(card("cost").value === "283.87 ₪", "day cost = baseline.calendarDay.daily, not the internal mean-day rate", String(card("cost").value));
const off = hubCards({ briefing, tasks: "off", summary: "unavailable", formatMoney: fmt });
check(off[0].state === "off" && off[0].value === null, "daily_tasks OFF: the tasks card says so, never 0");
check(off[3].state === "unavailable" && off[3].value === null, "a failed summary shows no number, never 0");
const empty = hubCards({ briefing, tasks: [], summary: { ...summary, baseline: { ...summary.baseline, completeness: { state: "EMPTY", reasons: [] } } }, formatMoney: fmt });
check(empty[3].value === null, "no recorded fixed costs → no day cost");

// ── Calendar grid ──
const oct = monthGrid(2026, 10);
check(oct[0].slice(0, 4).every((d) => d === null) && oct[0][4] === "2026-10-01", "October 2026 starts on Thursday (Sunday-first week)");
check(oct.flat().filter(Boolean).length === 31, "31 days in October");
check(JSON.stringify(shiftMonth(2026, 12, 1)) === JSON.stringify({ year: 2027, month: 1 }) && JSON.stringify(shiftMonth(2026, 1, -1)) === JSON.stringify({ year: 2025, month: 12 }), "month navigation crosses years");

// ── Source rules ──
const dir = path.join(process.cwd(), "app", "(shell)", "secretary");
const home = readFileSync(path.join(dir, "secretary-home.tsx"), "utf8");
const data = readFileSync(path.join(dir, "secretary-hub-data.ts"), "utf8");
const drawer = readFileSync(path.join(dir, "secretary-cost-drawer.tsx"), "utf8");
const model = readFileSync(path.join(dir, "secretary-hub-model.ts"), "utf8");
const has = (snippet: string) => home.includes(snippet);
check(
  has(`bank: "/secretary?screen=bank"`) && has(`<Link href={HREF.bank} className={cx(s.action, s.actionSand)}>`) && has("<span>הוסף התחייבות</span>"),
  "\"הוסף התחייבות\" (sand) opens the P3 flow at its first step",
);
check(
  has(`newTask: "/tasks?new=1"`) && has(`{tasksOn ? (\n        <Link href={HREF.newTask} className={cx(s.action, s.actionGreen)}>`),
  "\"הוסף משימה\" (Dubiz green) is the task centre's create form, only with daily_tasks ON",
);
// Stations layout (owner-approved mockup, 24.10.2026): the order, and what left the main screen.
const order = ["<Header", "<Actions", "<CostCard", "<Stations", "<SecretaryWeek"].map((tag) => home.indexOf(tag, home.indexOf("export function SecretaryHome(")));
check(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), "main screen order: title · actions · day cost · stations · week", order.join(","));
check(!/מה מחכה לך היום|התחייבויות קרובות|היסטוריה ומידע נוסף|משימות פתוחות|תשלומים קרובים|RowGroup|hubCards/.test(home.slice(home.indexOf("export const HREF"))), "no summary cards, no \"מה מחכה לך היום\", no long lists, no history links on the main screen");
check(has(`payables: "/payables"`) && has(`tasks: "/tasks"`) && has(`calendar: "/secretary?screen=calendar"`), "stations open the existing Payables, Tasks and the Secretary's full calendar");
check(
  has("baseline.calendarDay.daily") && has("עלות תפעול מחושבת, לא תשלום בפועל") && !/height=\{/.test(home),
  "day cost = server calendar-day figure, said to be calculated; no drawn chart of made-up days",
);
check(!/postSync|createTask|createSeries/.test(data + home), "the hub starts no sync and creates no task of its own");
check(!/fetch\(/.test(data) && /fetchAgenda\(\)/.test(data) && /fetchObligations\(token, true/.test(data) && /fetchBusinessCostSummary\(/.test(data), "only the existing GET clients");
check(/useFeatureState\("daily_tasks"\)/.test(data) && /if \(!tasksOn\) return;/.test(data), "the agenda is read only once daily_tasks is ON");
check(/לא כסף ששולם/.test(drawer) && /<BusinessCostCard embedded breakdownOpen \/>/.test(drawer), "the drawer says calculated, not paid, and shows the existing breakdown");
check(!/[*/+]\s*Number\(|Number\([^)]*\)\s*[*/+-]/.test(model), "the hub model does no money arithmetic");
check(!/SOURCE|QUEUE/.test(home), "the main screen never renders business source items (leads live on home)");

console.log(`secretary-hub: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
