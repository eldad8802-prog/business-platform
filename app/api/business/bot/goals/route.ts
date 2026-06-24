import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { GOAL_CATALOG_VERSION, validateGoalSelection } from "@/lib/features/bot";

/**
 * Bot goal selection (Stage 2). Persists WHICH goals the business chose for its
 * bot, with provenance. Copy-with-provenance only — NO materialization, NO
 * activate, NO write to BusinessBotSettings, NOT read by the pipeline.
 *
 *   GET → selected goals (defaults to empty when no BusinessBot/selection)
 *   PUT → replace the selection (lazy-creates BusinessBot)
 */

type SelectionRow = { goalKey: string; goalVersion: number; selectedAt: Date };

function serialize(rows: SelectionRow[]) {
  return rows
    .slice()
    .sort((a, b) => a.selectedAt.getTime() - b.selectedAt.getTime())
    .map((r) => ({
      goalKey: r.goalKey,
      goalVersion: r.goalVersion,
      selectedAt: r.selectedAt.toISOString(),
    }));
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      select: { id: true },
    });
    if (!bot) {
      return NextResponse.json({ success: true, persisted: false, selected: [] });
    }

    const rows = await prisma.botGoalSelection.findMany({
      where: { botId: bot.id },
      select: { goalKey: true, goalVersion: true, selectedAt: true },
    });

    return NextResponse.json({
      success: true,
      persisted: true,
      selected: serialize(rows),
    });
  } catch (error) {
    console.error("BOT_GOALS_GET_ERROR:", error);
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

    const parsed = validateGoalSelection(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const desired = parsed.value;

    const rows = await prisma.$transaction(async (tx) => {
      const bot = await tx.businessBot.upsert({
        where: { businessId: user.businessId },
        update: {},
        create: { businessId: user.businessId },
        select: { id: true },
      });

      const existing = await tx.botGoalSelection.findMany({
        where: { botId: bot.id },
        select: { goalKey: true },
      });
      const existingKeys = new Set(existing.map((e) => e.goalKey));
      const desiredSet = new Set(desired);

      const toRemove = [...existingKeys].filter((k) => !desiredSet.has(k));
      const toAdd = desired.filter((k) => !existingKeys.has(k));

      if (toRemove.length > 0) {
        await tx.botGoalSelection.deleteMany({
          where: { botId: bot.id, goalKey: { in: toRemove } },
        });
      }
      if (toAdd.length > 0) {
        // New selections are stamped with the CURRENT catalog version + now.
        // Kept selections retain their original goalVersion/selectedAt (provenance).
        await tx.botGoalSelection.createMany({
          data: toAdd.map((goalKey) => ({
            botId: bot.id,
            goalKey,
            goalVersion: GOAL_CATALOG_VERSION,
          })),
        });
      }

      return tx.botGoalSelection.findMany({
        where: { botId: bot.id },
        select: { goalKey: true, goalVersion: true, selectedAt: true },
      });
    });

    return NextResponse.json({
      success: true,
      persisted: true,
      selected: serialize(rows),
    });
  } catch (error) {
    console.error("BOT_GOALS_PUT_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
