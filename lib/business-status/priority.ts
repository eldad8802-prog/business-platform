import type {
  BusinessStatusItem,
  BusinessStatusItemBuild,
  Severity,
} from "./types";

const SEVERITY_BASE: Record<Severity, number> = {
  CRITICAL: 88,
  HIGH: 72,
  MEDIUM: 56,
  LOW: 40,
  INFO: 24,
};

export type PriorityInputs = {
  severity: Severity;
  blocking: boolean;
  /** Primary clock for recency / staleness (ISO or Date). */
  referenceDate: Date;
  now?: Date;
};

/**
 * Rule-based priority 0–100: base severity + blocking + recency + stale-open bump.
 * No ML.
 */
export function computePriorityScore(input: PriorityInputs): number {
  const now = input.now ?? new Date();
  const ref = input.referenceDate;
  const ageMs = Math.max(0, now.getTime() - ref.getTime());
  const ageHours = ageMs / (60 * 60 * 1000);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);

  let score = SEVERITY_BASE[input.severity];

  if (input.blocking) {
    score += 12;
  }

  /** Recent items surface faster (last 48h). */
  if (ageHours <= 48) {
    score += 10;
  } else if (ageHours <= 168) {
    score += 4;
  }

  /** Old still-open items escalate (attention debt). */
  if (ageDays > 7) {
    score += 14;
  }

  return Math.min(100, Math.round(score));
}

export function finalizeBusinessStatusItem(
  build: BusinessStatusItemBuild
): BusinessStatusItem {
  const { priorityReferenceDate, ...rest } = build;
  return {
    ...rest,
    priorityScore: computePriorityScore({
      severity: rest.severity,
      blocking: rest.blocking ?? false,
      referenceDate: priorityReferenceDate,
    }),
  };
}
