/**
 * Arrival, lateness and status correction (G6) — the PURE rules, shared by the server and the calendar screens.
 * No DB, no clock of its own: every function takes the instant it reasons about.
 *
 *   ARRIVED       the customer is here: "Appointment"."actualStartedAt" is stamped (the column milestone A made for
 *                 the actual start). Not a status: the appointment stays CONFIRMED until the owner records the outcome.
 *   late          COMPUTED, never stored: arrived after the start (actualStartedAt − startsAt), or not arrived yet
 *                 while the start has passed. A few minutes of grace before anything is called late.
 *   correction    the owner fixes a wrongly set FINAL status. The wrong mark was set from CONFIRMED (every outcome and a
 *                 cancellation are reachable from it), so the corrected status is one the lifecycle itself allows from
 *                 CONFIRMED — or CONFIRMED again (undo). Nothing else: a correction never invents a transition.
 */
import type { AppointmentKind, AppointmentStatus } from "@prisma/client";

import { ALLOWED_TRANSITIONS, isTerminal } from "./appointment.lifecycle";

const MINUTE = 60_000;
/** Minutes after the start before a customer counts as late. */
export const LATE_GRACE_MINUTES = 5;
/** The earliest a customer may be marked as arrived: this many minutes before the start. */
export const ARRIVAL_EARLIEST_MINUTES = 180;

type Timed = { kind: AppointmentKind; status: AppointmentStatus; startsAt: Date | string | null; actualStartedAt?: Date | string | null };
const ms = (v: Date | string | null | undefined): number | null => (v === null || v === undefined ? null : typeof v === "string" ? Date.parse(v) : v.getTime());

export type Lateness =
  | { state: "none" }
  | { state: "late"; minutes: number }
  | { state: "arrived"; minutes: 0 }
  | { state: "arrived_late"; minutes: number };

/** How late a customer is (or was), computed from the row and `now`. Customer appointments only. */
export function lateness(a: Timed, now: Date): Lateness {
  const start = ms(a.startsAt);
  if (a.kind !== "CUSTOMER" || start === null) return { state: "none" };
  const arrived = ms(a.actualStartedAt);
  if (arrived !== null) {
    const late = Math.floor((arrived - start) / MINUTE);
    return late > LATE_GRACE_MINUTES ? { state: "arrived_late", minutes: late } : { state: "arrived", minutes: 0 };
  }
  if (a.status !== "CONFIRMED") return { state: "none" };
  const late = Math.floor((now.getTime() - start) / MINUTE);
  return late > LATE_GRACE_MINUTES ? { state: "late", minutes: late } : { state: "none" };
}

export type ArrivalRefusal = "NO_CUSTOMER" | "NOT_CONFIRMED" | "ALREADY_ARRIVED" | "TOO_EARLY";

/** Why an arrival cannot be recorded now, or null. */
export function arrivalRefusal(a: Timed, now: Date): ArrivalRefusal | null {
  if (a.kind !== "CUSTOMER") return "NO_CUSTOMER";
  if (a.status !== "CONFIRMED") return "NOT_CONFIRMED";
  if (ms(a.actualStartedAt) !== null) return "ALREADY_ARRIVED";
  const start = ms(a.startsAt);
  if (start === null || now.getTime() < start - ARRIVAL_EARLIEST_MINUTES * MINUTE) return "TOO_EARLY";
  return null;
}

/** The closed reasons a correction is journalled with (the journal holds tokens only — free text goes to the notes). */
export const CORRECTION_REASONS = ["WRONG_MARK", "CUSTOMER_CAME", "CUSTOMER_DID_NOT_COME", "NOT_CANCELED", "OTHER"] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

/**
 * The statuses a final status may be corrected to. Only a final status is corrected (a live one has its ordinary
 * actions). Targets = CONFIRMED (undo) ∪ what the lifecycle allows from CONFIRMED, minus where it stands, filtered
 * by kind: a no-show needs a customer, a block is only ever on or off.
 */
export function correctionTargets(a: Pick<Timed, "kind" | "status">): AppointmentStatus[] {
  if (!isTerminal(a.status)) return [];
  const all: AppointmentStatus[] = ["CONFIRMED", ...ALLOWED_TRANSITIONS.CONFIRMED];
  return all.filter((to) => {
    if (to === a.status) return false;
    if (a.kind === "BLOCK") return to === "CONFIRMED" && a.status === "CANCELED";
    if (to === "NO_SHOW" && a.kind !== "CUSTOMER") return false;
    return true;
  });
}
