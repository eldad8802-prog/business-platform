/**
 * Appointment journal — the append-only record of every appointment change (milestone A).
 *
 * The database is the authority on its shape (migration 20261029090000): no UPDATE / DELETE for anyone, a payload of
 * short tokens only (no free text, ever), a user only on the owner's own actions. This module writes it from inside
 * the same transaction as the change it records, so a change without its event cannot commit.
 *
 * Owner decision 6: the actor is derived from the server-built ActorContext only. An OWNER action names the owner's
 * user; a CUSTOMER action is a CUSTOMER event with no user; a BOT or SYSTEM action is a SYSTEM event with no user.
 */
import { randomUUID } from "node:crypto";
import type { AppointmentEventActor, AppointmentEventType, Prisma } from "@prisma/client";

import type { ActorContext } from "./appointment.types";

/** What a payload string may be — mirrors the CHECK AppointmentEvent_payload_closed. */
export const JOURNAL_TOKEN = /^[A-Za-z0-9_:.-]{0,64}$/;
/** What an idempotency key may be — mirrors the CHECK AppointmentEvent_tokens. */
export const JOURNAL_KEY = /^[A-Za-z0-9:_#-]{8,200}$/;

type Scalar = string | number | boolean | null;
export type JournalPayload = Record<string, Scalar | Scalar[]>;
export type JournalDigest = { value: string; keyId: string };

export function journalActor(ctx: ActorContext): { actor: AppointmentEventActor; actorUserId: number | null } {
  if (ctx.actor === "OWNER") return { actor: "OWNER_USER", actorUserId: ctx.userId };
  if (ctx.actor === "CUSTOMER") return { actor: "CUSTOMER", actorUserId: null };
  return { actor: "SYSTEM", actorUserId: null };
}

/** A key for a write that arrived without one (the paths that predate milestone A). Never reused. */
export function autoJournalKey(): string {
  return `auto-${randomUUID()}`;
}

/** An instant as a payload token (ISO 8601 is made of allowed characters only). */
export const instantToken = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** The first problem with a payload, or null. Checked before the write so a bad payload is a bug, not a 500 later. */
export function payloadProblem(payload: JournalPayload): string | null {
  for (const [key, value] of Object.entries(payload)) {
    if (!JOURNAL_TOKEN.test(key)) return `${key}: key`;
    const items = Array.isArray(value) ? value : [value];
    for (const v of items) {
      if (typeof v === "string" && !JOURNAL_TOKEN.test(v)) return `${key}: not a token`;
      if (typeof v === "number" && !Number.isFinite(v)) return `${key}: not finite`;
    }
  }
  return null;
}

export type JournalEntry = {
  businessId: number;
  appointmentId: number;
  eventType: AppointmentEventType;
  ctx: ActorContext;
  payload?: JournalPayload;
  /** The request's Idempotency-Key (the first event of a request carries it), else a fresh automatic key. */
  idempotencyKey?: string;
  digest?: JournalDigest | null;
  occurredAt?: Date;
};

export async function appendAppointmentEvent(tx: Prisma.TransactionClient, e: JournalEntry): Promise<void> {
  const payload = e.payload ?? {};
  const problem = payloadProblem(payload);
  if (problem) throw new Error(`appointment journal payload refused: ${e.eventType}.${problem}`);
  const key = e.idempotencyKey ?? autoJournalKey();
  if (!JOURNAL_KEY.test(key)) throw new Error("appointment journal key refused");
  const who = journalActor(e.ctx);
  await tx.appointmentEvent.create({
    data: {
      businessId: e.businessId,
      appointmentId: e.appointmentId,
      eventType: e.eventType,
      actor: who.actor,
      actorUserId: who.actorUserId,
      payload,
      idempotencyKey: key,
      requestDigest: e.digest?.value ?? null,
      digestKeyId: e.digest?.keyId ?? null,
      ...(e.occurredAt ? { occurredAt: e.occurredAt } : {}),
    },
  });
}
