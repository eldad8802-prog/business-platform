/**
 * The Secretary hub (version B, owner-approved 23.10.2026): the summary cards, "המשימות שלי" and the calendar,
 * derived from responses the app already reads. Pure — no React, no fetch — so the rules are proven
 * (`npm run verify:secretary-hub`).
 *
 * Sources (all existing GET endpoints, nothing new):
 *   - the briefing (GET /api/obligations/briefing) — open commitments and what needs the owner;
 *   - the obligations list with closed items (GET /api/obligations?includeClosed=1) — the calendar's due dates;
 *   - the task agenda (GET /api/tasks/agenda, only with daily_tasks ON) — the owner's own tasks;
 *   - the business-cost summary (GET /api/business-cost/summary) — the day cost and the forecast dates;
 *   - the appointments of the month around today (GET /api/appointments, only with appointments ON) — on the same
 *     calendar, as their own kind (Appointments milestone B: no second calendar inside the Secretary).
 *
 * Rules:
 *   - Leads are not the Secretary's: only manual TASK rows reach the hub, and a task linked to a lead is left
 *     out too. Business items (SOURCE / QUEUE / REPAIR rows) stay in the task centre.
 *   - handled ≠ completed ≠ paid. A commitment is "שולם" only when the ledger says its remaining is zero;
 *     MET without that is "טופל" (no payment recorded); a task is "הושלם" only in the task centre.
 *   - A forecast is never shown as paid or as recorded: projected dates keep their own kind.
 *   - No money is computed here. Amounts are the server's strings.
 *   - A cancelled appointment is not on the calendar; every other one opens in the calendar itself (/calendar).
 */

