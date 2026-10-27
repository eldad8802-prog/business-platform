/**
 * Public booking — settling a request when its appointment changes status through the calendar (changeStatus). Kept
 * apart from the booking services so the calendar service can call it without importing them. SERVER-ONLY.
 */
import type { Prisma } from "@prisma/client";

import { AppointmentServiceError } from "@/lib/services/appointment/appointment-errors";

import { resolveRequestNotification } from "./booking-notify";

type Tx = Prisma.TransactionClient;

/**
 * The appointment of a public request changed status through the calendar: settle the request in the SAME transaction.
 *   PROPOSED → CONFIRMED   the request is APPROVED (refused when it already lapsed: REQUEST_EXPIRED);
 *   PROPOSED → CANCELED    the request is DECLINED;
 * Anything else leaves the request as it is. Called only for appointments that have a request.
 */
export async function settleRequestForStatus(tx: Tx, businessId: number, appointmentId: number, from: string, to: string, userId: number, now: Date): Promise<void> {
  const r = await tx.bookingRequest.findFirst({ where: { businessId, appointmentId } });
  if (!r || r.status !== "PENDING" || from !== "PROPOSED") return;
  if (to === "CONFIRMED") {
    if (r.expiresAt <= now) throw new AppointmentServiceError("REQUEST_EXPIRED");
    await tx.bookingRequest.update({ where: { id: r.id }, data: { status: "APPROVED", decidedAt: now, decidedByUserId: userId } });
  } else if (to === "CANCELED") {
    await tx.bookingRequest.update({ where: { id: r.id }, data: { status: "DECLINED", decidedAt: now, decidedByUserId: userId } });
  } else {
    return;
  }
  await resolveRequestNotification(tx, businessId, r.id, now);
}

/** Whether DECLINED may be used: only for an appointment that still has a pending public request. */
export async function hasPendingRequest(tx: Tx, businessId: number, appointmentId: number): Promise<boolean> {
  return (await tx.bookingRequest.count({ where: { businessId, appointmentId, status: "PENDING" } })) > 0;
}

