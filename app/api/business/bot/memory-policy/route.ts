import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { coerceMemoryPolicy, validateMemoryPolicy } from "@/lib/features/bot";

/**
 * Memory POLICY (Stage 7) — toggles only.
 *
 * Stores WHAT the bot would be allowed to remember in the future. Writes NO
 * actual customer memory, touches NO Customer record, holds no
 * cross-conversation data, and is NOT read by the planner/pipeline.
 *
 *   GET → policy (defaults when none)
 *   PUT → replace toggles (lazy-creates BusinessBot)
 */

const POLICY_SELECT = {
  newOrReturningCustomer: true,
  preferences: true,
  contactHistory: true,
  manualNotes: true,
  accumulatedInsights: true,
} as const;

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      select: { memoryPolicy: { select: POLICY_SELECT } },
    });

    return NextResponse.json({
      success: true,
      persisted: !!bot?.memoryPolicy,
      policy: coerceMemoryPolicy(bot?.memoryPolicy ?? null),
    });
  } catch (error) {
    console.error("BOT_MEMORY_POLICY_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = validateMemoryPolicy(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const data = { ...parsed.value, lastConfiguredAt: new Date() };

    const row = await prisma.$transaction(async (tx) => {
      const bot = await tx.businessBot.upsert({
        where: { businessId: user.businessId },
        update: {},
        create: { businessId: user.businessId },
        select: { id: true },
      });
      return tx.businessBotMemoryPolicy.upsert({
        where: { botId: bot.id },
        update: data,
        create: { botId: bot.id, ...data },
        select: POLICY_SELECT,
      });
    });

    return NextResponse.json({
      success: true,
      persisted: true,
      policy: coerceMemoryPolicy(row),
    });
  } catch (error) {
    console.error("BOT_MEMORY_POLICY_PUT_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