import { obligationTitle, type BriefingApi, type ObligationApi } from "@/lib/obligations/secretary-client";
import type { BusinessCostSummaryApi } from "@/lib/business-cost/business-cost-client";
import type { AgendaRow, Bucket, ManualTask } from "@/lib/services/tasks/agenda-core";
import { addCalendarDays, jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { clockOf, KIND_LABEL, startOfDay, STATUS_LABEL, type AppointmentWire } from "@/features/calendar/calendar-model";
import { displayObligeeName } from "./secretary-home-model";

/** The agenda as the hub reads it (a subset of AgendaResponse). */
export type HubAgenda = { dayKey: string; buckets: Array<{ bucket: Bucket; rows: AgendaRow[] }> };

export type HubTask = { task: ManualTask; bucket: Bucket };

/** An appointment as the Secretary reads it (a subset of the calendar's wire shape). */
export type HubAppointment = Pick<AppointmentWire, "id" | "status" | "kind" | "startsAt" | "endsAt" | "title"> & {
  /** The customer's name when the hub could read it (never required: the title stands alone). */
  customerName?: string | null;
  /** Booked through the public link: who asked — named until the owner links a customer card. */
  booking?: { contactName: string } | null;
};

/** An appointment's line: "customer · what" for a customer appointment with a known name (or the booking's requester), else what it is. */
export function appointmentLine(a: HubAppointment): string {
  const what = a.title?.trim() || KIND_LABEL[a.kind];
  const who = a.customerName || a.booking?.contactName;
  return a.kind === "CUSTOMER" && who ? `${who} · ${what}` : what;
}

/**
 * The appointments window the Secretary reads: 30 days back to 30 days ahead of today — 61 calendar days, so even
 * with a 25-hour DST day inside it stays under the API's 62 × 24 hours.
 */
export function appointmentsWindow(now: Date): { from: Date; to: Date } {
  const today = jerusalemDayKey(now);
  return { from: startOfDay(addCalendarDays(today, -30)), to: startOfDay(addCalendarDays(today, 31)) };
}

/** Today's live appointments, earliest first (the "תורים היום" card). */
export function todayAppointments(list: HubAppointment[], today: string): HubAppointment[] {
  return list
    .filter((a) => a.startsAt && (a.status === "PROPOSED" || a.status === "CONFIRMED") && jerusalemDayKey(new Date(a.startsAt)) === today)
    .sort((a, b) => (a.startsAt! < b.startsAt! ? -1 : a.startsAt! > b.startsAt! ? 1 : a.id - b.id));
}

/** The owner's own tasks: manual TASK rows only, never a lead (linked or as a source item). */
export function ownTasks(agenda: HubAgenda): HubTask[] {
  const out: HubTask[] = [];
  for (const b of agenda.buckets) {
    for (const row of b.rows) {
      if (row.type !== "TASK") continue;
      if (row.task.link?.kind === "lead") continue;
      out.push({ task: row.task, bucket: b.bucket });
    }
  }
  return out;
}

/** Tasks that belong to today's work: overdue and today, in the agenda's order. */
export function todayTasks(tasks: HubTask[]): HubTask[] {
  return tasks.filter((t) => t.bucket === "OVERDUE" || t.bucket === "TODAY");
}

// ── Calendar ─────────────────────────────────────────────────────────────

/**
 * What a day on the calendar can hold. Each kind is its own fact:
 *   TASK      — an open task due that day (agenda);
 *   DUE       — an open commitment payment due that day (not paid yet);
 *   PAID      — a commitment the ledger shows as fully paid, placed on its due day (the payment date is not
 *               exposed by the API, so the label never claims one);
 *   HANDLED   — marked "טופל" with no payment recorded (legacy close, or handled without paying);
 *   PROJECTED — a forecast occurrence of a recurring commitment, not recorded yet.
 */
export type CalendarKind = "TASK" | "DUE" | "PAID" | "HANDLED" | "PROJECTED" | "APPOINTMENT";

export type CalendarEvent = {
  key: string;
  day: string;
  kind: CalendarKind;
  title: string;
  /** Server amount string, when there is one. */
  amount: string | null;
  currency: string;
  /** Where the event opens (an existing screen). */
  href: string | null;
};

export const CALENDAR_KIND_LABEL: Record<CalendarKind, string> = {
  TASK: "משימה",
  DUE: "תשלום צפוי",
  PAID: "שולם",
  HANDLED: "טופל, לא נרשם תשלום",
  PROJECTED: "תחזית",
  APPOINTMENT: "תור",
};

function isZeroAmount(decimal: string): boolean {
  const n = Number(decimal);
  return Number.isFinite(n) && n === 0;
}

/** The kind of a commitment row — the ledger decides "paid", never the state alone. */
export function obligationKind(o: ObligationApi): CalendarKind | null {
  if (o.state === "RELEASED") return null;
  if (o.state === "OPEN") return "DUE";
  // MET: paid only when the ledger shows nothing left.
  if (o.ledger && isZeroAmount(o.ledger.remaining) && !isZeroAmount(o.ledger.paid)) return "PAID";
  return "HANDLED";
}

export function calendarEvents(input: {
  obligations: ObligationApi[];
  tasks: HubTask[];
  summary: BusinessCostSummaryApi | null;
  appointments?: HubAppointment[];
}): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const a of input.appointments ?? []) {
    if (a.status === "CANCELED" || !a.startsAt) continue;
    const start = new Date(a.startsAt);
    if (Number.isNaN(start.getTime())) continue;
    const day = jerusalemDayKey(start);
    const what = appointmentLine(a);
    events.push({
      key: `a:${a.id}`,
      day,
      kind: "APPOINTMENT",
      // Its state in words when it is not simply booked (מאושר): ממתין לאישור / הושלם / לא הגיע.
      title: `${a.endsAt ? `${clockOf(start)} · ${what}` : what}${a.status !== "CONFIRMED" && a.kind !== "BLOCK" ? ` · ${STATUS_LABEL[a.status]}` : ""}`,
      amount: null,
      currency: "ILS",
      href: `/calendar?view=day&day=${day}&appointment=${a.id}`,
    });
  }

  for (const o of input.obligations) {
    const kind = obligationKind(o);
    const due = new Date(o.dueAt);
    if (!kind || Number.isNaN(due.getTime())) continue;
    events.push({
      key: `o:${o.id}`,
      day: jerusalemDayKey(due),
      kind,
      title: displayObligeeName(obligationTitle(o)),
      amount: kind === "DUE" && o.ledger ? o.ledger.remaining : o.amount,
      currency: o.currency,
      href: `/secretary?screen=detail&id=${o.id}`,
    });
  }

  for (const { task } of input.tasks) {
    if (!task.dueOn) continue;
    events.push({ key: `t:${task.id}`, day: task.dueOn, kind: "TASK", title: task.title, amount: null, currency: "ILS", href: "/tasks" });
  }

  // Forecast: only PROJECTED items (RECORDED ones are installments already listed above).
  if (input.summary) {
    const seen = new Set<string>();
    const windows = [input.summary.upcoming.currentMonth, input.summary.upcoming.next30Days];
    for (const w of windows) {
      for (const item of w.items) {
        if (item.basis !== "PROJECTED") continue;
        const k = `p:${item.dueDate}:${item.title}:${item.amount}`;
        if (seen.has(k)) continue;
        seen.add(k);
        events.push({ key: k, day: item.dueDate, kind: "PROJECTED", title: item.title, amount: item.amount, currency: input.summary.currency, href: null });
      }
    }
  }

  // An appointment first in its day (its title starts with its time, so appointments sort by time); the rest unchanged.
  const order: Record<CalendarKind, number> = { APPOINTMENT: -1, TASK: 0, DUE: 1, HANDLED: 2, PAID: 3, PROJECTED: 4 };
  return events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : order[a.kind] - order[b.kind] || a.title.localeCompare(b.title, "he")));
}

