import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  coerceStoredProfile,
  validateBotPatch,
  type BotIdentity,
  type BotProfileConfig,
} from "@/lib/features/bot";

/**
 * Bot Builder root identity + descriptive profile (Stage 1).
 *
 * NEW endpoint — does NOT touch `/api/business/bot-settings`, the runtime
 * config, the response-planner, or the conversation pipeline. Reconciled with
 * `BusinessBotSettings` by `businessId` only.
 *
 *   GET   → identity + profile (defaults when no BusinessBot row exists)
 *   PATCH → partial upsert (lazy-create BusinessBot, then BusinessBotProfile)
 */

const PROFILE_BLOCK_KEYS = ["voice", "personality", "approach"] as const;

function defaultIdentity(): BotIdentity {
  return { displayName: null, avatar: null };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const bot = await prisma.businessBot.findUnique({
      where: { businessId: user.businessId },
      include: { profile: true },
    });

    if (!bot) {
      return NextResponse.json({
        success: true,
        persisted: false,
        identity: defaultIdentity(),
        profile: {} as BotProfileConfig,
      });
    }

    return NextResponse.json({
      success: true,
      persisted: true,
      identity: { displayName: bot.displayName, avatar: bot.avatar },
      profile: coerceStoredProfile(bot.profile),
    });
  } catch (error) {
    console.error("BUSINESS_BOT_GET_ERROR:", error);
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

    const parsed = validateBotPatch(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const patch = parsed.value;

    // Identity (BusinessBot) — only provided keys.
    const identityUpdate: Prisma.BusinessBotUpdateInput = {};
    if (patch.displayName !== undefined) identityUpdate.displayName = patch.displayName;
    if (patch.avatar !== undefined) identityUpdate.avatar = patch.avatar;

    // Profile columns — write only blocks PRESENT in the raw body; an empty
    // block clears that column (JsonNull) so a screen can reset itself.
    const rawProfile = isPlainObject(body) ? body.profile : undefined;
    const profileData: Record<string, Prisma.InputJsonValue | typeof Prisma.JsonNull> = {};
    if (isPlainObject(rawProfile)) {
      for (const key of PROFILE_BLOCK_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(rawProfile, key)) continue;
        const block = patch.profile?.[key];
        profileData[key] =
          block && Object.keys(block).length > 0
            ? (block as Prisma.InputJsonValue)
            : Prisma.JsonNull;
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const bot = await tx.businessBot.upsert({
        where: { businessId: user.businessId },
        update: identityUpdate,
        create: {
          businessId: user.businessId,
          displayName: patch.displayName ?? null,
          avatar: patch.avatar ?? null,
        },
      });

      let profileRow = await tx.businessBotProfile.findUnique({
        where: { botId: bot.id },
      });

      if (Object.keys(profileData).length > 0) {
        profileRow = await tx.businessBotProfile.upsert({
          where: { botId: bot.id },
          update: profileData,
          create: { botId: bot.id, ...profileData },
        });
      }

      return { bot, profileRow };
    });

    return NextResponse.json({
      success: true,
      persisted: true,
      identity: {
        displayName: result.bot.displayName,
        avatar: result.bot.avatar,
      },
      profile: coerceStoredProfile(result.profileRow),
    });
  } catch (error) {
    console.error("BUSINESS_BOT_PATCH_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
