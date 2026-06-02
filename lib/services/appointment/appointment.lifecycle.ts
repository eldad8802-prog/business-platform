/**
 * Appointment lifecycle — single source of truth for status transitions.
 *
 * Every lifecycle mutation in appointment.service MUST go through
 * `assertTransition`. No other module may define transition rules.
 *
 *   PROPOSED  → CONFIRMED | CANCELED
 *   CONFIRMED → COMPLETED | NO_SHOW | CANCELED
 *   COMPLETED → (terminal)
 *   NO_SHOW   → (terminal)
 *   CANCELED  → (terminal)
 */

import type { AppointmentStatus } from "@prisma/client";

export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  PROPOSED: ["CONFIRMED", "CANCELED"],
  CONFIRMED: ["COMPLETED", "NO_SHOW", "CANCELED"],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELED: [],
};

export function isTerminal(status: AppointmentStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export function canTransition(
  from: AppointmentStatus,
  to: AppointmentStatus
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: "invalid_transition" };

export function assertTransition(
  from: AppointmentStatus,
  to: AppointmentStatus
): TransitionCheck {
  return canTransition(from, to)
    ? { ok: true }
    : { ok: false, reason: "invalid_transition" };
}
