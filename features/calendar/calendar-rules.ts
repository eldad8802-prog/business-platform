/**
 * The redesign's pure rules (design direction A, 2026-11-02) — the day's lanes, the week's hours in words, the next
 * range and the quarter-hour pickers, lengths in their best unit, staff colours, who performs what (one rule for the
 * service page and the staff page), a booking request's outcome and the booking link's dead end.
 *
 * Kept apart from calendar-model so the screens that only need the calendar's basics (the Secretary, the customer
 * card) do not load them. No React, no fetch, no clock of its own. Tested by calendar-model.test.ts.
 */
import {
  clock,
  REQUEST_STATUS_LABEL,
  windowsByWeekday,
  type AppointmentWire,
  type StaffWire,
  type WeekWindow,
} from "./calendar-model";

// ── Redesign (direction A, 2026-11-02): lanes, hours in words, units, colours ──────────────────────

export type Lane = { key: string; staffMemberId: number | null; label: string; color: string | null; inactive: boolean };

/**
 * The day view's lanes: "ללא עובד" (the business itself), every active staff member, and every inactive one who
 * still has an appointment that day — an existing appointment never disappears because its staff member was
 * deactivated (the staff screen's promise). A staff id the list does not know (a read that failed) gets a lane too.
 */
export function dayLanes(staff: StaffWire[], dayAppointments: AppointmentWire[]): Lane[] {
  const used = new Set(dayAppointments.map((a) => a.staffMemberId).filter((x): x is number => x !== null));
  const lanes: Lane[] = [{ key: "biz", staffMemberId: null, label: "ללא עובד", color: null, inactive: false }];
  for (const m of [...staff].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)) {
    if (!m.active && !used.has(m.id)) continue;
    lanes.push({ key: `s${m.id}`, staffMemberId: m.id, label: m.active ? m.displayName : `${m.displayName} (לא פעיל)`, color: m.color, inactive: !m.active });
    used.delete(m.id);
  }
  for (const id of used) lanes.push({ key: `s${id}`, staffMemberId: id, label: "עובד", color: null, inactive: true });
  return lanes;
}

export const WEEKDAY_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

const endClock = (m: number) => (m >= 1440 ? "24:00" : clock(m));
/** "09:00–17:00" in a left-to-right isolate (inside Hebrew text the dash would flip it). */
export const rangeText = (start: number, end: number) => `⁦${clock(start)}–${endClock(end)}⁩`;

/**
 * The weekly hours in one line, consecutive days with the same windows joined: "א׳–ה׳ 09:00–17:00 · ו׳ 09:00–13:00".
 * No hours at all → null (the caller says "לא הוגדרו").
 */
export function hoursSummary(rules: WeekWindow[]): string | null {
  const days = windowsByWeekday(rules).map((d) => d.map((w) => rangeText(w.startMinute, w.endMinute)).join(", "));
  if (days.every((d) => !d)) return null;
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    if (!days[i]) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && days[j + 1] === days[i]) j++;
    parts.push(`${j > i ? `${WEEKDAY_SHORT[i]}–${WEEKDAY_SHORT[j]}` : WEEKDAY_SHORT[i]} ${days[i]}`);
    i = j + 1;
  }
  return parts.join(" · ");
}

/**
 * The next range "+ טווח שעות" adds after a day's last one: from its end, two hours long, never past midnight;
 * a day whose last range already ends at 23:45 or later has no room (null). An empty day starts at 09:00–17:00.
 */
export function nextRange(ranges: Array<{ startMinute: number; endMinute: number }>): { startMinute: number; endMinute: number } | null {
  if (!ranges.length) return { startMinute: 540, endMinute: 1020 };
  const last = Math.max(...ranges.map((r) => r.endMinute));
  if (last > 1440 - 15) return null;
  return { startMinute: last, endMinute: Math.min(1440, last + 120) };
}

/** The quarter-hour clock values a time picker offers (start: 00:00–23:45; end: 00:15–24:00), plus `keep` if off-grid. */
export function timeOptions(kind: "start" | "end", keep?: number | null): number[] {
  const out = Array.from({ length: 96 }, (_, i) => (kind === "start" ? i * 15 : (i + 1) * 15));
  if (keep !== undefined && keep !== null && !out.includes(keep)) out.push(keep);
  return out.sort((a, b) => a - b);
}
export const timeOptionLabel = (m: number) => endClock(m);

/** A length of time in the unit it reads best in: whole days, else whole hours, else minutes. */
export type LeadUnit = "minutes" | "hours" | "days";
export const UNIT_MINUTES: Record<LeadUnit, number> = { minutes: 1, hours: 60, days: 1440 };
export const UNIT_LABEL: Record<LeadUnit, string> = { minutes: "דקות", hours: "שעות", days: "ימים" };
export function splitMinutes(m: number): { value: number; unit: LeadUnit } {
  if (m > 0 && m % 1440 === 0) return { value: m / 1440, unit: "days" };
  if (m > 0 && m % 60 === 0) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}

