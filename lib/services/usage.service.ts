import { prisma } from "@/lib/prisma";
import type { TenantTx } from "@/lib/tenant/transaction";

type Plan = "FREE" | "PRO" | "PREMIUM";

/** D2/P7 Wave 2: bind to the tenant transaction when provided (RLS backstop). */
type TxOptions = { tx?: TenantTx };

function getLimits(plan: Plan) {
  if (plan === "FREE") {
    return { weeklyVideos: 2 };
  }

  if (plan === "PRO") {
    return { weeklyVideos: 8 };
  }

  return { weeklyVideos: 20 };
}

function getWeekKey() {
  const now = new Date();
  const year = now.getFullYear();
  const week = Math.ceil(
    ((now.getTime() - new Date(year, 0, 1).getTime()) / 86400000 + 1) / 7
  );

  return `${year}-W${week}`;
}

export async function checkUsage(
  businessId: number,
  plan: Plan,
  options?: TxOptions
) {
  const db = options?.tx ?? prisma;
  const limits = getLimits(plan);
  const weekKey = getWeekKey();

  const usage = await db.usage.findFirst({
    where: {
      businessId,
      type: "video_generation",
      weekKey,
    },
  });

  const current = usage?.count || 0;

  return {
    allowed: current < limits.weeklyVideos,
    remaining: limits.weeklyVideos - current,
    current,
    limit: limits.weeklyVideos,
  };
}

export async function incrementUsage(
  businessId: number,
  options?: TxOptions
) {
  const db = options?.tx ?? prisma;
  const weekKey = getWeekKey();

  const existing = await db.usage.findFirst({
    where: {
      businessId,
      type: "video_generation",
      weekKey,
    },
  });

  if (!existing) {
    await db.usage.create({
      data: {
        businessId,
        type: "video_generation",
        count: 1,
        weekKey,
      },
    });

    return;
  }

  await db.usage.update({
    where: { id: existing.id },
    data: {
      count: existing.count + 1,
    },
  });
}