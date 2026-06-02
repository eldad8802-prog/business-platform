/**
 * Pending state on Conversation — Follow-Up + Appointment Request.
 *
 * MVP rule: AT MOST ONE open Follow-Up and AT MOST ONE open Appointment Request
 * per conversation. Owner-driven persistence only — no scheduler, no worker, no
 * reminder engine. All reads/writes for these two JSON columns MUST flow through
 * this module so the shape stays under our control.
 *
 * Scope boundary: this file lives inside the Conversations module and only
 * touches `Conversation.pendingFollowUp` / `Conversation.pendingAppointmentRequest`.
 * It does NOT call any Task, Calendar, Worker, Business Status, or
 * ReplySuggestion code path.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type PendingFollowUp = {
  /** ISO-8601 UTC timestamp when the owner created the follow-up. */
  createdAt: string;
  /** Business owner / user who created the follow-up. */
  createdByOwnerId: number;
  /** The customer message that prompted the follow-up (Message.id). */
  originMessageId: number;
  /** Free-text note from the owner. Empty string allowed; null when absent. */
  note: string | null;
};

export type PendingAppointmentRequest = {
  /** ISO-8601 UTC timestamp when the owner created the request. */
  createdAt: string;
  /** Business owner / user who created the request. */
  createdByOwnerId: number;
  /** The customer message that prompted the request (Message.id). */
  originMessageId: number;
  /**
   * Verbatim hint from the customer about when they want the appointment.
   * Stored as-is; NOT parsed into a date in MVP.
   */
  customerHint: string | null;
};

type SetResult<T> =
  | { ok: true; pending: T }
  | { ok: false; reason: "already_exists"; pending: T }
  | { ok: false; reason: "conversation_not_found" };

type ClearResult =
  | { ok: true }
  | { ok: false; reason: "conversation_not_found" };

function parsePendingFollowUp(raw: unknown): PendingFollowUp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.createdAt !== "string") return null;
  if (typeof r.createdByOwnerId !== "number") return null;
  if (typeof r.originMessageId !== "number") return null;
  const note =
    r.note === null || r.note === undefined
      ? null
      : typeof r.note === "string"
      ? r.note
      : null;
  return {
    createdAt: r.createdAt,
    createdByOwnerId: r.createdByOwnerId,
    originMessageId: r.originMessageId,
    note,
  };
}

function parsePendingAppointmentRequest(
  raw: unknown
): PendingAppointmentRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.createdAt !== "string") return null;
  if (typeof r.createdByOwnerId !== "number") return null;
  if (typeof r.originMessageId !== "number") return null;
  const customerHint =
    r.customerHint === null || r.customerHint === undefined
      ? null
      : typeof r.customerHint === "string"
      ? r.customerHint
      : null;
  return {
    createdAt: r.createdAt,
    createdByOwnerId: r.createdByOwnerId,
    originMessageId: r.originMessageId,
    customerHint,
  };
}

async function loadConversationScoped(
  conversationId: number,
  businessId: number
): Promise<{
  pendingFollowUp: unknown;
  pendingAppointmentRequest: unknown;
} | null> {
  const row = await prisma.conversation.findFirst({
    where: { id: conversationId, businessId },
    select: { pendingFollowUp: true, pendingAppointmentRequest: true },
  });
  return row;
}

export async function getOpenPendingState(
  conversationId: number,
  businessId: number
): Promise<{
  followUp: PendingFollowUp | null;
  appointment: PendingAppointmentRequest | null;
} | null> {
  const row = await loadConversationScoped(conversationId, businessId);
  if (!row) return null;
  return {
    followUp: parsePendingFollowUp(row.pendingFollowUp),
    appointment: parsePendingAppointmentRequest(row.pendingAppointmentRequest),
  };
}

export async function setPendingFollowUp(
  conversationId: number,
  businessId: number,
  input: {
    createdByOwnerId: number;
    originMessageId: number;
    note: string | null;
  }
): Promise<SetResult<PendingFollowUp>> {
  const row = await loadConversationScoped(conversationId, businessId);
  if (!row) return { ok: false, reason: "conversation_not_found" };

  const existing = parsePendingFollowUp(row.pendingFollowUp);
  if (existing) {
    return { ok: false, reason: "already_exists", pending: existing };
  }

  const pending: PendingFollowUp = {
    createdAt: new Date().toISOString(),
    createdByOwnerId: input.createdByOwnerId,
    originMessageId: input.originMessageId,
    note: input.note,
  };

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingFollowUp: pending },
  });

  return { ok: true, pending };
}

export async function clearPendingFollowUp(
  conversationId: number,
  businessId: number
): Promise<ClearResult> {
  const row = await loadConversationScoped(conversationId, businessId);
  if (!row) return { ok: false, reason: "conversation_not_found" };
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingFollowUp: Prisma.DbNull },
  });
  return { ok: true };
}

export async function setPendingAppointmentRequest(
  conversationId: number,
  businessId: number,
  input: {
    createdByOwnerId: number;
    originMessageId: number;
    customerHint: string | null;
  }
): Promise<SetResult<PendingAppointmentRequest>> {
  const row = await loadConversationScoped(conversationId, businessId);
  if (!row) return { ok: false, reason: "conversation_not_found" };

  const existing = parsePendingAppointmentRequest(row.pendingAppointmentRequest);
  if (existing) {
    return { ok: false, reason: "already_exists", pending: existing };
  }

  const pending: PendingAppointmentRequest = {
    createdAt: new Date().toISOString(),
    createdByOwnerId: input.createdByOwnerId,
    originMessageId: input.originMessageId,
    customerHint: input.customerHint,
  };

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingAppointmentRequest: pending },
  });

  return { ok: true, pending };
}

export async function clearPendingAppointmentRequest(
  conversationId: number,
  businessId: number
): Promise<ClearResult> {
  const row = await loadConversationScoped(conversationId, businessId);
  if (!row) return { ok: false, reason: "conversation_not_found" };
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { pendingAppointmentRequest: Prisma.DbNull },
  });
  return { ok: true };
}

/**
 * Transaction-aware clear of the Appointment Request pending state.
 *
 * Minimal helper added for the Appointment service's atomic conversion: it lets
 * `createFromPending` create the Appointment and clear the pending intent inside
 * ONE transaction (so the two never coexist after commit). Caller is responsible
 * for businessId scoping before calling. Behavior of the public set/clear/get
 * functions above is unchanged.
 */
export async function clearPendingAppointmentRequestTx(
  tx: Prisma.TransactionClient,
  conversationId: number
): Promise<void> {
  await tx.conversation.update({
    where: { id: conversationId },
    data: { pendingAppointmentRequest: Prisma.DbNull },
  });
}

/** Pure parser exports — for the serializer which already holds the JSON. */
export const __parsers = {
  followUp: parsePendingFollowUp,
  appointment: parsePendingAppointmentRequest,
};
