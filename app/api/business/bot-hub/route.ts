import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { isValidProductLinkUrl } from "@/lib/inbox-view/product-link-capability";
import {
  parseBotControlHandoffRules,
  resolveBotWorkMode,
} from "@/lib/features/conversation/bot-control";
import {
  coerceStoredProfile,
  computeBotAreaStates,
  hasApproachContent,
  hasPersonalityContent,
  hasVoiceContent,
} from "@/lib/features/bot";

/**
 * Hub read-model (Stage 1). Aggregates identity (BusinessBot) + descriptive
 * profile (BusinessBotProfile) + runtime status (read-only from
 * BusinessBotSettings) into one payload + a per-area state map.
 *
 * READ-ONLY across all three layers. Never writes runtime; never imported by
 * the response-planner or the conversation pipeline.
 */

function nonEmpty(value: string | null | undefined): boolean {
  return !!value && value.trim().length > 0;
}

function questionsCount(questions: unknown): number {
  if (!questions || typeof questions !== "object") return 0;
  const items = (questions as { items?: unknown }).items;
  if (!Array.isArray(items)) return 0;
  return items.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  ).length;
}

function parseWebsiteUrl(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = (payload as Record<string, unknown>).websiteUrl;
  return typeof raw === "string" ? raw.trim() : "";
}

function isHttpUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function finishOk(finalAction: string | null, payload: unknown): boolean {
  const action = finalAction ?? "";
  if (action === "SEND_LINK") return isHttpUrl(parseWebsiteUrl(payload));
  return action.length > 0;
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const [settings, bot] = await Promise.all([
      prisma.businessBotSettings.findUnique({
        where: { businessId: user.businessId },
        select: {
          enabled: true,
          welcomeMessage: true,
          questions: true,
          finalAction: true,
          finalActionPayload: true,
          showDraftSuggestionsInInbox: true,
          handoffRules: true,
          productLinkEnabled: true,
          productLinkUrl: true,
        },
      }),
      prisma.businessBot.findUnique({
        where: { businessId: user.businessId },
        include: { profile: true },
      }),
    ]);

    const identity = {
      displayName: bot?.displayName ?? null,
      avatar: bot?.avatar ?? null,
    };
    const profile = coerceStoredProfile(bot?.profile ?? null);

    const workMode = resolveBotWorkMode({
      enabled: settings?.enabled ?? false,
      showDraftSuggestionsInInbox: settings?.showDraftSuggestionsInInbox ?? false,
      handoffRules: parseBotControlHandoffRules(settings?.handoffRules),
    });

    const signals = {
      welcomeOk: nonEmpty(settings?.welcomeMessage),
      questionsCount: questionsCount(settings?.questions),
      finishOk: finishOk(
        settings?.finalAction ?? null,
        settings?.finalActionPayload
      ),
      productLinkOk:
        !!settings?.productLinkEnabled &&
        isValidProductLinkUrl((settings?.productLinkUrl ?? "").trim()),
      workModeManual: workMode === "MANUAL",
      identityNamed: nonEmpty(identity.displayName),
      voiceExtrasOk: hasVoiceContent(profile.voice),
      personalityOk: hasPersonalityContent(profile.personality),
      approachOk: hasApproachContent(profile.approach),
    };

    return NextResponse.json({
      success: true,
      identity,
      profile,
      runtime: {
        workMode,
        enabled: settings?.enabled ?? false,
        draftOnly: true,
      },
      signals,
      areaStates: computeBotAreaStates(signals),
    });
  } catch (error) {
    console.error("BUSINESS_BOT_HUB_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
