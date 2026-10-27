/**
 * Admin Control Center home (A1) — the few figures that tell the platform's
 * state at a glance, each with ONE written definition.
 *
 * Every read runs on the platform-admin read plane (`app_admin`, SELECT-only,
 * column-scoped; migration 20261024090000). Nothing here writes.
 *
 * Definitions (all windows are rolling unless stated; calendar boundaries are
 * Asia/Jerusalem days, as the rest of Dubiz counts days):
 *   businesses.total     every business except the internal platform business
 *                        and purged ones (deletedAt set).
 *   businesses.activeNd  businesses where, within N days, a user's session was
 *                        used AND at least one product action completed that is
 *                        not an auth event (login/register/logout). A login
 *                        alone is presence, not use.
 *   users.total          users of counted businesses.
 *   users.seen24h        distinct users of counted businesses whose session was
 *                        used within 24 hours. (User.lastLoginAt is not used:
 *                        signup opens a session without stamping it.)
 *   signups.*            Business.createdAt inside today / since Sunday / since
 *                        the 1st; daily30 = the last 30 calendar days.
 *   onboarding           only businesses created after ONBOARDING_RELIABLE_SINCE
 *                        — earlier rows carry the 20261011090000 backfill stamp,
 *                        not a real completion time.
 *   funnel30d            businesses registered in the last 30 calendar days:
 *                        emailVerified (null while verification is off here),
 *                        returnedToLogin (a user has User.lastLoginAt — set only
 *                        by a real login, never by signup), onboarded (profile
 *                        completion stamp), activated (at least one uploaded
 *                        document or one ISSUED billing document).
 *   commercial           Dubiz has no subscription system: stated, not zeroed.
 */
import { BillingDocumentStatus } from "@prisma/client";
import { getPrismaAdmin } from "@/lib/prisma-admin";
import { isEmailVerificationEnabled } from "@/lib/auth/account-recovery-config";
import {
  addCalendarDays,
  jerusalemDayKey,
  startOfJerusalemDayUtc,
  type JerusalemDayKey,
} from "@/lib/utils/jerusalem-day";
import { PRODUCT_USAGE_FEATURES } from "@/lib/services/product-usage/product-usage-catalog";
import { PLATFORM_AUDIT_ACTIONS, PLATFORM_SYSTEM_BUSINESS_NAME } from "./constants";
import type { PlatformAdminHomeResponse } from "./types";

/**
 * When the onboarding backfill finished in Production: release-migrate run
 * 37391190020, job `migrate` completed 2026-10-06T01:21:52Z, applying
 * 20261011090000_onboarding_setup_state (which stamped every existing business
 * with the migration time). Businesses created after this carry a real stamp.
 */
export const ONBOARDING_RELIABLE_SINCE = new Date("2026-10-06T01:22:00.000Z");

const AUTH_FEATURE_KEYS = [
  PRODUCT_USAGE_FEATURES.AUTH_LOGIN,
  PRODUCT_USAGE_FEATURES.AUTH_REGISTER,
  PRODUCT_USAGE_FEATURES.AUTH_LOGOUT,
];

const RECENT_BUSINESSES = 5;
const RECENT_ADMIN_ACTIONS = 6;
const FUNNEL_DAYS = 30;
const DAILY_SERIES_DAYS = 30;

/** Read-only page views are not "actions". */
export const ADMIN_VIEW_ACTIONS: readonly string[] = [
  PLATFORM_AUDIT_ACTIONS.OVERVIEW_VIEWED,
  PLATFORM_AUDIT_ACTIONS.BUSINESSES_LIST_VIEWED,
  PLATFORM_AUDIT_ACTIONS.ATTENTION_VIEWED,
  PLATFORM_AUDIT_ACTIONS.USAGE_OVERVIEW_VIEWED,
  PLATFORM_AUDIT_ACTIONS.BUSINESS_DETAIL_VIEWED,
  PLATFORM_AUDIT_ACTIONS.AUDIT_VIEWED,
  PLATFORM_AUDIT_ACTIONS.ACCOUNTANT_OPS_VIEWED,
  PLATFORM_AUDIT_ACTIONS.SESSION_VIEWED,
  PLATFORM_AUDIT_ACTIONS.HOME_VIEWED,
];

