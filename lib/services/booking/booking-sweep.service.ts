/**
 * Public booking — the sweeper (D3). SERVER-ONLY. Runs without a session (Vercel cron, CRON_SECRET), every 10 minutes.
 *
 * booking_pending_due(now) hands it the identifiers of pending requests of live businesses that are either lapsed or
 * at least two hours old. For each, inside THAT business's tenant transaction and appointment lock:
 *   - lapsed (12 hours, or the appointment's start, whichever came first): the appointment PROPOSED → CANCELED
 *     (reason EXPIRED, actor SYSTEM, journalled), the request EXPIRED, its notification resolved — the time is free
 *     again and no reminder follows;
 *   - still waiting: reminder k (every two hours) is CLAIMED on the request's notification — one winner among
 *     concurrent runs — and pushed after commit to the business's live subscriptions.
 * Expiry runs whatever the flags say (a held time must always be released); reminders only while `appointments` is
 * ON for the business. The submit and approve paths also expire lazily, so a late sweep never lets a lapsed request
 * be approved or keep a time from a new request.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { appointmentsEnabled } from "@/lib/services/appointment/appointments-http";
import { lockBusinessAppointments } from "@/lib/services/appointment/appointment-request";

import { reminderOrdinal } from "./booking.core";
import { claimReminder, pushReminder, type ReminderClaim } from "./booking-notify";
import { expireDueRequests } from "./public-booking.service";

export type DueRequest = { businessId: number; requestId: number; createdAt: Date; expiresAt: Date };
export type SweepReport = { due: number; expired: number; reminded: number; pushed: number; pushFailed: number; errors: number };

const toUtc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");
const fromUtc = (v: Date | string) => (v instanceof Date ? v : new Date(`${String(v).replace(" ", "T")}Z`));

export async function duePendingRequests(now: Date, limit = 200): Promise<DueRequest[]> {
  const rows = await prisma.$queryRaw<{ businessId: number; requestId: number; createdAt: Date; expiresAt: Date }[]>`
    SELECT "businessId", "requestId", "createdAt", "expiresAt" FROM public.booking_pending_due(${toUtc(now)}::timestamp(3), ${limit}::int)`;
  return rows.map((r) => ({ businessId: Number(r.businessId), requestId: Number(r.requestId), createdAt: fromUtc(r.createdAt), expiresAt: fromUtc(r.expiresAt) }));
}

const whenLabel = (d: Date) =>
  new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jerusalem" }).format(d);

/** One business's due requests: expire what lapsed, claim the reminders that are due. */
async function sweepBusiness(businessId: number, due: DueRequest[], now: Date, remindersOn: boolean) {
  const out = await tenantTx(businessId, async (tx) => {
    await lockBusinessAppointments(tx, businessId);
    const expired = await expireDueRequests(tx, businessId, now);
    const claims: ReminderClaim[] = [];
    if (remindersOn) {
      for (const d of due) {
        if (expired.includes(d.requestId)) continue;
        const r = await tx.bookingRequest.findFirst({ where: { id: d.requestId, businessId, status: "PENDING" } });
        if (!r || r.expiresAt <= now) continue;
        const k = reminderOrdinal(r.createdAt, now);
        if (k < 1) continue;
        const appt = await tx.appointment.findFirst({ where: { id: r.appointmentId, businessId }, select: { startsAt: true, title: true, businessServiceId: true } });
        const service = appt?.businessServiceId ? await tx.businessService.findFirst({ where: { id: appt.businessServiceId, businessId }, select: { name: true } }) : null;
        const claim = await claimReminder(tx, businessId, {
          requestId: r.id, contactName: r.contactName, serviceName: service?.name ?? appt?.title ?? "תור", when: appt?.startsAt ? whenLabel(appt.startsAt) : "",
        }, r.createdAt, k, now);
        if (claim) claims.push(claim);
      }
    }
    return { expired: expired.length, claims };
  }, { timeoutMs: 20_000 });
  let pushed = 0, pushFailed = 0;
  for (const c of out.claims) {
    const p = await pushReminder(businessId, c, now).catch(() => ({ pushed: 0, failed: c.subscriptions.length }));
    pushed += p.pushed; pushFailed += p.failed;
  }
  return { expired: out.expired, reminded: out.claims.length, pushed, pushFailed };
}

export async function runBookingSweep(now: Date = new Date()): Promise<SweepReport> {
  const due = await duePendingRequests(now);
  const byBusiness = new Map<number, DueRequest[]>();
  for (const d of due) byBusiness.set(d.businessId, [...(byBusiness.get(d.businessId) ?? []), d]);
  const report: SweepReport = { due: due.length, expired: 0, reminded: 0, pushed: 0, pushFailed: 0, errors: 0 };
  for (const [businessId, list] of byBusiness) {
    try {
      const r = await sweepBusiness(businessId, list, now, await appointmentsEnabled(businessId));
      report.expired += r.expired; report.reminded += r.reminded; report.pushed += r.pushed; report.pushFailed += r.pushFailed;
    } catch {
      report.errors += 1; // one business never blocks the others; its requests stay due for the next run
    }
  }
  return report;
}
