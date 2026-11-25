/**
 * Appointments health — the PURE evaluation (no database, no clock, no network). G4.
 *
 * lib/services/appointment/appointments-health.service.ts collects a snapshot of counts across live businesses
 * (read-only); this module decides whether it is healthy. The route (app/api/appointments/health) answers 200 when
 * healthy and 500 with the names of the failing checks otherwise, so the GitHub watchdog
 * (.github/workflows/appointments-health.yml) turns red and GitHub notifies the repository owner.
 *
 * The snapshot carries COUNTS and AGES only — never a business id, a name, a phone or an appointment id.
 *
 * Checks (each a fixed name):
 *   overlap_guard        — the database's own no-overlap constraint ("Appointment_no_overlap") exists and is valid.
 *   lane_overlaps        — live (PROPOSED/CONFIRMED) appointments of one lane overlapping in time. Must be 0.
 *   booking_sweep_lag    — PENDING booking requests past their expiry by more than the grace (the sweep runs every
 *                          10 minutes; a held time must always be released). Must be 0.
 *   stale_holds          — PROPOSED appointments past holdExpiresAt by more than the grace. Must be 0.
 *   owed_delivery_lag    — the oldest owed (PENDING) push of an appointments notification, measured from the moment
 *                          it became due, older than the limit (the worker runs every 5 minutes).
 *   delivery_outage      — appointments deliveries failed in the last 24 hours while NONE was sent (a total outage,
 *                          not the normal trickle of dead devices).
 *   scan_incomplete      — the run could not visit every live business (a business failed, or the time budget ran
 *                          out): the counts above are a lower bound, so the run is not called healthy.
 * Informational only (never failing on its own): the age of the most recent sweep evidence (the latest request the
 * sweep or a lazy expiry closed as EXPIRED) — no data means no lapsed request yet, not a dead sweep; the lag check
 * above is what proves the sweep keeps up.
 */

export const HEALTH_GRACE_MINUTES = 15;
export const OWED_DELIVERY_LIMIT_MINUTES = 30;

export type AppointmentsHealthSnapshot = {
  businessesScanned: number;
  businessesFailed: number;
  budgetExhausted: boolean;
  overlapGuardPresent: boolean;
  laneOverlaps: number;
  staleBookingRequests: number;
  staleHolds: number;
  /** Minutes since the oldest owed appointments push became due; null = nothing owed. */
  oldestOwedDeliveryMinutes: number | null;
  failedDeliveries24h: number;
  sentDeliveries24h: number;
  /** Minutes since the latest EXPIRED decision on a booking request; null = none ever. */
  lastSweepEvidenceMinutes: number | null;
};

export const HEALTH_CHECKS = [
  "overlap_guard",
  "lane_overlaps",
  "booking_sweep_lag",
  "stale_holds",
  "owed_delivery_lag",
  "delivery_outage",
  "scan_incomplete",
] as const;
export type HealthCheckName = (typeof HEALTH_CHECKS)[number];

export type AppointmentsHealthVerdict = {
  ok: boolean;
  failing: HealthCheckName[];
  counts: AppointmentsHealthSnapshot;
};

const nonNegInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Decide. A malformed count is treated as failing its check (fail closed), never as healthy. */
export function evaluateAppointmentsHealth(s: AppointmentsHealthSnapshot): AppointmentsHealthVerdict {
  const failing: HealthCheckName[] = [];
  if (s.overlapGuardPresent !== true) failing.push("overlap_guard");
  if (!nonNegInt(s.laneOverlaps) || s.laneOverlaps > 0) failing.push("lane_overlaps");
  if (!nonNegInt(s.staleBookingRequests) || s.staleBookingRequests > 0) failing.push("booking_sweep_lag");
  if (!nonNegInt(s.staleHolds) || s.staleHolds > 0) failing.push("stale_holds");
  if (s.oldestOwedDeliveryMinutes !== null && (!(typeof s.oldestOwedDeliveryMinutes === "number") || !(s.oldestOwedDeliveryMinutes <= OWED_DELIVERY_LIMIT_MINUTES))) {
    failing.push("owed_delivery_lag");
  }
  if (!nonNegInt(s.failedDeliveries24h) || !nonNegInt(s.sentDeliveries24h) || (s.failedDeliveries24h > 0 && s.sentDeliveries24h === 0)) {
    failing.push("delivery_outage");
  }
  if (!nonNegInt(s.businessesFailed) || s.businessesFailed > 0 || s.budgetExhausted !== false) failing.push("scan_incomplete");
  return { ok: failing.length === 0, failing, counts: s };
}

export type CronDecision = "AUTHORIZED" | "UNAUTHORIZED" | "NOT_CONFIGURED";
export type HealthAnswer = { status: number; body: Record<string, unknown> };

/**
 * The route's answer for an authority decision and a collector. 503 / 401 before anything is read; 200 healthy;
 * 500 with the failing check names; a collector that throws → 500 with a fixed code (never its message).
 */
export async function answerAppointmentsHealth(
  decision: CronDecision,
  collect: () => Promise<AppointmentsHealthSnapshot>
): Promise<HealthAnswer> {
  if (decision === "NOT_CONFIGURED") return { status: 503, body: { error: "health_not_configured" } };
  if (decision !== "AUTHORIZED") return { status: 401, body: { error: "unauthorized" } };
  let snapshot: AppointmentsHealthSnapshot;
  try {
    snapshot = await collect();
  } catch {
    return { status: 500, body: { ok: false, error: "health_failed" } };
  }
  const v = evaluateAppointmentsHealth(snapshot);
  return { status: v.ok ? 200 : 500, body: { ok: v.ok, failing: v.failing, counts: v.counts } };
}