/** Sunday of the Jerusalem week that contains `key` (Israeli weeks start on Sunday). */
export function startOfJerusalemWeek(key: JerusalemDayKey): JerusalemDayKey {
  const [y, m, d] = key.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addCalendarDays(key, -weekday);
}

export function startOfJerusalemMonth(key: JerusalemDayKey): JerusalemDayKey {
  return `${key.slice(0, 7)}-01`;
}

/** Bucket instants into the last `days` Jerusalem calendar days ending at `today`. */
export function dailySeries(
  instants: Date[],
  today: JerusalemDayKey,
  days: number
): Array<{ day: string; count: number }> {
  const series: Array<{ day: string; count: number }> = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = addCalendarDays(today, -i);
    index.set(day, series.length);
    series.push({ day, count: 0 });
  }
  for (const instant of instants) {
    const at = index.get(jerusalemDayKey(instant));
    if (at !== undefined) series[at].count += 1;
  }
  return series;
}

/** Businesses present in BOTH sets (and in the counted universe). */
export function intersectActive(
  withSession: Iterable<number>,
  withAction: Iterable<number>,
  counted: Set<number>
): number {
  const actions = new Set(withAction);
  let n = 0;
  for (const id of new Set(withSession)) {
    if (actions.has(id) && counted.has(id)) n += 1;
  }
  return n;
}

const HOURS = 60 * 60 * 1000;

