/**
 * Appointments health — the READ-ONLY collection (G4). SERVER-ONLY. Runs without a session (the GitHub watchdog,
 * CRON_SECRET); never takes a business from the caller.
 *
 * Cross-business reads reuse the two EXISTING identifiers-only doors — no new raw access on the bare client:
 *   duePendingRequests(now − grace)   — the booking sweep's own lookup (booking_pending_due, 20261106090000): what it
 *                                       returns with expiresAt ≤ now − grace is a request the sweep should have expired;
 *   walkLiveBusinesses(visit)         — the digest's keyset walk (notification_live_businesses, 20261210090000).
 * Everything else — including the catalog check that the no-overlap guard exists — runs inside each business's tenant
 * transaction (tenantTx: app.current_business_id, FORCE RLS), one bounded statement per business, on existing indexes.
 * Delivery checks are CHANNEL-AGNOSTIC: every outbound channel (anything but IN_APP, compared as text so a channel the
 * enum gains later — WHATSAPP — is covered with no code change) is measured for owed lag, and failures vs sends are
 * judged PER CHANNEL, so one channel failing completely is an outage even while another still sends.
 * Nothing is written. Only counts and ages leave this module.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { walkLiveBusinesses } from "@/lib/notifications/engine/digest";
import { duePendingRequests } from "@/lib/services/booking/booking-sweep.service";

import { HEALTH_GRACE_MINUTES, type AppointmentsHealthSnapshot } from "./appointments-health";

const MAX_BUSINESSES = 5000;
export const SCAN_BUDGET_MS = 40_000;

const toUtc = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");
const fromUtc = (v: Date | string) => (v instanceof Date ? v : new Date(`${String(v).replace(" ", "T")}Z`));
const minutesSince = (now: Date, at: Date) => Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));

type BusinessRow = {
  guard: boolean;
  overlaps: number;
  stale_holds: number;
  owed_due_since: Date | string | null;
  /** Outbound (not IN_APP) appointments deliveries of the last 24 h per channel name: { CHANNEL: [failed, sent] }. */
  by_channel: Record<string, [number, number]> | null;
  last_expired: Date | string | null;
};

/** One business, one statement, inside its tenant transaction. Counts only. */
export async function businessHealth(businessId: number, now: Date): Promise<BusinessRow> {
  const at = toUtc(now);
  const rows = await tenantTx(businessId, (tx) => tx.$queryRaw<BusinessRow[]>`
    SELECT
      EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
               WHERE conname = 'Appointment_no_overlap' AND contype = 'x' AND convalidated
                 AND conrelid = 'public."Appointment"'::regclass) AS guard,
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
        WHERE d."businessId" = ${businessId} AND d."status" = 'PENDING' AND d."channel"::text <> 'IN_APP'
          AND n."domain" = 'appointments'
          AND COALESCE(d."nextAttemptAt", d."createdAt") <= ${at}::timestamp(3)) AS owed_due_since,
      (SELECT json_object_agg(x.ch, json_build_array(x.failed, x.sent))
         FROM (SELECT d."channel"::text AS ch,
                      count(*) FILTER (WHERE d."status" = 'FAILED')::int AS failed,
                      count(*) FILTER (WHERE d."status" = 'SENT')::int AS sent
                 FROM "NotificationDelivery" d
                 JOIN "Notification" n ON n."id" = d."notificationId" AND n."businessId" = d."businessId"
                WHERE d."businessId" = ${businessId} AND d."channel"::text <> 'IN_APP' AND n."domain" = 'appointments'
                  AND d."status" IN ('FAILED', 'SENT')
                  AND d."attemptedAt" >= ${at}::timestamp(3) - interval '24 hours'
                GROUP BY 1) x) AS by_channel,
      (SELECT max("decidedAt") FROM "BookingRequest"
        WHERE "businessId" = ${businessId} AND "status" = 'EXPIRED') AS last_expired`, { timeoutMs: 10_000 });
  return rows[0];
}

/** PENDING requests the sweep's own lookup still returns, lapsed for longer than the grace. */
export async function staleBookingRequests(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - HEALTH_GRACE_MINUTES * 60_000);
  const rows = await duePendingRequests(cutoff, 500);
  return rows.filter((r) => r.expiresAt.getTime() <= cutoff.getTime()).length;
}

export type CollectDeps = {
  staleBookingRequests: (now: Date) => Promise<number>;
  walkBusinesses: (visit: (businessId: number) => Promise<void>) => Promise<void>;
  businessHealth: (businessId: number, now: Date) => Promise<BusinessRow>;
  clock: () => number;
};

const realDeps: CollectDeps = { staleBookingRequests, walkBusinesses: walkLiveBusinesses, businessHealth, clock: () => Date.now() };

class StopWalk extends Error {}

export async function collectAppointmentsHealth(now: Date = new Date(), deps: CollectDeps = realDeps, budgetMs = SCAN_BUDGET_MS): Promise<AppointmentsHealthSnapshot> {
  const started = deps.clock();
  const snap: AppointmentsHealthSnapshot = {
    businessesScanned: 0,
    businessesFailed: 0,
    budgetExhausted: false,
    // Checked inside every visited business's transaction; with no live business there is nothing to overlap.
    overlapGuardPresent: true,
    laneOverlaps: 0,
    staleBookingRequests: await deps.staleBookingRequests(now),
    staleHolds: 0,
    oldestOwedDeliveryMinutes: null,
    failedDeliveries24h: 0,
    sentDeliveries24h: 0,
    channelsInOutage: 0,
    lastSweepEvidenceMinutes: null,
  };
  let oldestOwed: Date | null = null;
  let lastExpired: Date | null = null;
  const byChannel = new Map<string, [number, number]>();
  try {
    await deps.walkBusinesses(async (businessId) => {
      if (snap.businessesScanned + snap.businessesFailed >= MAX_BUSINESSES || deps.clock() - started > budgetMs) {
        snap.budgetExhausted = true;
        throw new StopWalk();
      }
      try {
        const r = await deps.businessHealth(businessId, now);
        snap.businessesScanned += 1;
        if (r.guard !== true) snap.overlapGuardPresent = false;
        snap.laneOverlaps += Number(r.overlaps);
        snap.staleHolds += Number(r.stale_holds);
        for (const [ch, pair] of Object.entries(r.by_channel ?? {})) {
          const t = byChannel.get(ch) ?? [0, 0];
          byChannel.set(ch, [t[0] + Number(pair[0]), t[1] + Number(pair[1])]);
        }
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
    });
  } catch (e) {
    if (!(e instanceof StopWalk)) throw e;
  }
  for (const [failed, sent] of byChannel.values()) {
    snap.failedDeliveries24h += failed;
    snap.sentDeliveries24h += sent;
    if (failed > 0 && sent === 0) snap.channelsInOutage += 1;
  }
  snap.oldestOwedDeliveryMinutes = oldestOwed ? minutesSince(now, oldestOwed) : null;
  snap.lastSweepEvidenceMinutes = lastExpired ? minutesSince(now, lastExpired) : null;
  return snap;
}
