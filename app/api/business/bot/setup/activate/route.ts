import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  coerceSelectedGoalKeys,
  materializeSettingsFromBase,
  validateAssembledBase,
} from "@/lib/features/bot";

/**
 * Activate (Stage 5) — CONTROLLED, MINIMAL materialization.
 *
 * Copies the FROZEN `assembledBase` snapshot into ONLY the existing
 * BusinessBotSettings fields the planner already reads:
 *   - welcomeMessage
 *   - questions (legacy `{ items }`)
 *   - finalAction (a value valid for the existing contract)
 *
 * It does NOT touch mode / workMode / handoffRules / enabled /
 * showDraftSuggestionsInInbox, does NOT go through the bot-settings route, does
 * NOT change the planner or pipeline, and adds no new reader. Turning the bot
 * ON stays a separate, explicit step (the work-mode screen). Provenance
 * (activatedAt / activationMeta) is stored on the setup draft — off the planner
 * path. ACTIVATED is terminal: a second activate is safely blocked (status is
 * no longer REVIEW_READY).
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      select: { id: true },
    });
    const draft = bot
      ? await prisma.businessBotSetupDraft.findUnique({
          where: { botId: bot.id },
          select: {
            id: true,
            status: true,
            assembledBase: true,
            selectedGoalKeys: true,
          },
        })
      : null;

    if (!bot || !draft) {
      return NextResponse.json(
        { error: "No setup draft to activate", code: "SETUP_NO_DRAFT" },
        { status: 404 }
      );
    }
    if (draft.status !== "REVIEW_READY") {
      return NextResponse.json(
        {
          error:
            draft.status === "ACTIVATED"
              ? "Setup is already activated"
              : "Setup must be REVIEW_READY before activation",
          code: "SETUP_NOT_REVIEW_READY",
        },
        { status: 400 }
      );
    }

    const base = validateAssembledBase(draft.assembledBase);
    if (!base) {
      return NextResponse.json(
        { error: "Assembled base is missing or malformed", code: "SETUP_BAD_BASE" },
        { status: 400 }
      );
    }

    const mat = materializeSettingsFromBase(base);
    const sources = base.sources;

    await prisma.$transaction(async (tx) => {
      // Controlled write — ONLY the allowed fields. Create defaults stay OFF
      // (enabled:false, mode:STARTER, channel:WHATSAPP) — activation never
      // flips the bot on.
      await tx.businessBotSettings.upsert({
        where: { businessId: user.businessId },
        update: {
          welcomeMessage: mat.welcomeMessage,
          questions: mat.questions as unknown as Prisma.InputJsonValue,
          finalAction: mat.finalAction,
        },
        create: {
          businessId: user.businessId,
          mode: "STARTER",
          channel: "WHATSAPP",
          welcomeMessage: mat.welcomeMessage,
          questions: mat.questions as unknown as Prisma.InputJsonValue,
          finalAction: mat.finalAction,
        },
      });

      await tx.businessBotSetupDraft.update({
        where: { id: draft.id },
        data: {
          status: "ACTIVATED",
          activatedAt: new Date(),
          activationMeta: {
            activatedFromSetupDraftId: draft.id,
            sources,
            selectedGoalKeys: coerceSelectedGoalKeys(draft.selectedGoalKeys),
            applied: {
              welcomeMessage: true,
              questions: mat.questions.items.length,
              finalAction: true,
              handoffRules: false,
            },
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return NextResponse.json({
      success: true,
      activated: true,
      applied: {
        welcomeMessage: true,
        questions: mat.questions.items.length,
        finalAction: true,
        handoffRules: false,
      },
    });
  } catch (error) {
    console.error("BOT_SETUP_ACTIVATE_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
