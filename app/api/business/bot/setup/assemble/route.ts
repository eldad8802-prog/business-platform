import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  assembleBase,
  coerceSelectedGoalKeys,
  validateGoalSelection,
} from "@/lib/features/bot";

/**
 * Assemble a proposed base from selected goals (Stage 3).
 *
 * Produces a FROZEN snapshot (copy-with-provenance) and stores it on the setup
 * draft. PROPOSES only — never writes BusinessBotSettings, never materializes,
 * never activates, NOT read by the pipeline.
 *
 * POST body: { goals?: string[] } — falls back to the draft's stored goals.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // If goals provided, validate strictly (unknown rejected). Otherwise use
    // whatever the draft already stored.
    let goals: string[] | null = null;
    if (
      body &&
      typeof body === "object" &&
      Object.prototype.hasOwnProperty.call(body, "goals")
    ) {
      const r = validateGoalSelection(body);
      if (!r.ok) {
        return NextResponse.json({ error: r.error }, { status: 400 });
      }
      goals = r.value;
    }

    const result = await prisma.$transaction(async (tx) => {
      const bot = await tx.businessBot.upsert({
        where: { businessId: user.businessId },
        update: {},
        create: { businessId: user.businessId },
        select: { id: true },
      });

      const existing = await tx.businessBotSetupDraft.findUnique({
        where: { botId: bot.id },
        select: { selectedGoalKeys: true },
      });

      const effectiveGoals =
        goals ?? coerceSelectedGoalKeys(existing?.selectedGoalKeys ?? null);

      const snapshot = assembleBase(effectiveGoals);

      const row = await tx.businessBotSetupDraft.upsert({
        where: { botId: bot.id },
        update: {
          selectedGoalKeys: effectiveGoals,
          assembledBase: snapshot as unknown as Prisma.InputJsonValue,
          assembledAt: new Date(snapshot.assembledAt),
          status: "REVIEW_READY",
        },
        create: {
          botId: bot.id,
          selectedGoalKeys: effectiveGoals,
          assembledBase: snapshot as unknown as Prisma.InputJsonValue,
          assembledAt: new Date(snapshot.assembledAt),
          status: "REVIEW_READY",
        },
        select: {
          status: true,
          currentStep: true,
          assembledAt: true,
        },
      });

      return { row, snapshot, effectiveGoals };
    });

    return NextResponse.json({
      success: true,
      persisted: true,
      draft: {
        status: result.row.status,
        currentStep: result.row.currentStep,
        selectedGoalKeys: result.effectiveGoals,
        assembledBase: result.snapshot,
        assembledAt: result.snapshot.assembledAt,
      },
    });
  } catch (error) {
    console.error("BOT_SETUP_ASSEMBLE_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
