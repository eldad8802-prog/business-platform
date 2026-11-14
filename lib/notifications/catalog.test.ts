/**
 * The notification catalog — pure checks (no database, no network, no clock).
 *
 *   npx tsx lib/notifications/catalog.test.ts
 *
 *  1. Completeness: every category is fully specified (domain, feature key from the platform catalog or null,
 *     importance, defaults, TTL, generic Hebrew lock-screen text, at least one internal href prefix); the spec's
 *     named categories exist; quiet-hours bypass only for user-set reminders and explicitly urgent categories (never
 *     "all money"); rate exemption only for user-set reminders, critical and the engine's own; security in-app not
 *     user-mutable.
 *  2. Classification: every (domain, semanticCategory, severity, entityType) the current writers produce maps to
 *     exactly ONE rule (the rules are mutually exclusive), to the expected category; the policy's two push rules
 *     map to categories that push by default; unknown rows are null (in-app only, never pushed); the engine's own
 *     rows (semanticCategory = key) classify back to their key.
 *  3. Deep links: internal paths under the category prefix only — no scheme, no //, no .., no backslash, no
 *     encoded traversal, no prefix look-alike.
 *  4. Lock screen text names nobody (no digits, no placeholders); collapse keys are bounded and safe.
 */
import {
  LEGACY_CLASSIFICATION_RULES,
  NOTIFICATION_CATEGORIES,
  categoryMayPush,
  classifyNotification,
  collapseKeyOf,
  getCategory,
  safeHref,
  type ClassifiableRow,
} from "./catalog";
import { pushEligibleRuleKeys } from "./notification-policy";
import { isPlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getPlatformFeatureCatalogEntry } from "@/lib/services/feature-access/platform-feature-catalog";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail ?? ""); }
}

console.log("1. completeness");
const REQUIRED = [
  "tasks.reminder", "booking.request_waiting", "inbox.customer_waiting", "inventory.critical_stock", "billing.failure",
  "accountant.send_failed", "connections.disconnected", "connections.account_disconnected", "security.new_device", "digest.daily", "system.test",
];
for (const k of REQUIRED) ok(`spec category ${k} exists`, getCategory(k) !== null);
ok("keys are unique", new Set(NOTIFICATION_CATEGORIES.map((c) => c.key)).size === NOTIFICATION_CATEGORIES.length);
for (const c of NOTIFICATION_CATEGORIES) {
  const shapeOk =
    /^[a-z]+\.[a-z_]+$/.test(c.key) && c.key.length <= 64 && /^[a-z_]+$/.test(c.domain) &&
    (c.featureKey === null || isPlatformFeatureKey(c.featureKey)) &&
    ["critical", "high", "normal", "low"].includes(c.importance) &&
    typeof c.defaults.inApp === "boolean" && typeof c.defaults.push === "boolean" && ["instant", "digest"].includes(c.defaults.delivery) &&
    Number.isInteger(c.ttlMinutes) && c.ttlMinutes > 0 && c.ttlMinutes <= 24 * 60 && Number.isInteger(c.cooldownHours) && c.cooldownHours >= 0 &&
    c.hrefPrefixes.length > 0 && c.hrefPrefixes.every((p) => /^\/[a-z0-9/_-]+$/.test(p) && !p.endsWith("/")) &&
    /[֐-׿]/.test(c.lockScreen.title) && /[֐-׿]/.test(c.lockScreen.body);
  ok(`${c.key}: fully specified`, shapeOk, c);
  ok(`${c.key}: the preference key fits the DB CHECK`, /^(domain|category):[a-z0-9_.]{1,64}$/.test(`category:${c.key}`) && /^(domain|category):[a-z0-9_.]{1,64}$/.test(`domain:${c.domain}`));
  ok(`${c.key}: lock-screen text names nobody (no digits, no placeholders)`, !/[0-9{}$<>]/.test(c.lockScreen.title + c.lockScreen.body));
}
const bypass = NOTIFICATION_CATEGORIES.filter((c) => c.quietBypass).map((c) => c.key).sort();
ok("quiet-hours bypass: only the user-set reminder, the security alert and the test push", JSON.stringify(bypass) === JSON.stringify(["security.new_device", "system.test", "tasks.reminder"]), bypass);
ok("no money category bypasses quiet hours", NOTIFICATION_CATEGORIES.filter((c) => /billing|accountant|payment|collection/.test(c.key)).every((c) => !c.quietBypass));
const exempt = NOTIFICATION_CATEGORIES.filter((c) => c.rateExempt);
ok("rate exemption: user-set reminders, critical, and the engine's own (digest, test) only",
  exempt.every((c) => c.key === "tasks.reminder" || c.importance === "critical" || c.domain === "system"), exempt.map((c) => c.key));
ok("security.new_device: in-app is NOT user-mutable", getCategory("security.new_device")!.userMutable.inApp === false);
ok("the engine's feature key exists and is OFF by default",
  PLATFORM_FEATURE_KEYS.NOTIFICATIONS_ENGINE === "notifications_engine" && getPlatformFeatureCatalogEntry("notifications_engine").defaultEnabled === false);

