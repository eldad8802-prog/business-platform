/**
 * Leads L1.5-b · PR-4 — owner notifications about the intake of their own leads, through the EXISTING chain:
 *
 *   intake backlog (the sweep's bounded read)
 *     -> the owner intake translator (lib/business-status/intake-attention.ts — the same truth as the home screen)
 *     -> the existing notification policy, UNCHANGED (owner 2026-11-08): only the two existing leads rules
 *        (ACTION_REQUIRED HIGH / MEDIUM, in-app, 24 h) carry intake facts; no new rule, no push
 *     -> the merged notification writer (the memory: one row per fact, cooldown, no duplicates under races)
 *
 * Facts, per connection (from the translator): paused with enquiries waiting (at risk after 7 days), not included,
 * held by Dubiz, a connection to check, enquiries not taken in. Plus two business-level facts that only notify:
 *   intake_backlog    the business has HELD_BACKLOG_NOTIFY or more waiting enquiries (abnormal accumulation)
 *   intake_recovered  enquiries that waited were taken in during the last hour and nothing waits any more —
 *                     emitted, but SILENT until a rule for it is approved (impact check first)
 *
 * Resolution: a fact that is no longer true is resolved — but ONLY when the read was complete (not capped); an
 * incomplete read is never evidence that something went away. Gated by intake_status_visibility (OFF by default).
 * Never throws: the sweep's work is done; a notification that could not be written is the lesser failure.
 */
import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import { translateIntakeAttention, type IntakeConnectionRow } from "@/lib/business-status/intake-attention";
import type { BusinessStatusItemBuild } from "@/lib/business-status/types";
import { cappedCount, type BusinessBacklog, type BusinessFlow } from "@/lib/intake/intake-capacity";
import { listConnections } from "@/lib/intake/acquisition/connection.service";
import { enabledSources } from "@/lib/intake/acquisition/owner-api";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { declareExhaustive } from "./exhaustive-facts";
import { buildDedupeKey } from "./notification-policy";
import { persistSnapshotNotifications, resolveAbsentNotifications, type WriteOutcome } from "./notification-writer";

/** Waiting enquiries at which the owner hears about an abnormal accumulation (the 1,000 capacity tier). */
export const HELD_BACKLOG_NOTIFY = 1000;

/** Every entity type an intake notification can carry — resolution is scoped to exactly these. */
export const INTAKE_NOTIFICATION_SCOPE = {
  domain: "leads",
  entityTypes: [
    "intake_paused",
    "intake_not_included",
    "intake_platform_hold",
    "intake_check_connection",
    "intake_failed",
    "intake_pending",
    "intake_backlog",
    "intake_recovered",
  ],
} as const;

const n = (count: number) => count.toLocaleString("he-IL");

/** Pure: the facts to notify about (the translator's, plus the two business-level ones). */
export function intakeNotificationItems(
  businessId: number,
  connections: IntakeConnectionRow[],
  backlog: BusinessBacklog,
  flow: BusinessFlow | null,
  now: Date,
  sources?: Record<string, boolean>
): BusinessStatusItemBuild[] {
  // The policy is unchanged (owner, 2026-11-08): every intake fact rides an EXISTING rule. "Not taken in" is told as
  // ACTION_REQUIRED HIGH here (the home screen keeps FAILURE_EVENT); a recovery is emitted but stays SILENT until a
  // rule for it is approved after an impact check.
  const items = translateIntakeAttention({ connections, backlog, sources }, now).map((i) =>
    i.semanticCategory === "FAILURE_EVENT" ? { ...i, semanticCategory: "ACTION_REQUIRED" as const } : i
  );
  const base = (reason: string, category: BusinessStatusItemBuild["semanticCategory"], severity: BusinessStatusItemBuild["severity"], title: string, summary: string) => ({
    itemId: `leads:${reason}:${businessId}`,
    domain: "leads" as const,
    semanticCategory: category,
    title,
    summary,
    severity,
    entityRef: { type: reason, id: businessId },
    state: "open" as const,
    createdAt: now.toISOString(),
    primaryAction: { kind: "navigate" as const, label: "לחיבורים", href: "/settings/connections" },
    sourceEngine: "intake-status",
    blocking: false,
    priorityReferenceDate: now,
  });
  const held = backlog.totals.held;
  if (held >= HELD_BACKLOG_NOTIFY) {
    items.push(base("intake_backlog", "ACTION_REQUIRED", "HIGH", `הצטברו ${n(cappedCount(held, backlog).n)}${backlog.capped ? "+" : ""} פניות שממתינות לקליטה`,
      "פניות ממקורות מושהים או חסומים מצטברות. כדאי לבדוק את החיבורים כדי שלא יחכו זמן רב."));
  }
  if (flow && flow.recoveredLastHour > 0 && held === 0) {
    items.push(base("intake_recovered", "WARNING", "INFO", `${n(flow.recoveredLastHour)} פניות שהמתינו נקלטו בהצלחה`,
      "הקליטה חזרה לפעול והפניות שהמתינו מופיעות עכשיו בלידים."));
  }
  return items;
}

export type IntakeNotificationSync = { ok: boolean; skipped?: "feature_off"; written: WriteOutcome[]; resolved: number; error?: string };

/**
 * Reconcile this business's intake notifications with the sweep's read. Call inside the business's tenant job.
 */
export async function syncIntakeNotifications(
  businessId: number,
  backlog: BusinessBacklog,
  flow: BusinessFlow | null,
  now: Date
): Promise<IntakeNotificationSync> {
  try {
    const access = await resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.INTAKE_STATUS_VISIBILITY);
    if (!access.allowed) return { ok: true, skipped: "feature_off", written: [], resolved: 0 };
    // The plan's sources, as the home screen reads them: a notification never offers to resume a source the plan excludes.
    const [connections, sources] = await Promise.all([listConnections(), enabledSources(businessId)]);
    const items = intakeNotificationItems(businessId, connections, backlog, flow, now, sources).map(finalizeBusinessStatusItem);
    const written = await persistSnapshotNotifications(businessId, items, now);
    // An incomplete read (capped) is never evidence that a fact went away: resolve only on a complete one.
    const resolved = backlog.capped
      ? 0
      : await resolveAbsentNotifications(businessId, INTAKE_NOTIFICATION_SCOPE, declareExhaustive(items.map((i) => buildDedupeKey(businessId, i))), now);
    return { ok: true, written, resolved };
  } catch (error) {
    console.error("[notifications] intake sync failed", { businessId, error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, written: [], resolved: 0, error: error instanceof Error ? error.name : "unknown" };
  }
}
