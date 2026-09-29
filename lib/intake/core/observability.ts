/**
 * Business Intake · safe structured logging.
 *
 * One log line per lifecycle transition, from an ALLOW-LIST of fields: ids,
 * source, family, stage, outcome, attempts, a bounded error code, durations.
 * Never payloads, message text, contact values, provider ids or tokens —
 * anything not on the list is dropped before it can be printed.
 */

const ALLOWED = new Set([
  "businessId",
  "eventId",
  "sourceKey",
  "family",
  "eventType",
  "stage",
  "outcome",
  "routeTarget",
  "identityOutcome",
  "attempt",
  "code",
  "durationMs",
  "resultKinds",
  "count",
]);

export type IntakeLogFields = Partial<Record<string, string | number | boolean | null | string[]>>;

export function sanitizeLogFields(fields: IntakeLogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k) || v === undefined) continue;
    if (typeof v === "string") out[k] = v.replace(/[^A-Za-z0-9:_.\-@]/g, "_").slice(0, 64);
    else if (Array.isArray(v)) out[k] = v.slice(0, 10).map((x) => String(x).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32));
    else out[k] = v;
  }
  return out;
}

export function logIntake(event: string, fields: IntakeLogFields): void {
  const level = event.endsWith("failed") || event.endsWith("dead_letter") ? "warn" : "info";
  console[level](`[intake] ${event}`, sanitizeLogFields(fields));
}