console.log("2. classification");
const TUPLES: [ClassifiableRow, string | null][] = [
  [{ domain: "tasks", semanticCategory: "task_reminder", severity: "REMINDER", entityType: "task" }, "tasks.reminder"],
  [{ domain: "appointments", semanticCategory: "ACTION_REQUIRED", severity: "HIGH", entityType: "booking_request" }, "booking.request_waiting"],
  [{ domain: "documents", semanticCategory: "FAILURE_EVENT", severity: "HIGH", entityType: "accountant_period_send_failed" }, "accountant.send_failed"],
  [{ domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM", entityType: "accountant_period_ready" }, "accountant.month_close"],
  [{ domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM", entityType: "accountant_period_changed" }, "accountant.month_close"],
  [{ domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "HIGH", entityType: "documents_review_queue" }, "documents.review"],
  [{ domain: "documents", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM", entityType: "document" }, "documents.review"],
  [{ domain: "inventory", semanticCategory: "ALERT", severity: "CRITICAL", entityType: "inventory_item" }, "inventory.critical_stock"],
  [{ domain: "inventory", semanticCategory: "ALERT", severity: "HIGH", entityType: "inventory_item" }, "inventory.attention"],
  [{ domain: "billing", semanticCategory: "FAILURE_EVENT", severity: "HIGH", entityType: "billing_document" }, "billing.failure"],
  [{ domain: "billing", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM", entityType: "billing_document" }, "billing.review"],
  [{ domain: "inbox", semanticCategory: "ACTION_REQUIRED", severity: "HIGH", entityType: "conversation" }, "inbox.customer_waiting"],
  [{ domain: "leads", semanticCategory: "ACTION_REQUIRED", severity: "HIGH", entityType: "intake_failed" }, "connections.disconnected"],
  [{ domain: "leads", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM", entityType: "intake_check_connection" }, "connections.disconnected"],
  [{ domain: "leads", semanticCategory: "ACTION_REQUIRED", severity: "HIGH", entityType: "lead" }, "leads.follow_up"],
  [{ domain: "supplier", semanticCategory: "ACTION_REQUIRED", severity: "MEDIUM", entityType: "supplier_purchase_draft" }, "suppliers.purchase_pending"],
  // unknown: in-app only, never pushed
  [{ domain: "payables", semanticCategory: "ACTION_REQUIRED", severity: "HIGH", entityType: "installment" }, null],
  [{ domain: "inventory", semanticCategory: "WARNING", severity: "LOW", entityType: "inventory_item" }, null],
  [{ domain: "mystery", semanticCategory: "ALERT", severity: "CRITICAL", entityType: "x" }, null],
  // engine rows
  [{ domain: "system", semanticCategory: "digest.daily", severity: "MEDIUM", entityType: "digest" }, "digest.daily"],
  [{ domain: "security", semanticCategory: "security.new_device", severity: "CRITICAL", entityType: "session" }, "security.new_device"],
  [{ domain: "inventory", semanticCategory: "digest.daily", severity: "MEDIUM", entityType: "digest" }, null],
  [{ domain: "system", semanticCategory: "no.such", severity: "MEDIUM", entityType: "x" }, null],
];
for (const [row, want] of TUPLES) {
  const matches = LEGACY_CLASSIFICATION_RULES.filter((r) =>
    r.domain === row.domain && (!r.semanticCategories || r.semanticCategories.includes(row.semanticCategory)) &&
    (!r.severities || r.severities.includes(row.severity)) && (!r.entityTypes || r.entityTypes.includes(row.entityType)));
  const got = classifyNotification(row)?.key ?? null;
  ok(`${JSON.stringify(row)} → ${want}`, got === want, got);
  if (!row.semanticCategory.includes(".")) ok(`…matched by at most one legacy rule`, matches.length <= 1, matches.map((m) => m.category));
}
ok("every legacy rule names a real category", LEGACY_CLASSIFICATION_RULES.every((r) => getCategory(r.category) !== null));
for (const rk of pushEligibleRuleKeys()) {
  const [domain, semanticCategory, severity] = rk.split("|");
  const cat = classifyNotification({ domain, semanticCategory, severity, entityType: "x" });
  ok(`the policy's push rule ${rk} maps to a category that pushes by default`, cat !== null && cat.defaults.push, cat?.key);
}
ok("unknown categories never push", categoryMayPush(null) === false);

console.log("3. deep links");
const P = ["/tasks"];
const hrefCases: [unknown, string | null][] = [
  ["/tasks", "/tasks"], ["/tasks?task=12", "/tasks?task=12"], ["/tasks/12#x", "/tasks/12#x"],
  ["/tasksx", null], ["/task", null], ["tasks", null], ["//evil.example/tasks", null], ["https://evil.example/tasks", null],
  ["javascript:alert(1)", null], ["/tasks/../billing", null], ["/tasks/%2e%2e/billing", null], ["/tasks\\..\\x", null],
  ["/tasks/ x", null], ["/tasks\n", null], ["", null], [null, null], [42, null], ["/" + "a".repeat(600), null], ["/tasks/./x", null],
];
for (const [h, want] of hrefCases) ok(`safeHref(${JSON.stringify(h)}) → ${JSON.stringify(want)}`, safeHref(h, P) === want);
ok("booking hrefs from the writer are accepted", safeHref("/calendar?view=requests&request=7", getCategory("booking.request_waiting")!.hrefPrefixes) !== null);
ok("the accountant href is accepted", safeHref("/documents/accountant-pack?period=2026-10", getCategory("accountant.send_failed")!.hrefPrefixes) !== null);

console.log("4. collapse keys");
const ck = collapseKeyOf(getCategory("inventory.critical_stock")!, { type: "inventory item/<x>", id: 7 });
ok("collapse key is [A-Za-z0-9_.-]{1,64}", /^[A-Za-z0-9_.-]{1,64}$/.test(ck), ck);
ok("collapse key is stable per category and entity", ck === collapseKeyOf(getCategory("inventory.critical_stock")!, { type: "inventory item/<x>", id: 7 }));
ok("collapse key differs per entity", ck !== collapseKeyOf(getCategory("inventory.critical_stock")!, { type: "inventory item/<x>", id: 8 }));
ok("a long entity type is bounded", collapseKeyOf(getCategory("tasks.reminder")!, { type: "x".repeat(200), id: 1 }).length <= 64);

console.log(`\n[catalog] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
