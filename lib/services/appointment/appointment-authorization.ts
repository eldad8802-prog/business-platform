/**
 * Appointments — the ONE authorization decision for every appointment action (milestone A).
 *
 * Today Dubiz has one kind of principal on a business: its owner, signed in. Every action is the owner's. This
 * function exists so that the day staff or partners get their own access, it is decided here — from Dubiz settings,
 * the platform's single permission model — and nowhere else: the routes, the services and the bot never carry their
 * own rule. There is deliberately no appointment-specific permission system, and no staff login.
 */
import { AppointmentServiceError } from "./appointment-errors";

/** Built by the route from the verified session only — never from a request body or a route id. */
export type AppointmentPrincipal = { kind: "OWNER"; businessId: number; userId: number };

export type AppointmentAction =
  | "appointment.read"
  | "appointment.create"
  | "appointment.reschedule"
  | "appointment.status"
  | "appointment.edit"
  | "staff.read"
  | "staff.manage"
  | "availability.read"
  | "availability.manage"
  | "policy.read"
  | "policy.manage";

const OWNER_ACTIONS: ReadonlySet<AppointmentAction> = new Set<AppointmentAction>([
  "appointment.read", "appointment.create", "appointment.reschedule", "appointment.status", "appointment.edit",
  "staff.read", "staff.manage", "availability.read", "availability.manage", "policy.read", "policy.manage",
]);

const positive = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** Allows, or throws FORBIDDEN. Fail-closed: an unknown principal or action is refused. */
export function authorizeAppointmentAction(principal: AppointmentPrincipal | null | undefined, action: AppointmentAction): void {
  if (!principal || principal.kind !== "OWNER" || !positive(principal.businessId) || !positive(principal.userId)) {
    throw new AppointmentServiceError("FORBIDDEN");
  }
  if (!OWNER_ACTIONS.has(action)) throw new AppointmentServiceError("FORBIDDEN");
}
