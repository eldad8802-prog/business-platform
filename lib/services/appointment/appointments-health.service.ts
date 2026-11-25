/**
 * Appointments health — the READ-ONLY collection (G4). SERVER-ONLY. Runs without a session (the GitHub watchdog,
 * CRON_SECRET); never takes a business from the caller.
 *
 * Cross-business reads use ONLY the existing identifiers-only SECURITY DEFINER doors, exactly as the sweepers do:
 *   booking_pending_due(now − grace, limit)      — the booking sweep's own door (20261106090000): what it returns with
 *                                                  expiresAt ≤ now − grace is a request the sweep should have expired;
 *   notification_live_businesses(after, limit)   — the digest's keyset walk over live businesses (20261210090000).
 * Everything else runs inside each business's tenant transaction (tenantTx: app.current_business_id, FORCE RLS), one
 * bounded statement per business, on existing indexes. Nothing is written. Only counts and ages leave this module.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { HEALTH_GRACE_MINUTES, type AppointmentsHealthSnapshot } from "./appointments-health";

const PAGE = 500;
const MAX_BUSINESSES = 5000;
export const SCAN_BUDGET_MS = 40_000;

const toUtc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");
const fromUtc = (v: Date | string) => (v instanceof Date ? v : new Date(`${String(v).replace(" ", "T")}Z`));
const minutesSince = (now: Date, at: Date) => Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));

type BusinessRow = {
  overlaps: number;
  stale_holds: number;
  owed_due_since: Date | string | null;
  failed_24h: number;
  sent_24h: number;
  last_expired: Date | string | null;
};

/** One business, one statement, inside its tenant transaction. Counts only. */
export async function businessHealth(businessId: number, now: Date): Promise<BusinessRow> {
  const at = toUtc(now);
  const rows = await tenantTx(businessId, (tx) => tx.$queryRaw<BusinessRow[]>`
    SELECT
      (SELECT count(*)::int
         FROM "Appointment" a
         JOIN "Appointment" b
           ON b."businessId" = a."businessId" AND b."id" > a."id"
          AND COALESCE(b."staffMemberId", 0) = COALESCE(a."staffMemberId", 0)
          AND b."endsAt" IS NOT NULL AND b."status" IN ('PROPOSED', 'CONFIRMED')
          AND tsrange(b."startsAt" - b."bufferBeforeMinutes" * interval '1 minute', b."endsAt" + b."bufferAfterMinutes" * interval '1 minute', '[)')
           && tsrange(a."startsAt" - a."bufferBeforeMinutes" * interval '1 minute', a."endsAt" + a."bufferAfterMinutes" * interval '1 minute', '[)')
        WHERE a."businessId" = ${businessId}
          AND a."endsAt" IS NOT NULL AND a."status" IN ('PROPOSED', 'CONFIRMED')
          AND a."endsAt" >= ${at}::timestamp(3) - interval '1 day') AS overlaps,
      (SELECT count(*)::int FROM "Appointment"
        WHERE "businessId" = ${businessId} AND "status" = 'PROPOSED'
          AND "holdExpiresAt" IS NOT NULL
          AND "holdExpiresAt" <= ${at}::timestamp(3) - make_interval(mins => ${HEALTH_GRACE_MINUTES}::int)) AS stale_holds,
      (SELECT min(COALESCE(d."nextAttemptAt", d."createdAt"))
         FROM "NotificationDelivery" d
         JOIN "Notification" n ON n."id" = d."notificationId" AND n."businessId" = d."businessId"
        WHERE d."businessId" = ${businessId} AND d."status" = 'PENDING' AND d."channel" = 'PUSH'
          AND n."domain" = 'appointments'
          AND COALESCE(d."nextAttemptAt", d."createdAt") <= ${at}::timestamp(3)) AS owed_due_since,
      (SELECT count(*)::int
         FROM "NotificationDelivery" d
         JOIN "Notification" n ON n."id" = d."notificationId" AND n."businessId" = d."businessId"
        WHERE d."businessId" = ${businessId} AND d."status" = 'FAILED' AND n."domain" = 'appointments'
          AND d."attemptedAt" >= ${at}::timestamp(3) - interval '24 hours') AS failed_24h,
      (SELECT count(*)::int
         FROM "NotificationDelivery" d
         JOIN "Notification" n ON n."id" = d."notificationId" AND n."businessId" = d."businessId"
        WHERE d."businessId" = ${businessId} AND d."status" = 'SENT' AND n."domain" = 'appointments'
          AND d."attemptedAt" >= ${at}::timestamp(3) - interval '24 hours') AS sent_24h,
      (SELECT max("decidedAt") FROM "BookingRequest"
        WHERE "businessId" = ${businessId} AND "status" = 'EXPIRED') AS last_expired`, { timeoutMs: 10_000 });
  return rows[0];
}