export function eventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = map.get(e.day);
    if (list) list.push(e);
    else map.set(e.day, [e]);
  }
  return map;
}

/** A month grid (Sunday first, Israeli week): 5–6 rows of day keys, null outside the month. */
export function monthGrid(year: number, month1: number): Array<Array<string | null>> {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const days = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function shiftMonth(year: number, month1: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month1 - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

// ── Summary cards ────────────────────────────────────────────────────────

export type HubCard = { key: "tasks" | "open" | "upcoming" | "cost"; label: string; value: string | null; hint: string; state: "ready" | "loading" | "unavailable" | "off" };

/**
 * The four cards. Every number is a count the server returned or a server amount string; `null` means
 * "not known" and is shown as such, never as 0.
 */
export function hubCards(input: {
  briefing: BriefingApi;
  tasks: HubTask[] | "loading" | "unavailable" | "off";
  summary: BusinessCostSummaryApi | "loading" | "unavailable";
  formatMoney: (decimal: string, currency: string) => string;
}): HubCard[] {
  const counts = { overdue: 0, today: 0, soon: 0 };
  for (const a of input.briefing.attention) {
    if (a.reason === "OVERDUE") counts.overdue += 1;
    else if (a.reason === "DUE_TODAY") counts.today += 1;
    else counts.soon += 1;
  }
  const n = (v: number) => v.toLocaleString("he-IL");

  const tasksCard: HubCard =
    input.tasks === "off"
      ? { key: "tasks", label: "משימות פתוחות", value: null, hint: "המשימות עוד לא פעילות בעסק", state: "off" }
      : input.tasks === "loading"
        ? { key: "tasks", label: "משימות פתוחות", value: null, hint: "", state: "loading" }
        : input.tasks === "unavailable"
          ? { key: "tasks", label: "משימות פתוחות", value: null, hint: "לא הצלחתי לטעון", state: "unavailable" }
          : {
              key: "tasks",
              label: "משימות פתוחות",
              value: n(input.tasks.length),
              hint: todayTasks(input.tasks).length > 0 ? `${n(todayTasks(input.tasks).length)} להיום או באיחור` : "בשבוע הקרוב",
              state: "ready",
            };

  const openCard: HubCard = {
    key: "open",
    label: "התחייבויות פתוחות",
    value: n(input.briefing.counts.open),
    hint: counts.overdue > 0 ? `${n(counts.overdue)} עברו את המועד` : `${n(input.briefing.counts.watching)} במעקב שקט`,
    state: "ready",
  };

  const upcomingCard: HubCard = {
    key: "upcoming",
    label: "תשלומים קרובים",
    value: n(counts.today + counts.soon),
    hint: counts.today > 0 ? `${n(counts.today)} להיום · השאר בשבוע הקרוב` : "בשבוע הקרוב",
    state: "ready",
  };

  const costCard: HubCard =
    input.summary === "loading"
      ? { key: "cost", label: "עלות יומית", value: null, hint: "", state: "loading" }
      : input.summary === "unavailable"
        ? { key: "cost", label: "עלות יומית", value: null, hint: "לא הצלחתי לטעון", state: "unavailable" }
        : input.summary.baseline.completeness.state === "EMPTY"
          ? { key: "cost", label: "עלות יומית", value: null, hint: "עוד אין הוצאות קבועות רשומות", state: "unavailable" }
          : {
              key: "cost",
              label: "עלות יומית",
              value: input.formatMoney(input.summary.baseline.calendarDay.daily, input.summary.currency),
              hint: "עלות תפעול מחושבת · לפירוט",
              state: "ready",
            };

  return [tasksCard, openCard, upcomingCard, costCard];
}
