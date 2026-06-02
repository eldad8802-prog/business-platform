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
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  __parsers,
  clearPendingAppointmentRequestTx,
} from "@/lib/services/conversation/pending-state.service";
import { assertTransition, isTerminal } from "./appointment.lifecycle";
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

const VALID_ACTORS = new Set(["OWNER", "BOT", "SYSTEM"]);
const VALID_CHANNELS = new Set([
  "INBOX_WEB",
  "MOBILE",
  "WHATSAPP_BOT",
  "PUBLIC_BOOKING",
  "EXTERNAL_API",
  "IMPORT",
]);

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isValidActor(actor: ActorContext | undefined): boolean {
  if (!actor) return false;
  if (!VALID_ACTORS.has(actor.actor)) return false;
  if (!VALID_CHANNELS.has(actor.sourceChannel)) return false;
  return isPositiveInt(actor.userId);
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

  return prisma.$transaction((tx) => createWithinTx(tx, input));
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

  const appointment = await tx.appointment.create({
    data: {
      businessId: input.businessId,
      status: "PROPOSED",
      startsAt: input.details?.startsAt ?? null,
      durationMinutes: input.details?.durationMinutes ?? null,
      title: input.details?.title ?? null,
      notes: input.details?.notes ?? null,
      createdByActor: input.actor.actor,
      sourceChannel: input.actor.sourceChannel,
      createdByUserId: input.actor.userId,
      sourceConversationId: conversationId,
      sourceMessageId: input.links?.messageId ?? null,
      customerId: input.links?.customerId ?? null,
      leadId: input.links?.leadId ?? null,
    },
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

  return prisma.$transaction(async (tx) => {
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

    const appointment = await tx.appointment.create({
      data: {
        businessId: input.businessId,
        status: "PROPOSED",
        startsAt: null,
        durationMinutes: null,
        title: null,
        notes: pending.customerHint,
        createdByActor: input.actor.actor,
        sourceChannel: input.actor.sourceChannel,
        createdByUserId: input.actor.userId,
        sourceConversationId: input.conversationId,
        sourceMessageId: pending.originMessageId,
        customerId: conv.customerId,
        leadId: conv.leadId,
      },
    });

    await clearPendingAppointmentRequestTx(tx, input.conversationId);

    return { ok: true, appointment };
  });
}

/** Shared lifecycle transition with businessId scoping + single-source guard. */
async function transition(
  input: LifecycleInput,
  to: AppointmentStatus,
  appendNote: string | null = null
): Promise<AppointmentResult> {
  if (!isPositiveInt(input?.appointmentId) || !isPositiveInt(input?.businessId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!isValidActor(input.actor)) {
    return { ok: false, reason: "invalid_input" };
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.appointment.findFirst({
      where: { id: input.appointmentId, businessId: input.businessId },
    });
    if (!current) return { ok: false, reason: "appointment_not_found" };

    const check = assertTransition(current.status, to);
    if (!check.ok) return { ok: false, reason: "invalid_transition" };

    const data: Prisma.AppointmentUpdateInput = { status: to };
    if (appendNote) {
      data.notes = mergeNote(current.notes, appendNote);
    }

    const appointment = await tx.appointment.update({
      where: { id: input.appointmentId },
      data,
    });
    return { ok: true, appointment };
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
  return transition(input, "CANCELED", input.reason ?? null);
}

/** Reschedule times only; status preserved. Forbidden in terminal states. */
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

  return prisma.$transaction(async (tx) => {
    const current = await tx.appointment.findFirst({
      where: { id: input.appointmentId, businessId: input.businessId },
    });
    if (!current) return { ok: false, reason: "appointment_not_found" };
    if (isTerminal(current.status)) {
      return { ok: false, reason: "invalid_transition" };
    }

    const appointment = await tx.appointment.update({
      where: { id: input.appointmentId },
      data: {
        startsAt: input.startsAt,
        durationMinutes: duration,
      },
    });
    return { ok: true, appointment };
  });
}

/** Read helpers (source of truth), scoped by businessId. */
export async function getById(appointmentId: number, businessId: number) {
  if (!isPositiveInt(appointmentId) || !isPositiveInt(businessId)) return null;
  return prisma.appointment.findFirst({
    where: { id: appointmentId, businessId },
  });
}

export async function listForConversation(
  conversationId: number,
  businessId: number
) {
  if (!isPositiveInt(conversationId) || !isPositiveInt(businessId)) return [];
  return prisma.appointment.findMany({
    where: { sourceConversationId: conversationId, businessId },
    orderBy: { createdAt: "desc" },
  });
}
