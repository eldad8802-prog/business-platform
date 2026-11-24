/**
 * Usage quota MODE — how far the central quota mechanism may act, per metric. SERVER-ONLY.
 *
 * Two keys, the LOWER wins (OFF < SHADOW < ENFORCE):
 *   1. the server ceiling — env USAGE_QUOTA_MODE: off | shadow | enforce. Default and every unknown value: shadow.
 *      Raising it to enforce is a deploy-level act behind a separate owner decision (decision 25);
 *   2. the per-metric mode in PlatformUsageMetricMode (admin console, no deploy; seeded SHADOW for every quota metric).
 * So the database alone can never switch enforcement on, and the env alone enforces nothing the admin has not set.
 *
 *   OFF      nothing is counted for that metric.
 *   SHADOW   everything is counted; nothing is refused; a customer over its quota is logged (usage_would_deny).
 *   ENFORCE  a CUSTOMER over its quota is refused (QUOTA_EXHAUSTED). Testers, internal accounts and businesses without
 *            a subscription record are NEVER refused — the database itself enforces that (usage_consume).
 * Measured-only metrics are never refused, whatever the modes say.
 */
import { isQuotaMetric, type UsageMetric } from "./usage-metrics";

export type UsageMode = "OFF" | "SHADOW" | "ENFORCE";

export const USAGE_QUOTA_MODE_ENV = "USAGE_QUOTA_MODE";

const RANK: Record<UsageMode, number> = { OFF: 0, SHADOW: 1, ENFORCE: 2 };

export function usageModeCeiling(env: Record<string, string | undefined> = process.env): UsageMode {
  const raw = (env[USAGE_QUOTA_MODE_ENV] ?? "").trim().toLowerCase();
  if (raw === "off") return "OFF";
  if (raw === "enforce") return "ENFORCE";
  return "SHADOW";
}

export function parseUsageMode(value: unknown): UsageMode | null {
  return value === "OFF" || value === "SHADOW" || value === "ENFORCE" ? value : null;
}

/** Pure: the effective mode of one metric. A missing or unreadable metric mode counts as SHADOW (never ENFORCE). */
export function effectiveUsageMode(metric: UsageMetric, metricMode: UsageMode | null, ceiling: UsageMode): UsageMode {
  const stored = metricMode ?? "SHADOW";
  let mode: UsageMode = RANK[stored] <= RANK[ceiling] ? stored : ceiling;
  if (!isQuotaMetric(metric) && mode === "ENFORCE") mode = "SHADOW";
  return mode;
}
