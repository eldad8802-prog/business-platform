/**
 * Appointment service — business logic layer (Step 2, service only).
 *
 * Source of truth for the Appointment object. Channel-agnostic, bot-compatible:
 * Inbox / Bot / Mobile all write through this module. No routes, UI, calendar,
 * timeline, reminders, scheduling, or bot wiring here.
 *
 * Conventions:
 *   - Every operation is scoped by businessId before any write (tenant isolation).
 *   - Expected business outcomes are RETURNED as result objects, never thrown.
 *   - Lifecycle transitions go exclusively through appointment.lifecycle.
 *   - Conversion (createFromPending) is atomic: create + clear-pending in ONE tx.
 *
 * Milestone A (migration 20261029090000) — additive, the existing paths keep their behaviour:
 *   - Owner decision 6: an OWNER action needs the owner's user; a CUSTOMER / BOT / SYSTEM action carries none.
 *   - Every write appends to the append-only journal (AppointmentEvent) in the same transaction.
 *   - Learning sensors fire for CUSTOMER appointments only: an internal meeting or a time block is not demand and
 *     must not move no-show / cancellation / reschedule shares (APPT-01..04).
 *   - A timed appointment (one with an end time) is moved by appointment-schedule.service, which checks overlap;
 *     `reschedule` here keeps moving the untimed rows the existing paths create, exactly as before.
 */

import { Prisma, type Appointment, type AppointmentCancelReason } from "@prisma/client";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  __parsers,
  clearPendingAppointmentRequestTx,
} from "@/lib/services/conversation/pending-state.service";
import { recordOfferingDemand } from "@/lib/services/offering/offering-demand";
import { assertTransition, isTerminal } from "./appointment.lifecycle";
import { appendAppointmentEvent, instantToken, type JournalDigest } from "./appointment-journal";
import type {
  AppointmentResult,
  AppointmentStatus,
  ActorContext,
  CreateInput,
  CreateFromPendingInput,
  LifecycleInput,
  CancelInput,
  RescheduleInput,
} from "./appointment.types";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { isValidActor, sensorWho } from "./appointment-actor";

export { isValidActor, sensorWho };

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

async function selectedService(
  tx: Prisma.TransactionClient,
  businessId: number,
  businessServiceId: number | null | undefined
) {
  if (businessServiceId === undefined || businessServiceId === null) return null;
  if (!isPositiveInt(businessServiceId)) return "invalid" as const;
  const service = await tx.businessService.findFirst({
    where: { id: businessServiceId, businessId, active: true },
    select: { id: true, name: true, durationMinutes: true },
  });
  return service;
}

function mergeNote(existing: string | null, addition: string | null): string | null {
  const add = addition?.trim();
  if (!add) return existing;
  return existing && existing.trim().length > 0 ? `${existing}\n${add}` : add;
}

/**
 * Direct creation primitive. Shared by createFromPending. Optional conversation
 * link triggers tenant check + duplicate guard. Always yields PROPOSED.
 */
