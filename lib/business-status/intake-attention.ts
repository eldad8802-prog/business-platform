/**
 * Leads L1.5-b · PR-3 — what the owner needs to know about the intake of their own leads, as business-status items
 * (domain "leads"), so it reaches "מה ממתין לך" on the home screen through the existing pipeline — never the
 * Secretary, never a second admin system.
 *
 * Shown (per connection of THIS business, counts only — never a name, phone, message or provider detail):
 *   intake_paused            the owner paused a connection and enquiries wait for it      → ACTION_REQUIRED
 *                            (HIGH once the oldest has waited AT_RISK_AFTER_DAYS — at risk)
 *   intake_not_included      enquiries wait because the source is not in the business's plan → ACTION_REQUIRED
 *   intake_platform_hold     Dubiz paused intake from this source; nothing to do           → WARNING
 *   intake_check_connection  the connection needs checking (status ERROR)                   → ACTION_REQUIRED HIGH
 *   intake_failed            some enquiries could not be taken in (retries exhausted)      → FAILURE_EVENT HIGH
 *   intake_pending           received, still being processed for a while                   → WARNING LOW
 *
 * A waiting enquiry is never presented as a lead: the words are "פניות שממתינות", and the item opens the connection
 * screen, not a lead. Gated by the catalog feature `intake_status_visibility` (OFF by default). Fail-open: any error
 * → no items (the home screen must never break because of this).
 *
 * Cost: one bounded backlog read (OWNER_SCAN_CAP rows, server statement timeout) + the business's connection list,
 * cached per business for CACHE_TTL_MS — never an unbounded count on a user request.
 */
import { runWithTenantContext } from "@/lib/tenant/context";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { intakeBacklog } from "@/lib/intake/intake-event.store";
import { listConnections } from "@/lib/intake/acquisition/connection.service";
import { enabledSources } from "@/lib/intake/acquisition/owner-api";
import { cappedCount, type BusinessBacklog, type ConnectionBacklog } from "@/lib/intake/intake-capacity";
import type { BusinessStatusItemBuild, SemanticCategory, Severity } from "./types";

/** Rows one owner read scans at most; above it the screen says "+" (the counts are lower bounds). */
export const OWNER_SCAN_CAP = 2500;
/** A held enquiry waiting this long is "at risk" (a display threshold — no expiry policy is implied). */
export const AT_RISK_AFTER_DAYS = 7;
/** Received but not finished this long (and not on hold) is worth a quiet line. */
export const PENDING_AFTER_MS = 30 * 60 * 1000;
export const CACHE_TTL_MS = 60 * 1000;
const CONNECTIONS_HREF = "/settings/connections";
const DAY = 24 * 60 * 60 * 1000;

/** Sources whose receipts carry the provider resource id (Page / Wix site) instead of the endpoint's public id. */
const RESOURCE_REF_SOURCES = new Set(["meta.lead_ads", "commerce.wix"]);

export const SOURCE_LABEL_HE: Record<string, string> = {
  "web.form": "טופס האתר",
  "google.lead_form": "Google Ads",
  "meta.lead_ads": "Meta (פייסבוק ואינסטגרם)",
  "commerce.woocommerce": "חנות WooCommerce",
  "commerce.wix": "חנות Wix",
  "telephony.cloudtalk": "CloudTalk",
  "telephony.voicenter": "Voicenter",
};

export type IntakeConnectionRow = {
  id: number;
  sourceKey: string;
  status: string;
  publicId: string;
  externalResourceId: string | null;
  label: string | null;
};

/**
 * `sources`: which sources the business's plan includes (absent = all). An item never offers an action the business
 * cannot take: a paused connection of a source outside the plan, or a Meta Page (no resume on the screen), points to
 * the details instead of "resume".
 */
export type IntakeAttentionRaw = { connections: IntakeConnectionRow[]; backlog: BusinessBacklog; sources?: Record<string, boolean> };

/** Sources whose connection cannot be resumed from the connections screen. */
const NO_RESUME_SOURCES = new Set(["meta.lead_ads"]);

/** Exact, or at most the read's cap followed by "+" when the read hit it. */
const fmt = (count: number, backlog: Pick<BusinessBacklog, "capped" | "scanCap">) => {
  const c = cappedCount(count, backlog);
  return c.plus ? `${c.n.toLocaleString("he-IL")}+` : c.n.toLocaleString("he-IL");
};
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** What a receipt is to the owner: an enquiry (lead sources), an order (stores) or a call (phone lines). All feminine. */
export function nounOf(sourceKey: string): { one: string; many: string } {
  if (sourceKey.startsWith("commerce.")) return { one: "הזמנה", many: "הזמנות" };
  if (sourceKey.startsWith("telephony.")) return { one: "שיחה", many: "שיחות" };
  return { one: "פנייה", many: "פניות" };
}

