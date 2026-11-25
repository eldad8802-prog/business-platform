/**
 * Arrival and status correction (G6). SERVER-ONLY. Both are owner writes through ownerWrite (the per-business lock, the
 * Idempotency-Key ledger, the optimistic version) and journalled in the same transaction.
 *
 *   markArrived     ARRIVED: stamps "actualStartedAt" (now). The status stays CONFIRMED — the outcome (התקיים / לא
 *                   הגיע) is still the owner's next step. Lateness is computed from the stamp, never stored.
 *   correctStatus   STATUS_CORRECTED: a wrongly set FINAL status is set right. The target is one the lifecycle allows
 *                   from CONFIRMED, or CONFIRMED itself (appointment-arrival.core); the outcome rule still holds (an
 *                   outcome only after the start, a no-show only for a customer). Re-opening a cancelled appointment
 *                   takes its time again, so it is re-checked under the lock (never forced). The reason is a closed
 *                   token in the journal; an optional free note goes to the appointment's notes. An appointment from
 *                   the public booking link is not corrected here (its request settled with it).
 */
import type { Appointment, AppointmentStatus, Prisma } from "@prisma/client";

import { recordSensor } from "@/lib/sensors/record-sensor";

import { outcomeRefusal, sensorWho } from "./appointment.service";
import { arrivalRefusal, correctionTargets, CORRECTION_REASONS, type CorrectionReason } from "./appointment-arrival.core";
import { authorizeAppointmentAction, type AppointmentPrincipal } from "./appointment-authorization";
import { AppointmentServiceError, invalid } from "./appointment-errors";
import { appendAppointmentEvent, instantToken } from "./appointment-journal";
import { mergeNote } from "./appointment-notes";
import { ownerWrite, type OwnerRequest } from "./appointment-request";
import { assertFree, loadOwn, materialize, ownerActor, type AppointmentWriteResult } from "./appointment-schedule.service";
import { occupiedRange } from "./availability.core";

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

function version(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPositiveInt(value)) throw invalid("expectedVersion");
  return value;
}

function checkVersion(current: Appointment, expected: number | undefined) {
  if (expected !== undefined && current.version !== expected) throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
}

// ── ARRIVED ─────────────────────────────────────────────────────────────────────────────────────

export async function markArrived(principal: AppointmentPrincipal, req: OwnerRequest, id: number, input: { expectedVersion?: unknown }): Promise<AppointmentWriteResult> {
  authorizeAppointmentAction(principal, "appointment.status");
  const expectedVersion = version(input.expectedVersion);
  const actor = ownerActor(principal);
  const out = await ownerWrite(principal, req, "POST /api/appointments/[id]/arrival", { id, expectedVersion }, async (ctx) => {
    const current = await loadOwn(ctx.tx, ctx.businessId, id);
    checkVersion(current, expectedVersion);
    const refusal = arrivalRefusal(current, ctx.now);
    if (refusal) throw new AppointmentServiceError("INVALID_TRANSITION", { reason: refusal });
    await ctx.tx.appointment.update({ where: { id: current.id }, data: { actualStartedAt: ctx.now, version: { increment: 1 } } });
    await appendAppointmentEvent(ctx.tx, {
      businessId: ctx.businessId, appointmentId: current.id, eventType: "ARRIVED", ctx: actor, idempotencyKey: ctx.key, digest: ctx.digest,
      payload: { arrivedAt: instantToken(ctx.now), startsAt: instantToken(current.startsAt) },
    });
    return { appointmentId: current.id };
  });
  return materialize(principal.businessId, out);
}

// ── STATUS_CORRECTED ────────────────────────────────────────────────────────────────────────────

export type CorrectStatusInput = { to?: unknown; reasonCode?: unknown; note?: unknown; expectedVersion?: unknown };

export async function correctStatus(principal: AppointmentPrincipal, req: OwnerRequest, id: number, input: CorrectStatusInput): Promise<AppointmentWriteResult> {
  authorizeAppointmentAction(principal, "appointment.status");
  const to = input.to as AppointmentStatus;
  if (!["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELED"].includes(to)) throw invalid("to");
  const reasonCode = input.reasonCode as CorrectionReason;
  if (!CORRECTION_REASONS.includes(reasonCode)) throw invalid("reasonCode");
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== "string" || input.note.length > 500) throw invalid("note");
    note = input.note.trim() || null;
  }
  const expectedVersion = version(input.expectedVersion);
  const actor = ownerActor(principal);

  const out = await ownerWrite(principal, req, "POST /api/appointments/[id]/correction", { id, to, reasonCode, note, expectedVersion }, async (ctx) => {
    const { tx, businessId } = ctx;
    const current = await loadOwn(tx, businessId, id);
    checkVersion(current, expectedVersion);
    if (current.sourceChannel === "PUBLIC_BOOKING") throw new AppointmentServiceError("INVALID_TRANSITION", { reason: "PUBLIC_BOOKING" });
    if (!correctionTargets(current).includes(to)) throw new AppointmentServiceError("INVALID_TRANSITION");
    const refusal = outcomeRefusal(current, to, ctx.now);
    if (refusal) throw new AppointmentServiceError("INVALID_TRANSITION", { reason: refusal === "not_started" ? "NOT_STARTED" : "NO_CUSTOMER" });
    // Back to CONFIRMED from CANCELED: the time is taken again — re-checked under the lock, never forced.
    if (to === "CONFIRMED" && current.status === "CANCELED" && current.startsAt && current.endsAt) {
      await assertFree(tx, businessId, current.staffMemberId, occupiedRange(current.startsAt, current.endsAt, current.bufferBeforeMinutes, current.bufferAfterMinutes), current.id);
    }
    const data: Prisma.AppointmentUpdateInput = { status: to, version: { increment: 1 }, holdExpiresAt: null };
    data.cancelReason = to === "CANCELED" ? "OWNER_CANCELED" : null;
    // A customer who did not come did not arrive; an outcome set back to CONFIRMED keeps a recorded arrival.
    if (to === "NO_SHOW") data.actualStartedAt = null;
    if (note) data.notes = mergeNote(current.notes, note);
    await tx.appointment.update({ where: { id: current.id }, data });
    if (current.kind === "CUSTOMER") {
      await recordSensor({
        businessId, sensor: "APPOINTMENT_STATUS_CHANGED", entityId: current.id, ...sensorWho(actor), payload: { from: current.status, to },
      }, { tx });
    }
    await appendAppointmentEvent(tx, {
      businessId, appointmentId: current.id, eventType: "STATUS_CORRECTED", ctx: actor, idempotencyKey: ctx.key, digest: ctx.digest,
      payload: { from: current.status, to, reasonCode },
    });
    return { appointmentId: current.id };
  });
  return materialize(principal.businessId, out);
}
