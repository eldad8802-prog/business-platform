import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { analyzeMessage } from "@/lib/conversation-analysis/analyze-message";
import { generateReplySuggestions } from "@/lib/reply-suggestions/generate-reply-suggestions";
import { getContextMessages } from "@/lib/conversation-context/get-context-messages";
import { getSuggestionMode } from "@/lib/decision/get-suggestion-mode";
import { applyMessageEvent } from "@/lib/conversation-state/conversation-state.service";
import { getCurrentUser } from "@/lib/auth";
import { runBotPolicyEngine } from "@/lib/features/conversation/bot-policy";
import {
  isHumanTakeoverConversation,
  resolveBotWorkMode,
  shouldOfferAutoReplySuggestions,
  shouldOfferStarterBotDrafts,
} from "@/lib/features/conversation/bot-control";
import type {
  BotPolicyAnalysisSnapshot,
  BotPolicyConversationSnapshot,
  BotPolicyMessageSnapshot,
  BotPolicySettingsSnapshot,
} from "@/lib/features/conversation/bot-policy";
import {
  deriveStarterBotNextQuestionIndex,
  isStarterBotFlowCompletedSent,
  planStarterBotReply,
} from "@/lib/features/conversation/starter-bot";
import type { StarterBotSettingsSnapshot } from "@/lib/features/conversation/starter-bot";

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
      try {
        await applyMessageEvent({
          message: createdMessage,
          conversation,
          analysis: null,
        });
      } catch (error) {
        console.warn(
          "conversation-state writer (non-customer-inbound) failed:",
          error
        );
      }

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

    try {
      await applyMessageEvent({
        message,
        conversation,
        analysis,
      });
    } catch (error) {
      console.warn(
        "conversation-state writer (customer-inbound) failed:",
        error
      );
    }

    type BotSettingsObserveRow = {
      enabled: boolean;
      showDraftSuggestionsInInbox: boolean;
      mode: string;
      channel: string;
      welcomeMessage: string | null;
      questions: unknown;
      finalAction: string | null;
      finalActionPayload: unknown;
      handoffRules: unknown;
    };

    const humanTakeover = isHumanTakeoverConversation(conversation.outcomeReason);
    let botRow: BotSettingsObserveRow | null = null;

    try {
      try {
        botRow = await prisma.businessBotSettings.findUnique({
          where: { businessId: user.businessId },
          select: {
            enabled: true,
            showDraftSuggestionsInInbox: true,
            mode: true,
            channel: true,
            welcomeMessage: true,
            questions: true,
            finalAction: true,
            finalActionPayload: true,
            handoffRules: true,
          },
        });
      } catch (settingsErr) {
        console.warn("bot-settings observe-only load failed:", settingsErr);
      }

      const settingsSnapshot: BotPolicySettingsSnapshot = botRow
        ? {
            enabled: botRow.enabled,
            mode: botRow.mode,
            channel: botRow.channel,
          }
        : null;

      const messageSnapshot: BotPolicyMessageSnapshot = {
        direction: message.direction as BotPolicyMessageSnapshot["direction"],
        senderType: message.senderType as BotPolicyMessageSnapshot["senderType"],
        contentText: message.contentText,
      };
      const analysisSnapshot: BotPolicyAnalysisSnapshot = {
        intent: analysis.intent,
        stage: analysis.stage,
      };
      const conversationSnapshot: BotPolicyConversationSnapshot = {
        status: conversation.status,
        currentStage: conversation.currentStage,
      };

      let inboundMessageCount = 0;
      try {
        inboundMessageCount = await prisma.message.count({
          where: {
            conversationId: conversation.id,
            direction: "INBOUND",
            senderType: "CUSTOMER",
          },
        });
      } catch (countErr) {
        console.warn("inbound message count failed:", countErr);
      }

      const policy = runBotPolicyEngine({
        message: messageSnapshot,
        analysis: analysisSnapshot,
        conversation: conversationSnapshot,
        settings: settingsSnapshot,
        handoffRules: botRow?.handoffRules,
        inboundMessageCount,
        humanTakeover,
      });

      console.log("[bot-policy observe]", {
        conversationId: conversation.id,
        decision: policy.decision,
        reason: policy.reason,
        canAutoReply: policy.canAutoReply,
      });

      if (policy.decision === "HANDOFF_REQUIRED") {
        console.log("[starter-bot-lifecycle observe]", {
          conversationId: conversation.id,
          starterBotPolicyHandoff: true,
          policyReason: policy.reason,
          requiresHandoff: policy.requiresHandoff,
        });
      }

      if (policy.decision === "STARTER_BOT_ELIGIBLE" && botRow) {
        let starterBotFlowAlreadyCompleted = false;
        try {
          starterBotFlowAlreadyCompleted = await isStarterBotFlowCompletedSent({
            businessId: user.businessId,
            conversationId: conversation.id,
          });
        } catch (completedCheckErr) {
          console.warn(
            "starter-bot flow completion check failed:",
            completedCheckErr
          );
          starterBotFlowAlreadyCompleted = false;
        }

        if (starterBotFlowAlreadyCompleted) {
          console.log("[starter-bot-lifecycle observe]", {
            conversationId: conversation.id,
            starterBotFlowCompleted: true,
            skippedStarterBotDraft: true,
            reason: "terminal_bot_draft_already_sent",
          });
        } else {
          try {
            let derivedNextQuestionIndex = 0;
            try {
              derivedNextQuestionIndex = await deriveStarterBotNextQuestionIndex({
                businessId: user.businessId,
                conversationId: conversation.id,
              });
            } catch (deriveErr) {
              console.warn("derive starter-bot nextQuestionIndex failed:", deriveErr);
              derivedNextQuestionIndex = 0;
            }

            const plannerSettings: StarterBotSettingsSnapshot = {
              enabled: botRow.enabled,
              mode: botRow.mode,
              channel: botRow.channel,
              welcomeMessage: botRow.welcomeMessage,
              questions: botRow.questions,
              finalAction: botRow.finalAction,
              finalActionPayload: botRow.finalActionPayload,
              handoffRules: botRow.handoffRules,
            };

            const starterDraft = planStarterBotReply({
              settings: plannerSettings,
              conversation: {
                id: conversation.id,
                currentStage: conversation.currentStage,
              },
              analysis: {
                intent: analysis.intent,
                stage: analysis.stage,
              },
              nextQuestionIndex: derivedNextQuestionIndex,
            });

            const starterBotTerminalDraft =
              starterDraft.replyKind === "COMPLETE" ||
              starterDraft.replyKind === "HANDOFF";

            console.log("[starter-bot-planner observe]", {
              conversationId: conversation.id,
              derivedNextQuestionIndex,
              replyKind: starterDraft.replyKind,
              shouldDraftReply: starterDraft.shouldDraftReply,
              reason: starterDraft.reason,
              starterBotTerminalDraft,
            });

            const workMode = resolveBotWorkMode({
              enabled: botRow.enabled,
              showDraftSuggestionsInInbox: botRow.showDraftSuggestionsInInbox,
              handoffRules: botRow.handoffRules,
            });
            const offerStarterDrafts = shouldOfferStarterBotDrafts({
              workMode,
              humanTakeover,
              enabled: botRow.enabled,
              showDraftSuggestionsInInbox: botRow.showDraftSuggestionsInInbox,
            });

            if (
              offerStarterDrafts &&
              policy.decision === "STARTER_BOT_ELIGIBLE" &&
              starterDraft.shouldDraftReply === true &&
              starterDraft.replyText.trim().length > 0
            ) {
              try {
                const existingBotDraft = await prisma.replySuggestion.findFirst({
                  where: {
                    businessId: user.businessId,
                    conversationId: conversation.id,
                    messageId: message.id,
                    suggestionType: "STARTER_BOT_DRAFT",
                  },
                });

                if (!existingBotDraft) {
                  const variantType =
                    starterDraft.replyKind && starterDraft.replyKind.trim().length > 0
                      ? starterDraft.replyKind
                      : "BOT_DRAFT";

                  await prisma.replySuggestion.create({
                    data: {
                      businessId: user.businessId,
                      conversationId: conversation.id,
                      messageId: message.id,
                      suggestionType: "STARTER_BOT_DRAFT",
                      strategyType: "STARTER_BOT",
                      variantType,
                      variantIndex: 0,
                      text: starterDraft.replyText.trim(),
                      toneLabel: "bot",
                      strategyLabel: "Starter Bot",
                      status: "GENERATED",
                    },
                  });
                }
              } catch (botDraftSuggestionErr) {
                console.warn(
                  "starter-bot ReplySuggestion draft create failed:",
                  botDraftSuggestionErr
                );
              }
            }
        } catch (plannerObserveErr) {
          console.warn(
            "starter-bot-planner observe-only failed:",
            plannerObserveErr
          );
        }
        }
      }
    } catch (policyObserveErr) {
      console.warn("bot-policy observe-only failed:", policyObserveErr);
    }

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

    const workModeForSuggestions = botRow
      ? resolveBotWorkMode({
          enabled: botRow.enabled,
          showDraftSuggestionsInInbox: botRow.showDraftSuggestionsInInbox,
          handoffRules: botRow.handoffRules,
        })
      : ("MANUAL" as const);

    const offerAutoSuggestions = shouldOfferAutoReplySuggestions({
      workMode: workModeForSuggestions,
      humanTakeover,
    });

    const generatedSuggestions = offerAutoSuggestions
      ? await generateReplySuggestions(message, analysis, contextMessages)
      : [];

    let suggestions: any[] = [];
    let shouldGenerate = offerAutoSuggestions;

    if (!offerAutoSuggestions) {
      suggestions = [];
      shouldGenerate = false;
    } else if (mode === "FULL") {
      suggestions = generatedSuggestions;
    } else if (mode === "SOFT") {
      suggestions = generatedSuggestions.slice(0, 1);
    } else if (mode === "MINIMAL") {
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