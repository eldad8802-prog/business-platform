import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { analyzeMessage } from "@/lib/conversation-analysis/analyze-message";
import { generateReplySuggestions } from "@/lib/reply-suggestions/generate-reply-suggestions";
import { getContextMessages } from "@/lib/conversation-context/get-context-messages";
import { getSuggestionMode } from "@/lib/decision/get-suggestion-mode";
import { getCurrentUser } from "@/lib/auth";

type StageLabel = "early" | "middle" | "closing" | string | null | undefined;

const stageRank: Record<string, number> = {
  early: 1,
  middle: 2,
  closing: 3,
};

function getStageRank(stage: StageLabel): number {
  if (!stage) return 0;
  return stageRank[stage] ?? 0;
}

async function updateLatestSentSuggestionOutcome(params: {
  conversationId: number;
  currentMessageCreatedAt: Date;
  previousStage: StageLabel;
  currentStage: StageLabel;
}) {
  const {
    conversationId,
    currentMessageCreatedAt,
    previousStage,
    currentStage,
  } = params;

  const latestSentSuggestion = await prisma.replySuggestion.findFirst({
    where: {
      conversationId,
      status: "SENT",
      sentAt: {
        not: null,
        lte: currentMessageCreatedAt,
      },
    },
    orderBy: {
      sentAt: "desc",
    },
  });

  if (!latestSentSuggestion) {
    return null;
  }

  const dataToUpdate: {
    customerResponded?: boolean;
    customerRespondedAt?: Date;
    ledToStageAdvance?: boolean;
  } = {};

  if (!latestSentSuggestion.customerResponded) {
    dataToUpdate.customerResponded = true;
    dataToUpdate.customerRespondedAt = currentMessageCreatedAt;
  }

  const previousStageRank = getStageRank(previousStage);
  const currentStageRank = getStageRank(currentStage);

  if (
    !latestSentSuggestion.ledToStageAdvance &&
    previousStageRank > 0 &&
    currentStageRank > previousStageRank
  ) {
    dataToUpdate.ledToStageAdvance = true;
  }

  if (Object.keys(dataToUpdate).length === 0) {
    return latestSentSuggestion;
  }

  const updatedSuggestion = await prisma.replySuggestion.update({
    where: { id: latestSentSuggestion.id },
    data: dataToUpdate,
  });

  return updatedSuggestion;
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const conversationIdParam = searchParams.get("conversationId");

    if (!conversationIdParam) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      );
    }

    const conversationId = Number(conversationIdParam);

    if (!conversationId || Number.isNaN(conversationId)) {
      return NextResponse.json(
        { error: "Invalid conversationId" },
        { status: 400 }
      );
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        businessId: user.businessId,
      },
    });

    if (!conversation) {
      return NextResponse.json(
        {
          messages: [],
          suggestions: [],
        },
        { status: 200 }
      );
    }

    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    const lastInboundCustomerMessage = [...messages]
      .reverse()
      .find((m) => m.direction === "INBOUND" && m.senderType === "CUSTOMER");

    let suggestions: any[] = [];

    if (lastInboundCustomerMessage) {
      suggestions = await prisma.replySuggestion.findMany({
        where: {
          conversationId,
          messageId: lastInboundCustomerMessage.id,
        },
        orderBy: { createdAt: "desc" },
      });
    }

    return NextResponse.json(
      {
        messages: messages || [],
        suggestions: suggestions || [],
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("GET /api/message error:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch messages",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const conversationId = Number(body.conversationId);

    if (!conversationId || Number.isNaN(conversationId)) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      );
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        businessId: user.businessId,
      },
    });

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const direction = body.direction ?? "INBOUND";
    const senderType = body.senderType ?? "CUSTOMER";

    const createdMessage = await prisma.message.create({
      data: {
        conversationId,
        businessId: user.businessId,
        customerId: body.customerId ?? null,
        channel: body.channel ?? "WHATSAPP",
        messageType: body.messageType ?? "TEXT",
        direction,
        senderType,
        contentText: body.contentText ?? null,
        generatedFromSuggestionId: body.generatedFromSuggestionId ?? null,
      },
    });

    if (!(direction === "INBOUND" && senderType === "CUSTOMER")) {
      return NextResponse.json(
        {
          message: createdMessage,
          analysis: null,
          mode: null,
          shouldGenerate: false,
          suggestions: [],
          updatedOutcomeSuggestion: null,
        },
        { status: 201 }
      );
    }

    const contextMessages = await getContextMessages(createdMessage.conversationId, 5);

    const previousMessages = contextMessages.filter(
      (message) => message.id !== createdMessage.id
    );

    const analysis = analyzeMessage(body.contentText || "", previousMessages);

    await prisma.messageAnalysis.create({
      data: {
        messageId: createdMessage.id,
        intent: analysis.intent,
        stage: analysis.stage,
      },
    });

    const message = await prisma.message.update({
      where: { id: createdMessage.id },
      data: {
        intentLabel: analysis.intent,
        stageLabel: analysis.stage,
      },
    });

    const previousMessageWithStage = [...previousMessages]
      .reverse()
      .find((message) => message.stageLabel);

    const updatedOutcomeSuggestion = await updateLatestSentSuggestionOutcome({
      conversationId: createdMessage.conversationId,
      currentMessageCreatedAt: createdMessage.createdAt,
      previousStage: previousMessageWithStage?.stageLabel,
      currentStage: analysis.stage,
    });

    const mode = getSuggestionMode(
      analysis,
      message.contentText ?? body.contentText ?? ""
    );

    const generatedSuggestions = await generateReplySuggestions(
      message,
      analysis,
      contextMessages
    );

    let suggestions: any[] = [];
    let shouldGenerate = true;

    if (mode === "FULL") {
      suggestions = generatedSuggestions;
    }

    if (mode === "SOFT") {
      suggestions = generatedSuggestions.slice(0, 1);
    }

    if (mode === "MINIMAL") {
      suggestions = [];
      shouldGenerate = false;
    }

    return NextResponse.json(
      {
        message,
        analysis,
        mode,
        shouldGenerate,
        suggestions,
        updatedOutcomeSuggestion,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("POST /api/message error:", error);

    return NextResponse.json(
      {
        error: "Failed to create message",
        details: error?.message || String(error),
      },
      { status: 500 }
    );
  }
}