import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { coerceKnowledge, validateKnowledge } from "@/lib/features/bot";

/**
 * Bot Knowledge (Stage 4) — advisory FAQ / hours / address / notes.
 *
 * ADVISORY only: NOT read by the response-planner or the pipeline, NOT
 * materialized into BusinessBotSettings. services/pricing + catalog link keep
 * their existing sources of truth — surfaced read-only via `bridges`, never
 * duplicated here.
 *
 *   GET → knowledge + read-only bridges (productLink, services count)
 *   PUT → replace the knowledge record (lazy-creates BusinessBot)
 */

const KNOWLEDGE_SELECT = {
  hours: true,
  address: true,
  notes: true,
  faq: true,
} satisfies Prisma.BusinessBotKnowledgeSelect;

async function loadBridges(businessId: number) {
  const [settings, servicesCount] = await Promise.all([
    prisma.businessBotSettings.findUnique({
      where: { businessId },
      select: { productLinkEnabled: true, productLinkUrl: true },
    }),
    prisma.businessService.count({ where: { businessId, active: true } }),
  ]);
  return {
    productLinkEnabled: !!settings?.productLinkEnabled,
    productLinkSet: !!(settings?.productLinkUrl ?? "").trim(),
    servicesCount,
  };
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const [bot, bridges] = await Promise.all([
      prisma.businessBot.findUnique({
        where: { businessId: user.businessId },
        select: { knowledge: { select: KNOWLEDGE_SELECT } },
      }),
      loadBridges(user.businessId),
    ]);

    const knowledge = coerceKnowledge(bot?.knowledge ?? null);
    return NextResponse.json({
      success: true,
      persisted: !!bot?.knowledge,
      knowledge,
      bridges,
    });
  } catch (error) {
    console.error("BOT_KNOWLEDGE_GET_ERROR:", error);
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

    const parsed = validateKnowledge(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const k = parsed.value;
    const data = {
      hours: k.hours,
      address: k.address,
      notes: k.notes,
      faq: k.faq as unknown as Prisma.InputJsonValue,
    };

    const row = await prisma.$transaction(async (tx) => {
      const bot = await tx.businessBot.upsert({
        where: { businessId: user.businessId },
        update: {},
        create: { businessId: user.businessId },
        select: { id: true },
      });
      return tx.businessBotKnowledge.upsert({
        where: { botId: bot.id },
        update: data,
        create: { botId: bot.id, ...data },
        select: KNOWLEDGE_SELECT,
      });
    });

    return NextResponse.json({
      success: true,
      persisted: true,
      knowledge: coerceKnowledge(row),
    });
  } catch (error) {
    console.error("BOT_KNOWLEDGE_PUT_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