/** The database's own no-overlap guard is present and valid (catalog read; no tenant data). */
export async function overlapGuardPresent(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conname = 'Appointment_no_overlap' AND contype = 'x' AND convalidated
         AND conrelid = 'public."Appointment"'::regclass) AS present`;
  return rows[0]?.present === true;
}

/** PENDING requests the sweep's own door still shows, lapsed for longer than the grace. */
export async function staleBookingRequests(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - HEALTH_GRACE_MINUTES * 60_000);
  const rows = await prisma.$queryRaw<{ expiresAt: Date | string }[]>`
    SELECT "expiresAt" FROM public.booking_pending_due(${toUtc(cutoff)}::timestamp(3), 500::int)`;
  return rows.filter((r) => fromUtc(r.expiresAt).getTime() <= cutoff.getTime()).length;
}

async function liveBusinesses(after: number): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ businessId: number }[]>`
    SELECT "businessId" FROM public.notification_live_businesses(${after}::int, ${PAGE}::int)`;
  return rows.map((r) => Number(r.businessId));
}

export type CollectDeps = {
  overlapGuardPresent: () => Promise<boolean>;
  staleBookingRequests: (now: Date) => Promise<number>;
  liveBusinesses: (after: number) => Promise<number[]>;
  businessHealth: (businessId: number, now: Date) => Promise<BusinessRow>;
  clock: () => number;
};

const realDeps: CollectDeps = { overlapGuardPresent, staleBookingRequests, liveBusinesses, businessHealth, clock: () => Date.now() };

export async function collectAppointmentsHealth(now: Date = new Date(), deps: CollectDeps = realDeps, budgetMs = SCAN_BUDGET_MS): Promise<AppointmentsHealthSnapshot> {
  const started = deps.clock();
  const snap: AppointmentsHealthSnapshot = {
    businessesScanned: 0,
    businessesFailed: 0,
    budgetExhausted: false,
    overlapGuardPresent: await deps.overlapGuardPresent(),
    laneOverlaps: 0,
    staleBookingRequests: await deps.staleBookingRequests(now),
    staleHolds: 0,
    oldestOwedDeliveryMinutes: null,
    failedDeliveries24h: 0,
    sentDeliveries24h: 0,
    lastSweepEvidenceMinutes: null,
  };
  let oldestOwed: Date | null = null;
  let lastExpired: Date | null = null;
  let after = 0;
  walk: for (;;) {
    const page = await deps.liveBusinesses(after);
    if (page.length === 0) break;
    for (const businessId of page) {
      if (snap.businessesScanned + snap.businessesFailed >= MAX_BUSINESSES || deps.clock() - started > budgetMs) {
        snap.budgetExhausted = true;
        break walk;
      }
      after = businessId;
      try {
        const r = await deps.businessHealth(businessId, now);
        snap.businessesScanned += 1;
        snap.laneOverlaps += Number(r.overlaps);
        snap.staleHolds += Number(r.stale_holds);
        snap.failedDeliveries24h += Number(r.failed_24h);
        snap.sentDeliveries24h += Number(r.sent_24h);
        if (r.owed_due_since) {
          const t = fromUtc(r.owed_due_since);
          if (!oldestOwed || t < oldestOwed) oldestOwed = t;
        }
        if (r.last_expired) {
          const t = fromUtc(r.last_expired);
          if (!lastExpired || t > lastExpired) lastExpired = t;
        }
      } catch {
        snap.businessesFailed += 1; // one business never hides the others; the run is not called healthy
      }
    }
    if (page.length < PAGE) break;
  }
  snap.oldestOwedDeliveryMinutes = oldestOwed ? minutesSince(now, oldestOwed) : null;
  snap.lastSweepEvidenceMinutes = lastExpired ? minutesSince(now, lastExpired) : null;
  return snap;
}