function sourceName(c: IntakeConnectionRow): string {
  const base = SOURCE_LABEL_HE[c.sourceKey] ?? "מקור פניות";
  const label = c.label?.trim();
  return label ? `${base} · ${label}` : base;
}

function refOf(c: IntakeConnectionRow): string | null {
  return RESOURCE_REF_SOURCES.has(c.sourceKey) ? c.externalResourceId : c.publicId;
}

/** Pure: the owner's items for these connections and this backlog. */
export function translateIntakeAttention(raw: IntakeAttentionRaw, now: Date): BusinessStatusItemBuild[] {
  const out: BusinessStatusItemBuild[] = [];
  const byRef = new Map<string, ConnectionBacklog>();
  for (const b of raw.backlog.connections) byRef.set(`${b.sourceKey}\u0000${b.providerAccountRef ?? ""}`, b);

  const item = (
    c: IntakeConnectionRow,
    reason: string,
    category: SemanticCategory,
    severity: Severity,
    title: string,
    summary: string | null,
    since: Date | null,
    actionLabel: string
  ): BusinessStatusItemBuild => ({
    itemId: `leads:${reason}:${c.id}`,
    domain: "leads",
    semanticCategory: category,
    title,
    summary,
    severity,
    // One entity type per situation: two situations on one connection stay two facts (the notification dedupe key
    // is domain + category + entity type + id).
    entityRef: { type: reason, id: c.id },
    state: "open",
    createdAt: (since ?? now).toISOString(),
    primaryAction: { kind: "navigate", label: actionLabel, href: CONNECTIONS_HREF },
    sourceEngine: "intake-status",
    blocking: false,
    priorityReferenceDate: since ?? now,
  });

  for (const c of raw.connections) {
    const ref = refOf(c);
    const b = ref ? byRef.get(`${c.sourceKey}\u0000${ref}`) : undefined;
    const name = sourceName(c);
    const w = nounOf(c.sourceKey);
    const live = c.status !== "REVOKED";

    if (live && c.status === "ERROR") {
      out.push(item(c, "intake_check_connection", "ACTION_REQUIRED", "HIGH", "נדרשת בדיקה של חיבור מקור הפניות",
        `${name}: החיבור דורש בדיקה, ופניות חדשות עלולות לא להיקלט.`, null, "לבדיקה"));
    }
    if (!b) continue;

    const paused = b.heldByReason.connection_paused ?? 0;
    if (live && paused > 0) {
      const days = b.oldestHeldAt ? Math.floor((now.getTime() - b.oldestHeldAt.getTime()) / DAY) : 0;
      const atRisk = days >= AT_RISK_AFTER_DAYS;
      const inPlan = raw.sources?.[c.sourceKey] ?? true;
      const canResume = inPlan && !NO_RESUME_SOURCES.has(c.sourceKey);
      const waited = days >= 1 ? ` הוותיקה ביותר ממתינה כבר ${days} ${plural(days, "יום", "ימים")}.` : "";
      const next = !inPlan
        ? " המקור לא כלול כרגע בחבילה שלכם, ולכן הפעלה מחדש לא תקלוט אותן."
        : canResume ? " הן ייקלטו כשתפעילו את החיבור מחדש." : " הן ייקלטו כשהחיבור יחזור לפעול.";
      out.push(item(c, "intake_paused", "ACTION_REQUIRED", atRisk ? "HIGH" : "MEDIUM",
        `יש ${fmt(paused, raw.backlog)} ${plural(paused, `${w.one} שממתינה`, `${w.many} שממתינות`)} לחידוש החיבור`,
        `${name} מושהה.${waited}${next}`,
        b.oldestHeldAt, canResume ? "להפעלה" : "לפרטים"));
    }
    const notIncluded = b.heldByReason.source_disabled ?? 0;
    if (live && notIncluded > 0) {
      out.push(item(c, "intake_not_included", "ACTION_REQUIRED", "MEDIUM",
        `יש ${fmt(notIncluded, raw.backlog)} ${plural(notIncluded, `${w.one} שממתינה`, `${w.many} שממתינות`)} מ־${name}`,
        `המקור הזה לא כלול כרגע בחבילה שלכם. ה${w.many} נשמרות וממתינות.`, b.oldestHeldAt, "לפרטים"));
    }
    const platform = b.heldByReason.emergency_disabled ?? 0;
    if (live && platform > 0) {
      out.push(item(c, "intake_platform_hold", "WARNING", "MEDIUM",
        `${fmt(platform, raw.backlog)} ${plural(platform, w.one, w.many)} מ־${name} ${plural(platform, "נשמרת וממתינה", "נשמרות וממתינות")}`,
        `דוביז השהתה זמנית את הקליטה מהמקור הזה. אין צורך לעשות דבר — ה${w.many} ייקלטו כשהקליטה תחזור.`, b.oldestHeldAt, "לפרטים"));
    }
    if (b.deadLetters > 0) {
      out.push(item(c, "intake_failed", "FAILURE_EVENT", "HIGH", `לא הצלחנו להשלים את קליטת חלק מה${w.many}`,
        `${fmt(b.deadLetters, raw.backlog)} ${plural(b.deadLetters, w.one, w.many)} מ־${name} לא נקלטו. אנחנו בודקים זאת.`, b.oldestUnfinishedAt, "לפרטים"));
    }
    const pending = b.due + b.retrying;
    const pendingSince = b.oldestUnfinishedAt;
    if (live && pending > 0 && pendingSince && now.getTime() - pendingSince.getTime() >= PENDING_AFTER_MS && b.held === 0) {
      out.push(item(c, "intake_pending", "WARNING", "LOW",
        `יש ${fmt(pending, raw.backlog)} ${plural(pending, `${w.one} שנקלטה ועדיין בעיבוד`, `${w.many} שנקלטו ועדיין בעיבוד`)}`,
        `${name}: הן יופיעו כשהעיבוד יסתיים.`, pendingSince, "לפרטים"));
    }
  }
  return out;
}

