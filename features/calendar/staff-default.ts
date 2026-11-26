/**
 * G10 — who a new appointment is for, before the owner picks. PURE (the storage wrapper below never throws).
 *
 * The business's own lane ("ללא עובד / כל העסק") closes the time for EVERY staff lane, so it must never be chosen
 * silently. In order:
 *   1. the lane the owner tapped (or the lane the calendar is filtered to) — an explicit choice, kept as is, even the
 *      business's own lane;
 *   2. the last staff member this device booked for, while they are still active;
 *   3. the only active staff member;
 *   4. two or more active staff → no default: the form asks ("pending").
 * With no staff at all there is only the business's lane (null), and nothing to ask.
 */

export type StaffDefaultInput = {
  /** undefined = no lane was tapped; null = the business's own lane was tapped; a number = that staff lane. */
  tapped: number | null | undefined;
  /** The last staff member used on this device (from storage), or null. */
  lastUsed: number | null;
  /** Active staff ids, in the calendar's order. */
  activeStaffIds: number[];
};

export type StaffDefault = { staffId: number | null; pending: boolean; source: "tapped" | "last" | "only" | "none" | "ask" };

export function defaultStaffChoice(input: StaffDefaultInput): StaffDefault {
  const active = input.activeStaffIds;
  if (input.tapped !== undefined) {
    if (input.tapped === null || active.includes(input.tapped)) return { staffId: input.tapped, pending: false, source: "tapped" };
  }
  if (input.lastUsed !== null && active.includes(input.lastUsed)) return { staffId: input.lastUsed, pending: false, source: "last" };
  if (active.length === 1) return { staffId: active[0], pending: false, source: "only" };
  if (active.length === 0) return { staffId: null, pending: false, source: "none" };
  return { staffId: null, pending: true, source: "ask" };
}

const LAST_STAFF_KEY = "dubiz.calendar.lastStaffId";

/** The last staff member booked on this device, or null (private window, blocked storage, anything odd). */
export function readLastStaff(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_STAFF_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Remembers a staff lane booked on this device (a business-lane booking changes nothing). Never throws. */
export function rememberLastStaff(staffId: number | null): void {
  if (staffId === null) return;
  try {
    window.localStorage.setItem(LAST_STAFF_KEY, String(staffId));
  } catch {
    /* storage unavailable: the default simply falls back to the next rule */
  }
}