export async function create(input: CreateInput): Promise<AppointmentResult> {
  if (!isPositiveInt(input?.businessId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!isValidActor(input.actor)) {
    return { ok: false, reason: "invalid_input" };
  }
  const duration = input.details?.durationMinutes ?? null;
  if (duration !== null && !isPositiveInt(duration)) {
    return { ok: false, reason: "invalid_input" };
  }

  // CUTOVER-2A: Appointment is a P4-B pilot table. A bare $transaction opens
  // a transaction with NO app.current_business_id, so under FORCE RLS its reads
  // return nothing and its writes are refused.
  return tenantTx(input.businessId, (tx) => createWithinTx(tx, input));
}

async function createWithinTx(
  tx: Prisma.TransactionClient,
  input: CreateInput
): Promise<AppointmentResult> {
  const conversationId = input.links?.conversationId ?? null;

  if (conversationId !== null) {
    const conv = await tx.conversation.findFirst({
      where: { id: conversationId, businessId: input.businessId },
      select: { id: true },
    });
    if (!conv) return { ok: false, reason: "conversation_not_found" };

    const activeCount = await tx.appointment.count({
      where: {
        businessId: input.businessId,
        sourceConversationId: conversationId,
        status: { not: "CANCELED" },
      },
    });
    if (activeCount > 0) return { ok: false, reason: "already_converted" };
  }

  const service = await selectedService(tx, input.businessId, input.links?.businessServiceId);
  if (service === "invalid") return { ok: false, reason: "invalid_input" };
  if (input.links?.businessServiceId && !service) {
    return { ok: false, reason: "service_not_found" };
  }

  const appointment = await tx.appointment.create({
    data: {
      businessId: input.businessId,
      status: "PROPOSED",
      startsAt: input.details?.startsAt ?? null,
      durationMinutes: input.details?.durationMinutes ?? service?.durationMinutes ?? null,
      title: input.details?.title ?? service?.name ?? null,
      notes: input.details?.notes ?? null,
      createdByActor: input.actor.actor,
      sourceChannel: input.actor.sourceChannel,
      createdByUserId: input.actor.userId,
      sourceConversationId: conversationId,
      sourceMessageId: input.links?.messageId ?? null,
      customerId: input.links?.customerId ?? null,
      leadId: input.links?.leadId ?? null,
      businessServiceId: service?.id ?? null,
    },
  });

  if (service) {
    const signal = await recordOfferingDemand(tx, {
      businessId: input.businessId,
      kind: "SERVICE",
      offeringId: service.id,
      signalType: "BOOKING",
      source: "APPOINTMENT",
      appointmentId: appointment.id,
      idempotencyKey: `booking:appointment:${appointment.id}`,
    });
    if (!signal) throw new Error("booking evidence was not written");
  }

  await appendAppointmentEvent(tx, {
    businessId: input.businessId,
    appointmentId: appointment.id,
    eventType: "APPOINTMENT_CREATED",
    ctx: input.actor,
    payload: { kind: appointment.kind, status: appointment.status, channel: appointment.sourceChannel, timed: false },
  });

  return { ok: true, appointment };
}

/**
 * Atomic conversion: Pending Appointment Request -> Appointment(PROPOSED).
 * Load pending -> validate -> create -> clear pending -> commit, in ONE tx.
 */
export async function createFromPending(
  input: CreateFromPendingInput
): Promise<AppointmentResult> {
  if (!isPositiveInt(input?.conversationId) || !isPositiveInt(input?.businessId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!isValidActor(input.actor)) {
    return { ok: false, reason: "invalid_input" };
  }

  return tenantTx(input.businessId, async (tx) => {
    const conv = await tx.conversation.findFirst({
      where: { id: input.conversationId, businessId: input.businessId },
      select: {
        id: true,
        customerId: true,
        leadId: true,
        pendingAppointmentRequest: true,
      },
    });
    if (!conv) return { ok: false, reason: "conversation_not_found" };

    const raw = conv.pendingAppointmentRequest;
    if (raw === null || raw === undefined) {
      return { ok: false, reason: "no_pending" };
    }
    const pending = __parsers.appointment(raw);
    if (!pending) return { ok: false, reason: "pending_malformed" };

    const activeCount = await tx.appointment.count({
      where: {
        businessId: input.businessId,
        sourceConversationId: input.conversationId,
        status: { not: "CANCELED" },
      },
    });
    if (activeCount > 0) return { ok: false, reason: "already_converted" };

    const service = await selectedService(tx, input.businessId, input.businessServiceId);
    if (service === "invalid") return { ok: false, reason: "invalid_input" };
    if (input.businessServiceId && !service) {
      return { ok: false, reason: "service_not_found" };
    }

    const appointment = await tx.appointment.create({
      data: {
        businessId: input.businessId,
        status: "PROPOSED",
        startsAt: null,
        durationMinutes: service?.durationMinutes ?? null,
        title: service?.name ?? null,
        notes: pending.customerHint,
        createdByActor: input.actor.actor,
        sourceChannel: input.actor.sourceChannel,
        createdByUserId: input.actor.userId,
        sourceConversationId: input.conversationId,
        sourceMessageId: pending.originMessageId,
        customerId: conv.customerId,
        leadId: conv.leadId,
        businessServiceId: service?.id ?? null,
      },
    });

    if (service) {
      const signal = await recordOfferingDemand(tx, {
        businessId: input.businessId,
        kind: "SERVICE",
        offeringId: service.id,
        signalType: "BOOKING",
        source: "APPOINTMENT",
        appointmentId: appointment.id,
        idempotencyKey: `booking:appointment:${appointment.id}`,
      });
      if (!signal) throw new Error("booking evidence was not written");
    }

    await clearPendingAppointmentRequestTx(tx, input.conversationId);

    await appendAppointmentEvent(tx, {
      businessId: input.businessId,
      appointmentId: appointment.id,
      eventType: "APPOINTMENT_CREATED",
      ctx: input.actor,
      payload: { kind: appointment.kind, status: appointment.status, channel: appointment.sourceChannel, timed: false, fromPending: true },
    });

    return { ok: true, appointment };
  });
}

const EVENT_FOR: Record<AppointmentStatus, "APPOINTMENT_CONFIRMED" | "APPOINTMENT_COMPLETED" | "APPOINTMENT_NO_SHOW" | "APPOINTMENT_CANCELED" | null> = {
  PROPOSED: null,
  CONFIRMED: "APPOINTMENT_CONFIRMED",
  COMPLETED: "APPOINTMENT_COMPLETED",
  NO_SHOW: "APPOINTMENT_NO_SHOW",
  CANCELED: "APPOINTMENT_CANCELED",
};

export type TransitionOptions = {
  appendNote?: string | null;
  cancelReason?: AppointmentCancelReason | null;
  /** The request's Idempotency-Key and digest (owner API); absent on the paths that predate milestone A. */
  journalKey?: string;
  digest?: JournalDigest | null;
};

/**
 * One lifecycle move of an already-loaded, already-scoped appointment, inside the caller's tenant transaction:
 * the single-source guard, the closed cancel reason, the version, the learning sensor (customer appointments only)
 * and the journal — together or not at all.
 */
export async function transitionWithinTx(
  tx: Prisma.TransactionClient,
  current: Appointment,
  to: AppointmentStatus,
  ctx: ActorContext,
  opts: TransitionOptions = {}
): Promise<AppointmentResult> {
  const check = assertTransition(current.status, to);
  if (!check.ok) return { ok: false, reason: "invalid_transition" };

  const data: Prisma.AppointmentUpdateInput = { status: to, version: { increment: 1 } };
  if (opts.appendNote) {
    data.notes = mergeNote(current.notes, opts.appendNote);
  }
  if (to === "CANCELED") {
    data.cancelReason = opts.cancelReason ?? (ctx.actor === "OWNER" ? "OWNER_CANCELED" : ctx.actor === "CUSTOMER" ? "CUSTOMER_CANCELED" : "OTHER");
  }
  if (to !== "PROPOSED") data.holdExpiresAt = null;

  const appointment = await tx.appointment.update({
    where: { id: current.id },
    data,
  });

  // M5.5 — a real lifecycle move, atomic with it. The cancel reason (free text) stays in notes.
  if (current.status !== to && current.kind === "CUSTOMER") {
    await recordSensor(
      {
        businessId: current.businessId,
        sensor: "APPOINTMENT_STATUS_CHANGED",
        entityId: appointment.id,
        ...sensorWho(ctx),
        payload: { from: current.status, to },
      },
      { tx }
    );
  }
  const eventType = EVENT_FOR[to];
  if (eventType) {
    await appendAppointmentEvent(tx, {
      businessId: current.businessId,
      appointmentId: appointment.id,
      eventType,
      ctx,
      idempotencyKey: opts.journalKey,
      digest: opts.digest ?? null,
      payload: { from: current.status, to, ...(to === "CANCELED" ? { cancelReason: appointment.cancelReason } : {}) },
    });
  }
  return { ok: true, appointment };
}

/** Shared lifecycle transition with businessId scoping + single-source guard. */
async function transition(
  input: LifecycleInput,
  to: AppointmentStatus,
  opts: TransitionOptions = {}
): Promise<AppointmentResult> {
  if (!isPositiveInt(input?.appointmentId) || !isPositiveInt(input?.businessId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!isValidActor(input.actor)) {
    return { ok: false, reason: "invalid_input" };
  }

  return tenantTx(input.businessId, async (tx) => {
    const current = await tx.appointment.findFirst({
      where: { id: input.appointmentId, businessId: input.businessId },
    });
    if (!current) return { ok: false, reason: "appointment_not_found" };
    return transitionWithinTx(tx, current, to, input.actor, opts);
  });
}

export function confirm(input: LifecycleInput): Promise<AppointmentResult> {
  return transition(input, "CONFIRMED");
}

export function complete(input: LifecycleInput): Promise<AppointmentResult> {
  return transition(input, "COMPLETED");
}

export function markNoShow(input: LifecycleInput): Promise<AppointmentResult> {
  return transition(input, "NO_SHOW");
}

export function cancel(input: CancelInput): Promise<AppointmentResult> {
  return transition(input, "CANCELED", { appendNote: input.reason ?? null, cancelReason: input.cancelReason ?? null });
}

/**
 * Reschedule times only; status preserved. Forbidden in terminal states.
 * Untimed appointments only (the shape the existing creation paths write). A timed appointment occupies the
 * calendar and moves through appointment-schedule.service, which checks overlap; it is refused here.
 */
export async function reschedule(
  input: RescheduleInput
): Promise<AppointmentResult> {
  if (!isPositiveInt(input?.appointmentId) || !isPositiveInt(input?.businessId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!isValidActor(input.actor)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) {
    return { ok: false, reason: "invalid_input" };
  }
  const duration = input.durationMinutes ?? null;
  if (duration !== null && !isPositiveInt(duration)) {
    return { ok: false, reason: "invalid_input" };
  }

  return tenantTx(input.businessId, async (tx) => {
    const current = await tx.appointment.findFirst({
      where: { id: input.appointmentId, businessId: input.businessId },
    });
    if (!current) return { ok: false, reason: "appointment_not_found" };
    if (isTerminal(current.status)) {
      return { ok: false, reason: "invalid_transition" };
    }
    if (current.endsAt !== null) return { ok: false, reason: "invalid_input" };

    const appointment = await tx.appointment.update({
      where: { id: input.appointmentId },
      data: {
        startsAt: input.startsAt,
        durationMinutes: duration,
        version: { increment: 1 },
      },
    });

    // M5.5 — only a real change of time or length is a reschedule; a same-value save is not.
    const startChanged =
      (current.startsAt?.getTime() ?? null) !== input.startsAt.getTime();
    const durationChanged = (current.durationMinutes ?? null) !== duration;
    if (startChanged || durationChanged) {
      if (current.kind === "CUSTOMER") {
        await recordSensor(
          {
            businessId: input.businessId,
            sensor: "APPOINTMENT_RESCHEDULED",
            entityId: appointment.id,
            ...sensorWho(input.actor),
            payload: {
              previousStartsAt: current.startsAt ? current.startsAt.toISOString() : null,
              startsAt: input.startsAt.toISOString(),
              durationChanged,
            },
          },
          { tx }
        );
      }
      await appendAppointmentEvent(tx, {
        businessId: input.businessId,
        appointmentId: appointment.id,
        eventType: "APPOINTMENT_RESCHEDULED",
        ctx: input.actor,
        payload: {
          fromStartsAt: instantToken(current.startsAt),
          toStartsAt: instantToken(input.startsAt),
          durationChanged,
        },
      });
    }
    return { ok: true, appointment };
  });
}

/** Read helpers (source of truth), scoped by businessId. */
export async function getById(appointmentId: number, businessId: number) {
  if (!isPositiveInt(appointmentId) || !isPositiveInt(businessId)) return null;
  // CUTOVER-2A: Appointment is one of the five tables the P4-B pilot protected on
  // Preview only. Read inside the tenant transaction so the GUC is present once
  // RLS actually ships — a context-less read would return null and be
  // indistinguishable from "no such appointment".
  return tenantTx(businessId, (tx) =>
    tx.appointment.findFirst({
      where: { id: appointmentId, businessId },
    })
  );
}

export async function listForConversation(
  conversationId: number,
  businessId: number
) {
  if (!isPositiveInt(conversationId) || !isPositiveInt(businessId)) return [];
  return tenantTx(businessId, (tx) =>
    tx.appointment.findMany({
      where: { sourceConversationId: conversationId, businessId },
      orderBy: { createdAt: "desc" },
    })
  );
}