export async function getPlatformAdminHome(
  now: Date = new Date()
): Promise<PlatformAdminHomeResponse> {
  const db = getPrismaAdmin();
  const today = jerusalemDayKey(now);
  const todayStart = startOfJerusalemDayUtc(today);
  const weekStart = startOfJerusalemDayUtc(startOfJerusalemWeek(today));
  const monthStart = startOfJerusalemDayUtc(startOfJerusalemMonth(today));
  const seriesStart = startOfJerusalemDayUtc(addCalendarDays(today, -(DAILY_SERIES_DAYS - 1)));
  const funnelStart = startOfJerusalemDayUtc(addCalendarDays(today, -(FUNNEL_DAYS - 1)));
  const since24h = new Date(now.getTime() - 24 * HOURS);
  const since7d = new Date(now.getTime() - 7 * 24 * HOURS);
  const since30d = new Date(now.getTime() - 30 * 24 * HOURS);

  const counted = {
    name: { not: PLATFORM_SYSTEM_BUSINESS_NAME },
    deletedAt: null,
  };

  const [
    businessIds,
    usersTotal,
    signupInstants,
    sessions30d,
    actions7d,
    actions30d,
    onboardingCohort,
    onboardingCompleted,
    funnelBusinesses,
    recentBusinesses,
    recentAdminActions,
  ] = await Promise.all([
    db.business.findMany({ where: counted, select: { id: true } }),
    db.user.count({ where: { business: counted } }),
    db.business.findMany({
      where: { ...counted, createdAt: { gte: seriesStart } },
      select: { createdAt: true },
    }),
    // groupBy, not findMany: Prisma's findMany always selects the primary key,
    // and the admin plane is deliberately not granted AuthSession.id. The
    // latest use per user answers every window below.
    db.authSession.groupBy({
      by: ["userId"],
      where: { lastUsedAt: { gte: since30d } },
      _max: { lastUsedAt: true },
    }),
    db.productUsageEvent.findMany({
      where: {
        businessId: { not: null },
        action: "completed",
        featureKey: { notIn: AUTH_FEATURE_KEYS },
        createdAt: { gte: since7d },
      },
      distinct: ["businessId"],
      select: { businessId: true },
    }),
    db.productUsageEvent.findMany({
      where: {
        businessId: { not: null },
        action: "completed",
        featureKey: { notIn: AUTH_FEATURE_KEYS },
        createdAt: { gte: since30d },
      },
      distinct: ["businessId"],
      select: { businessId: true },
    }),
    db.business.count({ where: { ...counted, createdAt: { gt: ONBOARDING_RELIABLE_SINCE } } }),
    db.business.count({
      where: {
        ...counted,
        createdAt: { gt: ONBOARDING_RELIABLE_SINCE },
        profile: { is: { onboardingCompletedAt: { not: null } } },
      },
    }),
    db.business.findMany({
      where: { ...counted, createdAt: { gte: funnelStart } },
      select: {
        id: true,
        profile: { select: { onboardingCompletedAt: true } },
        users: { select: { lastLoginAt: true, emailVerifiedAt: true } },
        _count: {
          select: {
            documentsV2: true,
            billingDocuments: { where: { status: BillingDocumentStatus.ISSUED } },
          },
        },
      },
    }),
    db.business.findMany({
      where: counted,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_BUSINESSES,
      select: {
        id: true,
        name: true,
        createdAt: true,
        users: { orderBy: { id: "asc" }, take: 1, select: { email: true } },
      },
    }),
    db.platformAuditEvent.findMany({
      // Page views and the routine "entered the area" stamp are not actions;
      // both stay in the full log (views / security).
      where: { action: { notIn: [...ADMIN_VIEW_ACTIONS, PLATFORM_AUDIT_ACTIONS.AREA_ENTERED] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_ADMIN_ACTIONS,
      select: {
        id: true,
        action: true,
        actorUserId: true,
        targetType: true,
        targetId: true,
        createdAt: true,
      },
    }),
  ]);

  const countedIds = new Set(businessIds.map((b) => b.id));

  // Sessions → users → businesses (one read for every user seen in 30 days).
  const sessionUserIds = [...new Set(sessions30d.map((s) => s.userId))];
  const sessionUsers =
    sessionUserIds.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: sessionUserIds } },
          select: { id: true, businessId: true },
        });
  const businessOfUser = new Map(sessionUsers.map((u) => [u.id, u.businessId]));

  const seen24h = new Set<number>();
  const sessionBusinesses7d: number[] = [];
  const sessionBusinesses30d: number[] = [];
  for (const s of sessions30d) {
    const lastUsedAt = s._max.lastUsedAt;
    const businessId = businessOfUser.get(s.userId);
    if (!lastUsedAt || businessId === undefined || !countedIds.has(businessId)) continue;
    sessionBusinesses30d.push(businessId);
    if (lastUsedAt >= since7d) sessionBusinesses7d.push(businessId);
    if (lastUsedAt >= since24h) seen24h.add(s.userId);
  }

  const toIds = (rows: Array<{ businessId: number | null }>) =>
    rows.flatMap((r) => (r.businessId === null ? [] : [r.businessId]));

  const verificationOn = isEmailVerificationEnabled();
  let emailVerified = 0;
  let returnedToLogin = 0;
  let onboarded = 0;
  let activated = 0;
  for (const b of funnelBusinesses) {
    if (b.users.some((u) => u.emailVerifiedAt)) emailVerified += 1;
    if (b.users.some((u) => u.lastLoginAt)) returnedToLogin += 1;
    if (b.profile?.onboardingCompletedAt) onboarded += 1;
    if (b._count.documentsV2 > 0 || b._count.billingDocuments > 0) activated += 1;
  }

  const signups = signupInstants.map((b) => b.createdAt);

  return {
    generatedAt: now.toISOString(),
    timeZone: "Asia/Jerusalem",
    today,
    businesses: {
      total: countedIds.size,
      active7d: intersectActive(sessionBusinesses7d, toIds(actions7d), countedIds),
      active30d: intersectActive(sessionBusinesses30d, toIds(actions30d), countedIds),
    },
    users: {
      total: usersTotal,
      seen24h: seen24h.size,
    },
    signups: {
      today: signups.filter((d) => d >= todayStart).length,
      week: signups.filter((d) => d >= weekStart).length,
      month: signups.filter((d) => d >= monthStart).length,
      daily30: dailySeries(signups, today, DAILY_SERIES_DAYS),
    },
    onboarding: {
      reliableSince: ONBOARDING_RELIABLE_SINCE.toISOString(),
      cohort: onboardingCohort,
      completed: onboardingCompleted,
    },
    funnel30d: {
      registered: funnelBusinesses.length,
      emailVerified: verificationOn ? emailVerified : null,
      returnedToLogin,
      onboarded,
      activated,
    },
    commercial: { status: "NO_SUBSCRIPTION_SYSTEM" },
    recentBusinesses: recentBusinesses.map((b) => ({
      id: b.id,
      name: b.name,
      createdAt: b.createdAt.toISOString(),
      ownerEmail: b.users[0]?.email ?? null,
    })),
    recentAdminActions: recentAdminActions.map((e) => ({
      id: e.id,
      action: e.action,
      actorUserId: e.actorUserId,
      targetType: e.targetType,
      targetId: e.targetId,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
