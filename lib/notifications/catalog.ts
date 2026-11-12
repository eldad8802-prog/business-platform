/**
 * The notification catalog — the single source of truth for every notification CATEGORY (notifications track,
 * owner-approved spec 2026-11-12).
 *
 * A category says, once: which domain it belongs to, which platform feature must be available for it to exist,
 * how important it is, its defaults (in-app / push / instant or digest), whether it may break quiet hours or the
 * per-user push rate limit, which aspects a user may change, how long an owed push stays worth sending (TTL),
 * how it is grouped on the device (collapse key), what a LOCKED screen may show (generic Hebrew text, no names,
 * amounts or document numbers), and which internal routes its deep link may open.
 *
 * Existing writers (the snapshot writer, the task reminders, the public booking notices) store a domain vocabulary
 * (domain, semanticCategory, severity, entityType) rather than a category key. `classifyNotification` maps those
 * rows onto the catalog with declarative, mutually exclusive rules; the engine's own rows (`notify()`) store the
 * category key itself in `semanticCategory`. A row no rule recognises is UNKNOWN: shown in-app, never pushed.
 *
 * Pure module: no database, no network, no clock.
 */
import { PLATFORM_FEATURE_KEYS, type PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

export type Importance = "critical" | "high" | "normal" | "low";
export type DeliveryMode = "instant" | "digest";

export type CategoryDefinition = {
  key: string;
  domain: string;
  /** The platform feature that must be available to the business, or null (always available). */
  featureKey: PlatformFeatureKey | null;
  importance: Importance;
  defaults: { inApp: boolean; push: boolean; delivery: DeliveryMode };
  /** True ONLY for reminders the user set for an explicit time and explicitly urgent categories. */
  quietBypass: boolean;
  /** Not counted against / not held by the per-user push rate limit: user-set reminders and critical only. */
  rateExempt: boolean;
  /** Which aspects a user may override. Security categories: in-app is not mutable. */
  userMutable: { inApp: boolean; push: boolean; delivery: boolean };
  cooldownHours: number;
  /** How long an owed push stays worth sending, in minutes (the owed row's expiresAt = creation + TTL). */
  ttlMinutes: number;
  /** Lock-screen-safe generic text (shown unless the user enabled lockScreenDetails). */
  lockScreen: { title: string; body: string };
  /**
   * The stored title / summary of this category are written by the engine itself from counts only (never a name,
   * an amount or a document number), so they may be shown on a locked screen.
   */
  storedTextLockScreenSafe?: true;
  /** Internal route prefixes a deep link of this category may open. The first is the fallback. */
  hrefPrefixes: readonly string[];
};

export const GENERIC_PUSH_TITLE = "דוביז";

const CATEGORY_LIST = [
  {
    key: "tasks.reminder",
    domain: "tasks",
    featureKey: PLATFORM_FEATURE_KEYS.DAILY_TASKS,
    importance: "high",
    defaults: { inApp: true, push: true, delivery: "instant" },
    quietBypass: true,
    rateExempt: true,
    userMutable: { inApp: true, push: true, delivery: false },
    cooldownHours: 0,
    ttlMinutes: 24 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש לך תזכורת חדשה" },
    hrefPrefixes: ["/tasks"],
  },
  {
    key: "booking.request_waiting",
    domain: "appointments",
    featureKey: PLATFORM_FEATURE_KEYS.PUBLIC_BOOKING,
    importance: "high",
    defaults: { inApp: true, push: true, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 0,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "בקשה לתור ממתינה לאישורך" },
    hrefPrefixes: ["/calendar"],
  },
  {
    key: "inbox.customer_waiting",
    domain: "inbox",
    featureKey: PLATFORM_FEATURE_KEYS.INBOX,
    importance: "high",
    defaults: { inApp: true, push: false, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 12,
    ttlMinutes: 6 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "לקוח מחכה לתשובה" },
    hrefPrefixes: ["/inbox"],
  },
  {
    key: "inventory.critical_stock",
    domain: "inventory",
    featureKey: PLATFORM_FEATURE_KEYS.INVENTORY,
    importance: "high",
    defaults: { inApp: true, push: true, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 24,
    ttlMinutes: 6 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש פריט במלאי שדורש טיפול" },
    hrefPrefixes: ["/inventory"],
  },
  {
    key: "inventory.attention",
    domain: "inventory",
    featureKey: PLATFORM_FEATURE_KEYS.INVENTORY,
    importance: "normal",
    defaults: { inApp: true, push: false, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 24,
    ttlMinutes: 6 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש עדכון במלאי" },
    hrefPrefixes: ["/inventory"],
  },
  {
    key: "billing.failure",
    domain: "billing",
    featureKey: PLATFORM_FEATURE_KEYS.BILLING,
    importance: "high",
    defaults: { inApp: true, push: true, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 12,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש מסמך חיוב שדורש טיפול" },
    hrefPrefixes: ["/billing"],
  },
  {
    key: "billing.review",
    domain: "billing",
    featureKey: PLATFORM_FEATURE_KEYS.BILLING,
    importance: "normal",
    defaults: { inApp: true, push: false, delivery: "digest" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 48,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש מסמכי חיוב שממתינים לבדיקה" },
    hrefPrefixes: ["/billing", "/collection"],
  },
  {
    key: "documents.review",
    domain: "documents",
    featureKey: PLATFORM_FEATURE_KEYS.DOCUMENTS,
    importance: "normal",
    defaults: { inApp: true, push: false, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 48,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש מסמכים שממתינים לבדיקה" },
    hrefPrefixes: ["/documents"],
  },
  {
    key: "accountant.send_failed",
    domain: "accountant",
    featureKey: PLATFORM_FEATURE_KEYS.ACCOUNTANT_DELIVERY,
    importance: "high",
    defaults: { inApp: true, push: false, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 24,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "השליחה לרואה החשבון לא הושלמה" },
    hrefPrefixes: ["/documents/accountant-pack"],
  },
  {
    key: "accountant.month_close",
    domain: "accountant",
    featureKey: PLATFORM_FEATURE_KEYS.ACCOUNTANT_MONTH_CLOSE,
    importance: "normal",
    defaults: { inApp: true, push: false, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 72,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש עדכון בסגירת החודש" },
    hrefPrefixes: ["/documents/accountant-pack"],
  },
  {
    key: "connections.disconnected",
    domain: "connections",
    featureKey: PLATFORM_FEATURE_KEYS.INTAKE_STATUS_VISIBILITY,
    importance: "normal",
    defaults: { inApp: true, push: false, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 24,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש חיבור שדורש בדיקה" },
    hrefPrefixes: ["/settings/connections"],
  },
  {
    key: "leads.follow_up",
    domain: "leads",
    featureKey: null,
    importance: "normal",
    defaults: { inApp: true, push: false, delivery: "instant" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 24,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש פנייה שמחכה לטיפול" },
    hrefPrefixes: ["/leads"],
  },
  {
    key: "suppliers.purchase_pending",
    domain: "suppliers",
    featureKey: PLATFORM_FEATURE_KEYS.INVENTORY,
    importance: "low",
    defaults: { inApp: true, push: false, delivery: "digest" },
    quietBypass: false,
    rateExempt: false,
    userMutable: { inApp: true, push: true, delivery: true },
    cooldownHours: 72,
    ttlMinutes: 12 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "יש רכש מספק שממתין" },
    hrefPrefixes: ["/inventory/supplier-purchases"],
  },
  {
    key: "security.new_device",
    domain: "security",
    featureKey: null,
    importance: "critical",
    defaults: { inApp: true, push: true, delivery: "instant" },
    quietBypass: true,
    rateExempt: true,
    userMutable: { inApp: false, push: true, delivery: false },
    cooldownHours: 0,
    ttlMinutes: 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "נכנסו לחשבון שלך ממכשיר חדש" },
    hrefPrefixes: ["/profile"],
  },
  {
    key: "digest.daily",
    domain: "system",
    featureKey: null,
    importance: "normal",
    defaults: { inApp: true, push: true, delivery: "instant" },
    quietBypass: false,
    rateExempt: true,
    userMutable: { inApp: false, push: true, delivery: false },
    cooldownHours: 24,
    ttlMinutes: 6 * 60,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "סיכום יומי מחכה לך" },
    storedTextLockScreenSafe: true,
    hrefPrefixes: ["/notifications"],
  },
  {
    key: "system.test",
    domain: "system",
    featureKey: null,
    importance: "normal",
    defaults: { inApp: true, push: true, delivery: "instant" },
    quietBypass: true,
    rateExempt: true,
    userMutable: { inApp: false, push: false, delivery: false },
    cooldownHours: 0,
    ttlMinutes: 15,
    lockScreen: { title: GENERIC_PUSH_TITLE, body: "זו התראת בדיקה" },
    storedTextLockScreenSafe: true,
    hrefPrefixes: ["/notifications"],
  },
] as const satisfies readonly CategoryDefinition[];

export type CategoryKey = (typeof CATEGORY_LIST)[number]["key"];

export const NOTIFICATION_CATEGORIES: readonly CategoryDefinition[] = CATEGORY_LIST;
const BY_KEY = new Map<string, CategoryDefinition>(NOTIFICATION_CATEGORIES.map((c) => [c.key, c]));

export const NOTIFICATION_DOMAINS: readonly string[] = [...new Set(NOTIFICATION_CATEGORIES.map((c) => c.domain))].sort();

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && BY_KEY.has(value);
}

export function getCategory(key: string): CategoryDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** May this category ever reach a device (by default or by a user's choice)? Unknown categories never. */
export function categoryMayPush(cat: CategoryDefinition | null): boolean {
  return cat !== null && (cat.defaults.push || cat.userMutable.push);
}

/* ─────────────────────────────────────────────── classification of stored rows ── */

/**
 * One declarative rule per legacy vocabulary slice. The rules are MUTUALLY EXCLUSIVE (proved by the catalog test
 * over every tuple the current writers produce): each names a domain and narrows by entity type or by
 * (semanticCategory, severity). Legacy rows never carry a '.' in semanticCategory; the engine's rows always do —
 * so the two families can never overlap either.
 */
export type ClassificationRule = {
  category: CategoryKey;
  domain: string;
  semanticCategories?: readonly string[];
  severities?: readonly string[];
  entityTypes?: readonly string[];
};

/** The intake facts (lib/notifications/intake-notifications.ts INTAKE_NOTIFICATION_SCOPE). */
const INTAKE_ENTITY_TYPES = [
  "intake_paused",
  "intake_not_included",
  "intake_platform_hold",
  "intake_check_connection",
  "intake_failed",
  "intake_pending",
  "intake_backlog",
  "intake_recovered",
] as const;

/** The monthly accountant notices (lib/accountant/notify.ts ACCOUNTANT_ENTITY_TYPES), except SEND_FAILED. */
const ACCOUNTANT_MONTH_ENTITY_TYPES = [
  "accountant_period_ready",
  "accountant_period_attention",
  "accountant_period_failed",
  "accountant_period_changed",
] as const;

export const LEGACY_CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  // lib/services/tasks/task-reminders.service.ts (REMINDER_DOMAIN / REMINDER_CATEGORY / REMINDER_SEVERITY).
  { category: "tasks.reminder", domain: "tasks", semanticCategories: ["task_reminder"] },
  // lib/services/booking/booking-notify.ts (BOOKING_DOMAIN / BOOKING_ENTITY).
  { category: "booking.request_waiting", domain: "appointments", entityTypes: ["booking_request"] },
  // lib/accountant/notify.ts — rides the documents domain.
  // …and a recipient's complaint (spam report) about the package (lib/accountant/notify.ts COMPLAINT_ENTITY_TYPE):
  // the accountant did not really receive the month either.
  { category: "accountant.send_failed", domain: "documents", entityTypes: ["accountant_period_send_failed", "accountant_delivery_complained"] },
  { category: "accountant.month_close", domain: "documents", entityTypes: ACCOUNTANT_MONTH_ENTITY_TYPES },
  // lib/notifications/documents-review-queue-notifications.ts and the documents translator.
  { category: "documents.review", domain: "documents", entityTypes: ["documents_review_queue", "document"] },
  // lib/notifications/inventory-alert-notifications.ts (policy: ALERT CRITICAL → push, ALERT HIGH → in-app).
  { category: "inventory.critical_stock", domain: "inventory", semanticCategories: ["ALERT"], severities: ["CRITICAL"] },
  { category: "inventory.attention", domain: "inventory", semanticCategories: ["ALERT"], severities: ["HIGH"] },
  // The billing translator (policy: FAILURE_EVENT HIGH → push; ACTION_REQUIRED → in-app).
  { category: "billing.failure", domain: "billing", semanticCategories: ["FAILURE_EVENT"] },
  { category: "billing.review", domain: "billing", semanticCategories: ["ACTION_REQUIRED"] },
  // lib/notifications/inbox-waiting-notifications.ts.
  { category: "inbox.customer_waiting", domain: "inbox", semanticCategories: ["ACTION_REQUIRED"] },
  // lib/notifications/intake-notifications.ts — the business's lead intake connections.
  { category: "connections.disconnected", domain: "leads", entityTypes: INTAKE_ENTITY_TYPES },
  // The leads translator.
  { category: "leads.follow_up", domain: "leads", entityTypes: ["lead"] },
  // The supplier translator.
  { category: "suppliers.purchase_pending", domain: "supplier" },
];

export type ClassifiableRow = { domain: string; semanticCategory: string; severity: string; entityType: string };

function ruleMatches(rule: ClassificationRule, row: ClassifiableRow): boolean {
  if (rule.domain !== row.domain) return false;
  if (rule.semanticCategories && !rule.semanticCategories.includes(row.semanticCategory)) return false;
  if (rule.severities && !rule.severities.includes(row.severity)) return false;
  if (rule.entityTypes && !rule.entityTypes.includes(row.entityType)) return false;
  return true;
}

/** The catalog category of a stored Notification row, or null (UNKNOWN: in-app only, never pushed). */
export function classifyNotification(row: ClassifiableRow): CategoryDefinition | null {
  if (row.semanticCategory.includes(".")) {
    const cat = getCategory(row.semanticCategory);
    return cat && cat.domain === row.domain ? cat : null;
  }
  for (const rule of LEGACY_CLASSIFICATION_RULES) {
    if (ruleMatches(rule, row)) return getCategory(rule.category);
  }
  return null;
}

/** Every rule (legacy + the engine's own key rule) that classifies rows into `key` — for the read-side filter. */
export function rulesForCategory(key: string): ClassificationRule[] {
  const cat = getCategory(key);
  if (!cat) return [];
  return [
    { category: cat.key as CategoryKey, domain: cat.domain, semanticCategories: [cat.key] },
    ...LEGACY_CLASSIFICATION_RULES.filter((r) => r.category === key),
  ];
}

/* ─────────────────────────────────────────────────────────────── helpers ── */

/** Android tag / web push topic: per category and entity, so a newer push replaces the older one on the device. */
export function collapseKeyOf(cat: CategoryDefinition, entity: { type: string; id: number }): string {
  const raw = `${cat.key}-${entity.type}-${entity.id}`;
  return raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

/** Notification.severity written by notify() — the stored vocabulary is upper-case. */
export function severityOf(importance: Importance): string {
  return importance === "critical" ? "CRITICAL" : importance === "high" ? "HIGH" : importance === "normal" ? "MEDIUM" : "LOW";
}

/** Android channel (created by the app): urgent for critical / high, default otherwise. */
export function androidChannelOf(importance: Importance): "dubiz_urgent" | "dubiz_default" {
  return importance === "critical" || importance === "high" ? "dubiz_urgent" : "dubiz_default";
}

/**
 * A deep link the device may open: an internal path (no scheme, no host, no `//`, no `..`, no backslash, no
 * whitespace or control character) whose path equals one of the category's prefixes or continues it with `/`.
 * Returns the href, or null when it may not be used.
 */
export function safeHref(href: unknown, prefixes: readonly string[]): string | null {
  if (typeof href !== "string" || href.length === 0 || href.length > 512) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (/[\\\s\u0000-\u001f\u007f]/.test(href)) return null;
  const path = href.split(/[?#]/, 1)[0];
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  if (/%2e|%2f|%5c/i.test(path)) return null;
  if (/^\/[^/]*:/.test(path)) return null;
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`)) ? href : null;
}
