import { prisma } from "@/lib/prisma";

type Plan = "FREE" | "PRO" | "PREMIUM";

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
  plan: Plan
) {
  const limits = getLimits(plan);
  const weekKey = getWeekKey();

  const usage = await prisma.Usage.findFirst({
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
  businessId: number
) {
  const weekKey = getWeekKey();

  const existing = await prisma.Usage.findFirst({
    where: {
      businessId,
      type: "video_generation",
      weekKey,
    },
  });

  if (!existing) {
    await prisma.Usage.create({
      data: {
        businessId,
        type: "video_generation",
        count: 1,
        weekKey,
      },
    });

    return;
  }

  await prisma.Usage.update({
    where: { id: existing.id },
    data: {
      count: existing.count + 1,
    },
  });
}