type CacheEntry = { at: number; items: BusinessStatusItemBuild[] };
const cache = new Map<number, CacheEntry>();

/** Lab / tests: forget cached snapshots. */
export function clearIntakeAttentionCache(): void {
  cache.clear();
}

/**
 * The owner's intake items for this business — [] when the feature is off, on any error, or when there is nothing
 * to say. Must run inside the business's tenant context (as every business-status loader does).
 */
export async function loadIntakeAttention(businessId: number, now: Date = new Date()): Promise<BusinessStatusItemBuild[]> {
  try {
    const hit = cache.get(businessId);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS && now.getTime() >= hit.at) return hit.items;
    const access = await runWithTenantContext({ businessId }, () => resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.INTAKE_STATUS_VISIBILITY));
    if (!access.allowed) return [];
    const [connections, backlog, sources] = await Promise.all([
      listConnections(),
      intakeBacklog(businessId, now, { scanCap: OWNER_SCAN_CAP }),
      enabledSources(businessId),
    ]);
    const items = translateIntakeAttention({ connections, backlog, sources }, now);
    cache.set(businessId, { at: now.getTime(), items });
    return items;
  } catch {
    return [];
  }
}

/** What the connections screen shows per connection (counts only). */
export type ConnectionWaiting = { held: number; paused: number; platform: number; notIncluded: number; failed: number; capped: boolean };

/** Pure: per connection id, its waiting / failed counts from one backlog read. */
export function waitingByConnection(connections: IntakeConnectionRow[], backlog: BusinessBacklog): Map<number, ConnectionWaiting> {
  const byRef = new Map<string, ConnectionBacklog>();
  for (const b of backlog.connections) byRef.set(`${b.sourceKey}\u0000${b.providerAccountRef ?? ""}`, b);
  const out = new Map<number, ConnectionWaiting>();
  for (const c of connections) {
    const ref = refOf(c);
    const b = ref ? byRef.get(`${c.sourceKey}\u0000${ref}`) : undefined;
    if (!b) continue;
    const at = (count: number) => cappedCount(count, backlog).n;
    out.set(c.id, {
      held: at(b.held),
      paused: at(b.heldByReason.connection_paused ?? 0),
      platform: at(b.heldByReason.emergency_disabled ?? 0),
      notIncluded: at(b.heldByReason.source_disabled ?? 0),
      failed: at(b.deadLetters),
      capped: backlog.capped,
    });
  }
  return out;
}

/** The connections screen's counts — null when the feature is off (the screen then shows nothing new). */
export async function loadConnectionWaiting(businessId: number, connections: IntakeConnectionRow[], now: Date = new Date()): Promise<Map<number, ConnectionWaiting> | null> {
  try {
    const access = await resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.INTAKE_STATUS_VISIBILITY);
    if (!access.allowed) return null;
    return waitingByConnection(connections, await intakeBacklog(businessId, now, { scanCap: OWNER_SCAN_CAP }));
  } catch {
    return null;
  }
}
