/**
 * Run: npx tsx lib/services/platform-admin/platform-admin-a1.test.ts
 *
 * Admin Control Center A1 — the definitions behind the console, as pure
 * functions: what a business-list filter selects, how a calendar day / week /
 * month is cut in Israel time (DST included), what counts as an active
 * business, and how the action log describes a change.
 *
 * OFFLINE: no database. The same services run as the real admin role against
 * cross-tenant data in .apa1/battery.ts.
 */
import assert from "node:assert/strict";
import {
  BUSINESS_INACTIVE_WINDOW_DAYS,
  BUSINESS_NEW_WINDOW_DAYS,
  BUSINESS_SEARCH_MAX_LENGTH,
  buildBusinessListWhere,
  businessLifecycle,
  parseListPlatformBusinessesQuery,
} from "./platform-businesses.service";
import {
  ADMIN_VIEW_ACTIONS,
  ONBOARDING_RELIABLE_SINCE,
  dailySeries,
  intersectActive,
  startOfJerusalemMonth,
  startOfJerusalemWeek,
} from "./platform-home.service";
import {
  AUDIT_KIND_SETS,
  formatAuditActionLabel,
  formatAuditActionTone,
  formatAuditDetail,
  isAuditViewAction,
} from "./platform-audit-format";
import { PLATFORM_AUDIT_ACTIONS } from "./constants";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const NOW = new Date("2026-10-22T09:00:00.000Z");
const DAY = 86_400_000;

/* ------------------------------ business list ----------------------------- */

check("every list excludes the platform business and purged businesses", () => {
  const where = buildBusinessListWhere({ q: null, filter: "all" }, NOW);
  const and = where.AND as object[];
  assert.deepEqual(and[0], { name: { not: "__PLATFORM_SYSTEM__" } });
  assert.deepEqual(and[1], { deletedAt: null });
  assert.equal(and.length, 2);
});

check("search matches name or user email; an all-digit query also matches the id", () => {
  const text = (buildBusinessListWhere({ q: "קפה", filter: "all" }, NOW).AND as Array<{ OR?: object[] }>)[2];
  assert.equal(text.OR?.length, 2);
  const digits = (buildBusinessListWhere({ q: "412", filter: "all" }, NOW).AND as Array<{ OR?: object[] }>)[2];
  assert.deepEqual(digits.OR?.[0], { id: 412 });
  assert.equal(digits.OR?.length, 3);
  const huge = (buildBusinessListWhere({ q: "1234567890", filter: "all" }, NOW).AND as Array<{ OR?: object[] }>)[2];
  assert.equal(huge.OR?.length, 2, "a number beyond int range is searched as text only");
});

check(`"new" = joined within ${BUSINESS_NEW_WINDOW_DAYS} days`, () => {
  const f = (buildBusinessListWhere({ q: null, filter: "new" }, NOW).AND as Array<{ createdAt?: { gte: Date } }>)[2];
  assert.equal(f.createdAt?.gte.getTime(), NOW.getTime() - BUSINESS_NEW_WINDOW_DAYS * DAY);
});

check(`"inactive" = no user session used within ${BUSINESS_INACTIVE_WINDOW_DAYS} days`, () => {
  const f = (buildBusinessListWhere({ q: null, filter: "inactive" }, NOW).AND as Array<Record<string, unknown>>)[2];
  const since = (f as { users: { none: { authSessions: { some: { lastUsedAt: { gte: Date } } } } } }).users.none
    .authSessions.some.lastUsedAt.gte;
  assert.equal(since.getTime(), NOW.getTime() - BUSINESS_INACTIVE_WINDOW_DAYS * DAY);
});

check('"no_onboarding" = no profile, or no completion stamp', () => {
  const f = (buildBusinessListWhere({ q: null, filter: "no_onboarding" }, NOW).AND as Array<{ OR?: object[] }>)[2];
  assert.deepEqual(f.OR, [{ profile: { is: null } }, { profile: { is: { onboardingCompletedAt: null } } }]);
});

check("list query parsing rejects bad input and bounds the search", () => {
  const ok = parseListPlatformBusinessesQuery(new URLSearchParams("page=2&limit=50&q=%20abc%20&filter=new"));
  assert.deepEqual({ page: ok.page, limit: ok.limit, q: ok.q, filter: ok.filter }, { page: 2, limit: 50, q: "abc", filter: "new" });
  assert.equal(parseListPlatformBusinessesQuery(new URLSearchParams("q=%20%20")).q, null);
  assert.throws(() => parseListPlatformBusinessesQuery(new URLSearchParams("filter=everything")));
  assert.throws(() => parseListPlatformBusinessesQuery(new URLSearchParams("limit=101")));
  assert.throws(() => parseListPlatformBusinessesQuery(new URLSearchParams("page=1.5")));
  assert.throws(() =>
    parseListPlatformBusinessesQuery(new URLSearchParams({ q: "x".repeat(BUSINESS_SEARCH_MAX_LENGTH + 1) }))
  );
});

