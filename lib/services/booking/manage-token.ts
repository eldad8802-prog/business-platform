/**
 * The customer's manage link follows its appointment (G15 — appointments completion program, workstream G).
 * SERVER-ONLY.
 *
 * A manage link lives until MANAGE_LINK_GRACE_DAYS (7) after the appointment ENDS (booking.core manageLinkExpiry). When
 * the appointment is moved — by the owner (APPOINTMENT_RESCHEDULED), by the customer (SELF_RESCHEDULED) or, later, as
 * part of a series change (SERIES_CHANGED) — every live (unrevoked) link of it is re-anchored to the NEW end, inside the
 * same transaction as the move: a link never dies before an appointment that was pushed later, and never outlives by
 * weeks one that was pulled earlier. Bounded by the table's CHECK (≤ 400 days from the link's issue).
 *
 * Called from the journal (appointment-journal.ts appendAppointmentEvent), right after workstream F's customer-message
 * hook — so every writer that journals a move (and every writer must) re-anchors it; nothing else to remember.
 */
import type { Prisma } from "@prisma/client";

import { manageLinkExpiry } from "./booking.core";

type Tx = Prisma.TransactionClient;

const MOVES: ReadonlySet<string> = new Set(["APPOINTMENT_RESCHEDULED", "SELF_RESCHEDULED", "SERIES_CHANGED"]);

export async function followManageTokenExpiry(tx: Tx, f: { businessId: number; appointmentId: number; eventType: string; now?: Date }): Promise<number> {
  if (!MOVES.has(f.eventType)) return 0;
  const tokens = await tx.appointmentManageToken.findMany({
    where: { businessId: f.businessId, appointmentId: f.appointmentId, revokedAt: null },
    select: { id: true, createdAt: true, expiresAt: true },
  });
  if (tokens.length === 0) return 0;
  const appt = await tx.appointment.findFirst({ where: { id: f.appointmentId, businessId: f.businessId }, select: { startsAt: true, endsAt: true } });
  if (!appt?.startsAt) return 0;
  const now = f.now ?? new Date();
  let changed = 0;
  for (const t of tokens) {
    // An already expired link is not revived by a move.
    if (t.expiresAt.getTime() <= now.getTime()) continue;
    const next = manageLinkExpiry(now, appt.startsAt, appt.endsAt, t.createdAt);
    if (next.getTime() === t.expiresAt.getTime() || next.getTime() <= t.createdAt.getTime()) continue;
    await tx.appointmentManageToken.update({ where: { id: t.id }, data: { expiresAt: next } });
    changed += 1;
  }
  return changed;
}