/** The staff colours (soft, distinct); a new staff member gets the first one nobody uses yet. */
export const STAFF_PALETTE = ["#c0643f", "#7d5ba6", "#4f8a68", "#3f78a8", "#c08a2e", "#b8577a", "#2f7f7a", "#66707e"];
export function nextStaffColor(staff: Array<Pick<StaffWire, "color">>): string {
  const taken = new Set(staff.map((m) => m.color?.toLowerCase()).filter(Boolean));
  return STAFF_PALETTE.find((c) => !taken.has(c)) ?? STAFF_PALETTE[staff.length % STAFF_PALETTE.length];
}
export const COLOR_NAME: Record<string, string> = {
  "#c0643f": "טרקוטה", "#7d5ba6": "סגול", "#4f8a68": "ירוק", "#3f78a8": "כחול", "#c08a2e": "חרדל", "#b8577a": "ורוד", "#2f7f7a": "טורקיז", "#66707e": "אפור",
};

/** The staff members who may take a service: those assigned to it, or everyone active when nobody is. */
export function staffForService(staff: StaffWire[], serviceId: number | null): StaffWire[] {
  const active = staff.filter((x) => x.active);
  if (serviceId === null) return active;
  const assigned = active.filter((x) => x.services.some((a) => a.businessServiceId === serviceId));
  return assigned.length ? assigned : active;
}

/**
 * A chosen staff member who does not perform the newly chosen service is cleared (the server would refuse the booking
 * with STAFF_NOT_ASSIGNED); a fitting choice is kept.
 */
export function keepStaffFor(staff: StaffWire[], serviceId: number | null, staffId: number | null): number | null {
  if (staffId === null) return null;
  return staffForService(staff, serviceId).some((x) => x.id === staffId) ? staffId : null;
}

/** A booking-link request's outcome in words — its appointment's cancellation wins over "אושרה" (a customer can cancel an approved booking). */
export function requestOutcome(r: { status: string; appointment: { status: string } }): { label: string; tone: "ok" | "off" } {
  if (r.status === "APPROVED" && r.appointment.status === "CANCELED") return { label: "התור בוטל", tone: "off" };
  return { label: REQUEST_STATUS_LABEL[r.status] ?? r.status, tone: r.status === "APPROVED" ? "ok" : "off" };
}

/**
 * Booking-link settings that leave the link with nothing a customer can book, said before saving makes it so:
 * "the customer must choose a staff member" while staff names are hidden offers no staff to choose — every service
 * becomes unbookable (the public page's rule, public-booking-model serviceBookable).
 */
export function bookingDeadEnd(s: { staffChoiceMode: string; showStaffNames: boolean }, hasStaff: boolean): string | null {
  if (hasStaff && s.staffChoiceMode === "REQUIRED" && !s.showStaffNames) {
    return "בחירת עובד מוגדרת כחובה, אבל שמות העובדים מוסתרים — כך אף שירות לא יוצג ללקוחות. אפשר להציג את השמות, או לשנות את הבחירה ל„אם רוצה”.";
  }
  return null;
}

// ── Who performs what: one rule for the service page and the staff page ─────────────────────────────

export type AssignAxis = { kind: "service"; serviceId: number } | { kind: "staff"; staffId: number };
/** The editor's picture: per row (a staff member on a service page, a service on a staff page) → its own length or null. */
export type AssignPick = Map<number, number | null>;

/** What the server holds today for one axis, in the editor's terms. */
export function currentPick(staff: StaffWire[], axis: AssignAxis): AssignPick {
  if (axis.kind === "staff") {
    const m = staff.find((x) => x.id === axis.staffId);
    return new Map((m?.services ?? []).map((x) => [x.businessServiceId, x.durationOverrideMinutes]));
  }
  const out: AssignPick = new Map();
  for (const m of staff) {
    if (!m.active) continue;
    const a = m.services.find((x) => x.businessServiceId === axis.serviceId);
    if (a) out.set(m.id, a.durationOverrideMinutes);
  }
  return out;
}

export function samePick(a: AssignPick, b: AssignPick): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k) === v);
}

/**
 * The writes that make the server hold `want` for one axis — read-modify-write on the staff members' CURRENT lists
 * (`fresh`, read right before saving): only this axis's entries change, every other assignment and its own length is
 * carried over exactly, and each write is one staff member's whole list sent with the version it was read at.
 */
export function assignmentWrites(fresh: StaffWire[], axis: AssignAxis, want: AssignPick): Array<{ member: StaffWire; services: StaffWire["services"] }> {
  const out: Array<{ member: StaffWire; services: StaffWire["services"] }> = [];
  if (axis.kind === "staff") {
    const member = fresh.find((x) => x.id === axis.staffId);
    if (!member) return out;
    const services = [...want].map(([businessServiceId, durationOverrideMinutes]) => ({ businessServiceId, durationOverrideMinutes }));
    if (!samePick(currentPick(fresh, axis), want)) out.push({ member, services });
    return out;
  }
  for (const member of fresh.filter((m) => m.active)) {
    const has = member.services.find((x) => x.businessServiceId === axis.serviceId);
    const wanted = want.has(member.id);
    const override = want.get(member.id) ?? null;
    if (!has && !wanted) continue;
    if (has && wanted && has.durationOverrideMinutes === override) continue;
    const others = member.services.filter((x) => x.businessServiceId !== axis.serviceId);
    out.push({ member, services: wanted ? [...others, { businessServiceId: axis.serviceId, durationOverrideMinutes: override }] : others });
  }
  return out;
}

