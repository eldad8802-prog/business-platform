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
 * NOTE: `userId` is required because `Appointment.createdByUserId` is NOT NULL
 * (Step 1 schema). BOT/SYSTEM have architectural support via `actor`, but a real
 * bot/system flow (service account) is intentionally out of scope for Step 2.
 */
export type ActorContext = {
  actor: CreatedByActor;
  userId: number;
  sourceChannel: SourceChannel;
};

/** Optional relational links for a direct create. */
export type AppointmentLinks = {
  conversationId?: number | null;
  messageId?: number | null;
  customerId?: number | null;
  leadId?: number | null;
};

/** Optional schedulable details. MVP keeps all nullable (no NLU parsing). */
export type AppointmentDetails = {
  startsAt?: Date | null;
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
};

/** Lifecycle / reschedule operation inputs. */
export type LifecycleInput = {
  appointmentId: number;
  businessId: number;
  actor: ActorContext;
};

export type CancelInput = LifecycleInput & {
  /** Optional reason, appended to notes (no separate column in MVP). */
  reason?: string | null;
};

export type RescheduleInput = LifecycleInput & {
  startsAt: Date;
  durationMinutes?: number | null;
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
  | "pending_malformed";

export type AppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: AppointmentErrorReason };

export type { Appointment, AppointmentStatus, CreatedByActor, SourceChannel };
