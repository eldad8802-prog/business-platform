import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { coerceSelectedGoalKeys, validateSetupPatch } from "@/lib/features/bot";

/**
 * Setup Wizard draft (Stage 3) — STAGING ONLY.
 *
 * Never writes BusinessBotSettings, never materializes, never activates, NOT
 * read by the response-planner or the conversation pipeline.
 *
 *   GET    → current draft (defaults when none)
 *   PATCH  → partial update (lazy-creates BusinessBot + draft)
 *   DELETE → reset (drop the draft)
 */

type DraftRow = {
  status: string;
  currentStep: number;
  selectedGoalKeys: Prisma.JsonValue | null;
  assembledBase: Prisma.JsonValue | null;
  assembledAt: Date | null;
};

function serialize(row: DraftRow) {
  return {
    status: row.status,
    currentStep: row.currentStep,
    selectedGoalKeys: coerceSelectedGoalKeys(row.selectedGoalKeys),
    assembledBase: row.assembledBase ?? null,
    assembledAt: row.assembledAt ? row.assembledAt.toISOString() : null,
  };
}

const DRAFT_SELECT = {
  status: true,
  currentStep: true,
  selectedGoalKeys: true,
  assembledBase: true,
  assembledAt: true,
} satisfies Prisma.BusinessBotSetupDraftSelect;

function defaultDraft() {
  return {
    status: "DRAFT",
    currentStep: 0,
    selectedGoalKeys: [] as string[],
    assembledBase: null,
    assembledAt: null,
  };
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
      return NextResponse.json({ success: true, persisted: false, draft: defaultDraft() });
    }
    const row = await prisma.businessBotSetupDraft.findUnique({
      where: { botId: bot.id },
      select: DRAFT_SELECT,
    });
    if (!row) {
      return NextResponse.json({ success: true, persisted: false, draft: defaultDraft() });
    }
    return NextResponse.json({ success: true, persisted: true, draft: serialize(row) });
  } catch (error) {
    console.error("BOT_SETUP_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = validateSetupPatch(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const patch = parsed.value;

    const update: Prisma.BusinessBotSetupDraftUpdateInput = {};
    const createExtra: Partial<Prisma.BusinessBotSetupDraftUncheckedCreateInput> = {};
    if (patch.selectedGoalKeys !== undefined) {
      update.selectedGoalKeys = patch.selectedGoalKeys;
      createExtra.selectedGoalKeys = patch.selectedGoalKeys;
    }
    if (patch.currentStep !== undefined) {
      update.currentStep = patch.currentStep;
      createExtra.currentStep = patch.currentStep;
    }
    if (patch.status !== undefined) {
      update.status = patch.status;
      createExtra.status = patch.status;
    }

    const row = await prisma.$transaction(async (tx) => {
      const bot = await tx.businessBot.upsert({
        where: { businessId: user.businessId },
        update: {},
        create: { businessId: user.businessId },
        select: { id: true },
      });
      return tx.businessBotSetupDraft.upsert({
        where: { botId: bot.id },
        update,
        create: { botId: bot.id, ...createExtra },
        select: DRAFT_SELECT,
      });
    });

    return NextResponse.json({ success: true, persisted: true, draft: serialize(row) });
  } catch (error) {
    console.error("BOT_SETUP_PATCH_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      select: { id: true },
    });
    if (bot) {
      await prisma.businessBotSetupDraft
        .delete({ where: { botId: bot.id } })
        .catch(() => undefined); // idempotent reset
    }
    return NextResponse.json({ success: true, persisted: false, draft: defaultDraft() });
  } catch (error) {
    console.error("BOT_SETUP_DELETE_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
