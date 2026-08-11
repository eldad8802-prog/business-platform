/**
 * Father Engine — C0 / PR4. Deterministic timeline ordering (utility).
 *
 * NOT part of the manifest digest — the manifest orders by observationAccountId.
 * This is a purely TECHNICAL total order for inspection, never a business claim.
 *
 * Known eventTime, ordered by:
 *   start timestamp → type rank (INSTANT < INTERVAL) → observationTime → observationAccountId
 * UNKNOWN eventTime is a SEPARATE partition at the end (temporalBasis "UNKNOWN"),
 * ordered by observationTime → observationAccountId — NEVER treated as event time,
 * NEVER given a silent event-time fallback.
 *
 * Note: the committed EventTime union has no OPEN-interval variant (INTERVAL is
 * closed: from+to). Type ranks reserve INSTANT=0 < INTERVAL=1; an open-interval
 * rank would slot after INTERVAL when such a variant is added.
 *
 * Open interval support is deferred until EventTime is deliberately extended.
 */

import type { CanonicalObservation, ObservationAccountId } from "../observation.types";

export type TemporalBasis = "EVENT_TIME" | "UNKNOWN";

export interface TimelineEntry {
  observationAccountId: ObservationAccountId;
  temporalBasis: TemporalBasis;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function startTimestamp(o: CanonicalObservation): number {
  const e = o.eventTime;
  if (e.kind === "INSTANT") return Date.parse(e.at);
  if (e.kind === "INTERVAL") return Date.parse(e.from);
  return Number.NaN;
}

function typeRank(o: CanonicalObservation): number {
  return o.eventTime.kind === "INSTANT" ? 0 : 1; // INTERVAL = 1 (closed); UNKNOWN is partitioned out
}

export function orderTimeline(
  accounts: readonly CanonicalObservation[]
): readonly TimelineEntry[] {
  const known = accounts.filter((a) => a.eventTime.kind !== "UNKNOWN");
  const unknown = accounts.filter((a) => a.eventTime.kind === "UNKNOWN");

  known.sort(
    (a, b) =>
      startTimestamp(a) - startTimestamp(b) ||
      typeRank(a) - typeRank(b) ||
      Date.parse(a.observationTime.at) - Date.parse(b.observationTime.at) ||
      cmp(a.observationAccountId, b.observationAccountId)
  );
  unknown.sort(
    (a, b) =>
      Date.parse(a.observationTime.at) - Date.parse(b.observationTime.at) ||
      cmp(a.observationAccountId, b.observationAccountId)
  );

  return [
    ...known.map((a): TimelineEntry => ({
      observationAccountId: a.observationAccountId,
      temporalBasis: "EVENT_TIME",
    })),
    ...unknown.map((a): TimelineEntry => ({
      observationAccountId: a.observationAccountId,
      temporalBasis: "UNKNOWN",
    })),
  ];
}
