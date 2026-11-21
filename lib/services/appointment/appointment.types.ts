/**
 * Appointment service — shared contracts (Step 2, service layer only).
 *
 * Channel-agnostic: every writer (Inbox owner, future Bot, future Mobile) passes
 * the same `ActorContext`. No UI, route, auth, or request-parsing types here.
 */

import type {
  Appointment,
  AppointmentStatus,
  CreatedByActor,
  SourceChannel,
} from "@prisma/client";

/**
 * Provenance + acting principal for any write. The same shape for all channels
 * so create/lifecycle logic never branches per channel.
 *
 * Owner decision 6 (milestone A): an OWNER action carries the owner's user id; a CUSTOMER, BOT or SYSTEM action
 * carries none (`userId: null`) — it is never attributed to the owner. The database enforces the first half
 * (Appointment_owner_has_user); `isValidActor` in the service enforces both.
 */
export type ActorContext = {
  actor: CreatedByActor;
  userId: number | null;
  sourceChannel: SourceChannel;
};

/** Optional relational links for a direct create. */
export type AppointmentLinks = {
  conversationId?: number | null;
  messageId?: number | null;
  customerId?: number | null;
  leadId?: number | null;
  /** Catalog service the owner selected. Free-text titles are not matched to this. */
  businessServiceId?: number | null;
};

/**
 * Optional details of an UNTIMED appointment. There is no start time here (P0-2): a time is set only through
 * appointment-schedule.service (createAppointment / moveAppointment), under the per-business lock.
 */
export type AppointmentDetails = {
  durationMinutes?: number | null;
  title?: string | null;
  notes?: string | null;
};

/** Direct creation (shared primitive; also used by createFromPending). */
export type CreateInput = {
  businessId: number;
  actor: ActorContext;
  links?: AppointmentLinks;
  details?: AppointmentDetails;
};

/** Conversion from a Pending Appointment Request on a conversation. */
export type CreateFromPendingInput = {
  conversationId: number;
  businessId: number;
  actor: ActorContext;
  /** Set only when the owner selected a service. The pending hint is not parsed. */
  businessServiceId?: number | null;
};

/** Business-level outcomes — returned, never thrown. */
export type AppointmentErrorReason =
  | "conversation_not_found"
  | "appointment_not_found"
  | "no_pending"
  | "already_converted"
  | "invalid_transition"
  | "forbidden_business"
  | "invalid_input"
  | "pending_malformed"
  | "service_not_found";

export type AppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: AppointmentErrorReason };

export type { Appointment, AppointmentStatus, CreatedByActor, SourceChannel };
