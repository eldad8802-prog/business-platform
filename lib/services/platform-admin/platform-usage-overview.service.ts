import { prisma } from "@/lib/prisma";
import { PRODUCT_USAGE_FEATURES } from "@/lib/services/product-usage/product-usage-catalog";
import { PLATFORM_SYSTEM_BUSINESS_NAME } from "./constants";

const WINDOW_DAYS = 7;
const FRICTION_MIN_OPENED = 5;
const FRICTION_MAX_COMPLETION_RATE = 0.5;

export type PlatformUsageOverviewResponse = {
  generatedAt: string;
  windowDays: number;
  logins: {
    successCount: number;
    failureCount: number;
    uniqueUsersSuccess: number;
  };
  activity: {
    activeUsers: number;
    activeBusinesses: number;
  };
  topFeatures: Array<{
    featureKey: string;
    opened: number;
    completed: number;
    failed: number;
  }>;
  featureRates: Array<{
    featureKey: string;
    opened: number;
    completed: number;
    failed: number;
    completionRate: number | null;
    failureRate: number | null;
  }>;
  frictionCandidates: Array<{
    featureKey: string;
    opened: number;
    completed: number;
    failed: number;
    completionRate: number;
    reason: string;
  }>;
  lastLoginActivity: Array<{
    userId: number;
    email: string;
    businessName: string;
    lastLoginAt: string;
    loginCount: number;
  }>;
  hasInsights: boolean;
};

const MIN_INSIGHTS_EVENTS = 3;

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export async function getPlatformUsageOverview(): Promise<PlatformUsageOverviewResponse> {
  const since = daysAgo(WINDOW_DAYS);
  const authLoginKey = PRODUCT_USAGE_FEATURES.AUTH_LOGIN;

  const [
    loginSuccessCount,
    loginFailureCount,
    loginSuccessUsers,
    activeUsers,
    activeBusinesses,
    featureGroups,
    recentLogins,
  ] = await Promise.all([
    prisma.productUsageEvent.count({
      where: {
        featureKey: authLoginKey,
        action: "completed",
        createdAt: { gte: since },
      },
    }),
    prisma.productUsageEvent.count({
      where: {
        featureKey: authLoginKey,
        action: "failed",
        createdAt: { gte: since },
      },
    }),
    prisma.productUsageEvent.findMany({
      where: {
        featureKey: authLoginKey,
        action: "completed",
        userId: { not: null },
        createdAt: { gte: since },
      },
      distinct: ["userId"],
      select: { userId: true },
    }),
    prisma.productUsageEvent.findMany({
      where: {
        userId: { not: null },
        createdAt: { gte: since },
      },
      distinct: ["userId"],
      select: { userId: true },
    }),
    prisma.productUsageEvent.findMany({
      where: {
        businessId: { not: null },
        createdAt: { gte: since },
      },
      distinct: ["businessId"],
      select: {
        businessId: true,
        business: { select: { name: true } },
      },
    }),
    prisma.productUsageEvent.groupBy({
      by: ["featureKey", "action"],
      where: {
        createdAt: { gte: since },
        featureKey: { not: authLoginKey },
      },
      _count: { _all: true },
    }),
    prisma.user.findMany({
      where: {
        lastLoginAt: { not: null },
        business: { name: { not: PLATFORM_SYSTEM_BUSINESS_NAME } },
      },
      orderBy: { lastLoginAt: "desc" },
      take: 8,
      select: {
        id: true,
        email: true,
        lastLoginAt: true,
        loginCount: true,
        business: { select: { name: true } },
      },
    }),
  ]);

  const featureMap = new Map<
    string,
    { opened: number; completed: number; failed: number }
  >();

  for (const row of featureGroups) {
    const entry = featureMap.get(row.featureKey) ?? {
      opened: 0,
      completed: 0,
      failed: 0,
    };
    if (row.action === "opened") {
      entry.opened += row._count._all;
    } else if (row.action === "completed") {
      entry.completed += row._count._all;
    } else if (row.action === "failed") {
      entry.failed += row._count._all;
    }
    featureMap.set(row.featureKey, entry);
  }

  const featureRates = Array.from(featureMap.entries()).map(
    ([featureKey, counts]) => ({
      featureKey,
      ...counts,
      completionRate: rate(counts.completed, counts.opened),
      failureRate: rate(
        counts.failed,
        counts.opened + counts.completed + counts.failed
      ),
    })
  );

  const topFeatures = [...featureRates]
    .sort(
      (a, b) =>
        b.opened + b.completed - (a.opened + a.completed)
    )
    .slice(0, 10)
    .map(({ featureKey, opened, completed, failed }) => ({
      featureKey,
      opened,
      completed,
      failed,
    }));

  const frictionCandidates = featureRates
    .filter((row) => {
      if (row.opened < FRICTION_MIN_OPENED) return false;
      const completion = row.completionRate ?? 0;
      const highFailure =
        (row.failureRate ?? 0) >= 0.3 && row.failed >= 3;
      return completion < FRICTION_MAX_COMPLETION_RATE || highFailure;
    })
    .sort((a, b) => (a.completionRate ?? 1) - (b.completionRate ?? 1))
    .slice(0, 8)
    .map((row) => ({
      featureKey: row.featureKey,
      opened: row.opened,
      completed: row.completed,
      failed: row.failed,
      completionRate: row.completionRate ?? 0,
      reason:
        (row.failureRate ?? 0) >= 0.3 && row.failed >= 3
          ? "high_failure_rate"
          : "low_completion_rate",
    }));

  const lastLoginActivity = recentLogins
    .filter((row) => row.lastLoginAt)
    .map((row) => ({
      userId: row.id,
      email: row.email,
      businessName: row.business.name,
      lastLoginAt: row.lastLoginAt!.toISOString(),
      loginCount: row.loginCount,
    }));

  const totalFeatureEvents = featureRates.reduce(
    (sum, row) => sum + row.opened + row.completed + row.failed,
    0
  );
  const hasInsights =
    loginSuccessCount > 0 || totalFeatureEvents >= MIN_INSIGHTS_EVENTS;

  return {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    logins: {
      successCount: loginSuccessCount,
      failureCount: loginFailureCount,
      uniqueUsersSuccess: loginSuccessUsers.length,
    },
    activity: {
      activeUsers: activeUsers.length,
      activeBusinesses: activeBusinesses.filter(
        (row) => row.business?.name !== PLATFORM_SYSTEM_BUSINESS_NAME
      ).length,
    },
    topFeatures,
    featureRates,
    frictionCandidates,
    lastLoginActivity,
    hasInsights,
  };
}