check("lifecycle: a deletion request outranks the archive stamp", () => {
  const d = new Date();
  assert.equal(businessLifecycle({ archivedAt: null, deletionRequestedAt: null }), "ACTIVE");
  assert.equal(businessLifecycle({ archivedAt: d, deletionRequestedAt: null }), "ARCHIVED");
  assert.equal(businessLifecycle({ archivedAt: d, deletionRequestedAt: d }), "DELETION_REQUESTED");
});

/* ------------------------------ calendar cuts ----------------------------- */

check("an Israeli week starts on Sunday", () => {
  assert.equal(startOfJerusalemWeek("2026-10-22"), "2026-10-18"); // Thursday → Sunday
  assert.equal(startOfJerusalemWeek("2026-10-18"), "2026-10-18"); // Sunday stays
  assert.equal(startOfJerusalemWeek("2026-10-24"), "2026-10-18"); // Saturday → same week
  assert.equal(startOfJerusalemWeek("2026-11-01"), "2026-11-01");
});

check("a month starts on the 1st", () => {
  assert.equal(startOfJerusalemMonth("2026-10-22"), "2026-10-01");
  assert.equal(startOfJerusalemMonth("2027-01-01"), "2027-01-01");
});

check("the daily series buckets by Jerusalem day, including across the October DST change", () => {
  // Israel leaves summer time on Sunday 2026-10-25 at 02:00 local.
  const today = "2026-10-26";
  const instants = [
    new Date("2026-10-24T21:30:00.000Z"), // 00:30 IDT on 10-25 → 10-25
    new Date("2026-10-25T21:30:00.000Z"), // 23:30 IST on 10-25 → 10-25
    new Date("2026-10-25T22:30:00.000Z"), // 00:30 IST on 10-26 → 10-26
    new Date("2026-09-01T10:00:00.000Z"), // outside the window → ignored
  ];
  const series = dailySeries(instants, today, 3);
  assert.deepEqual(series, [
    { day: "2026-10-24", count: 0 },
    { day: "2026-10-25", count: 2 },
    { day: "2026-10-26", count: 1 },
  ]);
});

check("active = session used AND a product action, within the counted universe", () => {
  const counted = new Set([1, 2, 3]);
  assert.equal(intersectActive([1, 2, 2, 4], [2, 3, 4], counted), 1, "only 2 has both and is counted");
  assert.equal(intersectActive([], [1, 2], counted), 0, "an action without a session is not activity");
  assert.equal(intersectActive([1, 2], [], counted), 0, "a login alone is presence, not use");
});

check("the onboarding cut is the recorded backfill completion (run 37391190020)", () => {
  assert.equal(ONBOARDING_RELIABLE_SINCE.toISOString(), "2026-10-06T01:22:00.000Z");
});

/* ------------------------------- action log ------------------------------- */

check("every audit action has a Hebrew label (no raw keys on screen)", () => {
  for (const action of Object.values(PLATFORM_AUDIT_ACTIONS)) {
    assert.notEqual(formatAuditActionLabel(action), action, `missing label for ${action}`);
  }
});

check("a feature change shows from → to and the reason", () => {
  const detail = formatAuditDetail(PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED, {
    featureKey: "daily_tasks",
    oldState: "INHERIT",
    newState: "ENABLED",
    reason: "השתתפות בבטא",
  });
  assert.equal(detail, "daily_tasks: ברירת מחדל ← פעיל · סיבה: השתתפות בבטא");
  assert.equal(formatAuditActionTone(PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED), "warning");
});

check("a step-up names the factor that opened the session", () => {
  assert.equal(formatAuditDetail(PLATFORM_AUDIT_ACTIONS.STEP_UP_SUCCEEDED, { method: "recovery_code" }), "קוד שחזור");
  assert.equal(formatAuditDetail(PLATFORM_AUDIT_ACTIONS.STEP_UP_FAILED, { method: "passkey", reason: "replayed" }), "מפתח גישה");
});

check("kind filters are disjoint, and the home's view list matches the log's", () => {
  const views = new Set<string>(AUDIT_KIND_SETS.views);
  for (const a of AUDIT_KIND_SETS.security) assert.equal(views.has(a), false, `${a} is both a view and security`);
  assert.deepEqual([...ADMIN_VIEW_ACTIONS].sort(), [...AUDIT_KIND_SETS.views].sort());
  for (const a of ADMIN_VIEW_ACTIONS) assert.equal(isAuditViewAction(a), true);
  assert.equal(isAuditViewAction(PLATFORM_AUDIT_ACTIONS.FEATURE_ACCESS_UPDATED), false);
});

console.log(`\nAdmin Control Center A1 definitions: OK — ${passed} checks passed`);
