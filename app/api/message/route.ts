import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
// Value import (not `import type`): P2002 detection needs the runtime class.
import { Prisma } from "@prisma/client";
import { analyzeMessage } from "@/lib/conversation-analysis/analyze-message";
import { generateReplySuggestions } from "@/lib/reply-suggestions/generate-reply-suggestions";
import { getContextMessages } from "@/lib/conversation-context/get-context-messages";
import { getSuggestionMode } from "@/lib/decision/get-suggestion-mode";
import { applyMessageEvent } from "@/lib/conversation-state/conversation-state.service";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { sendWhatsAppTextForBusiness } from "@/lib/services/integrations/whatsapp/outbound-send.service";
import { evaluateBotGuardrails } from "@/lib/features/conversation/guardrails";
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
import {
  isBotComposeContextEnabled,
  isBotComposeGoalsApproachEnabled,
  isBotComposeKnowledgeEnabled,
  isBotComposeShadowEnabled,
  isBotVoiceComposeEnabled,
  loadBotComposeContext,
} from "@/lib/services/conversation/bot-compose-context.service";
import {
  defaultBotLlmDraftRunnerDeps,
  maybeCreateBotLlmDraft,
} from "@/lib/services/conversation/bot-llm-draft-runner.service";

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

async function updateLatestSentSuggestionOutcome(
  db: Prisma.TransactionClient | typeof prisma,
  params: {
    businessId: number;
    conversationId: number;
    currentMessageCreatedAt: Date;
    previousStage: StageLabel;
    currentStage: StageLabel;
  }
) {
  const {
    businessId,
    conversationId,
    currentMessageCreatedAt,
    previousStage,
    currentStage,
  } = params;

  const latestSentSuggestion = await db.replySuggestion.findFirst({
    where: {
      businessId,
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

  // Atomic tenant-scoped transition — no id-only mutation window.
  await db.replySuggestion.updateMany({
    where: { id: latestSentSuggestion.id, businessId },
    data: dataToUpdate,
  });
  return db.replySuggestion.findFirst({
    where: { id: latestSentSuggestion.id, businessId },
  });
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

    const { conversation, messages, suggestions } = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const conversation = await tx.conversation.findFirst({
            where: {
              id: conversationId,
              businessId: user.businessId,
            },
          });

          if (!conversation) {
            return { conversation: null, messages: [], suggestions: [] };
          }

          const messages = await tx.message.findMany({
            where: { conversationId, businessId: user.businessId },
            orderBy: { createdAt: "asc" },
          });

          const lastInboundCustomerMessage = [...messages]
            .reverse()
            .find(
              (m) => m.direction === "INBOUND" && m.senderType === "CUSTOMER"
            );

          let suggestions: any[] = [];

          if (lastInboundCustomerMessage) {
            suggestions = await tx.replySuggestion.findMany({
              where: {
                businessId: user.businessId,
                conversationId,
                messageId: lastInboundCustomerMessage.id,
              },
              orderBy: { createdAt: "desc" },
            });
          }
          return { conversation, messages, suggestions };
        })
    );

    if (!conversation) {
      return NextResponse.json(
        {
          messages: [],
          suggestions: [],
        },
        { status: 200 }
      );
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

    // D2/P7-W4B: the whole handler body runs under the session tenant context;
    // every DB group below is a SHORT tenant transaction, and the external
    // WhatsApp send / LLM work stays outside any transaction.
    return await runWithTenantContext({ businessId: user.businessId }, () =>
      handleAuthedPost(user, body, conversationId)
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

async function handleAuthedPost(
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
  body: any,
  conversationId: number
) {
  try {
    const conversation = await withTenantTransaction((tx) =>
      tx.conversation.findFirst({
        where: {
          id: conversationId,
          businessId: user.businessId,
        },
      })
    );

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const direction = body.direction ?? "INBOUND";
    const senderType = body.senderType ?? "CUSTOMER";

    // W2.5 send idempotency (opt-in).
    //
    // The state writer is replay-safe, but it cannot undo a DUPLICATE MESSAGE
    // ROW: two rows are two real messages, and the derived unanswered count
    // would then be correct about wrong data. This route had no guard at either
    // end, so a double-tap or a retry created a second message.
    //
    // When the caller supplies a token we let the unique index decide, and a
    // collision returns the message that already exists rather than a second
    // one. Callers that send no token behave exactly as before.
    const clientRequestId =
      typeof body.clientRequestId === "string" && body.clientRequestId.trim()
        ? body.clientRequestId.trim().slice(0, 100)
        : null;

    let createdMessage;
    try {
      createdMessage = await withTenantTransaction((tx) =>
        tx.message.create({
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
            clientRequestId,
          },
        })
      );
    } catch (error) {
      const isDuplicateSend =
        clientRequestId !== null &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!isDuplicateSend) throw error;

      const existing = await runWithTenantContext(
        { businessId: user.businessId },
        () =>
          withTenantTransaction((tx) =>
            tx.message.findFirst({
              where: { businessId: user.businessId, clientRequestId },
            })
          )
      );
      // Nothing further to do: the message exists and its state event already
      // ran on the first attempt.
      return NextResponse.json(
        { message: existing, duplicateSuppressed: true },
        { status: 200 }
      );
    }

    if (!(direction === "INBOUND" && senderType === "CUSTOMER")) {
      // ── WhatsApp outbound delivery (Stage 1: text only) ─────────────────
      // Only genuine business replies on the WhatsApp channel are delivered.
      // Non-WhatsApp / simulated messages keep their existing store-only
      // behavior. The message row is already persisted above; here we attempt
      // delivery and record the outcome on it.
      const channel = body.channel ?? "WHATSAPP";
      const isWhatsAppOutbound =
        channel === "WHATSAPP" && direction === "OUTBOUND" && senderType !== "CUSTOMER";

      let messageForResponse = createdMessage;
      let whatsappSend:
        | { status: "SENT" }
        | { status: "FAILED"; reason: string }
        | undefined;

      if (isWhatsAppOutbound) {
        let recipientPhone: string | null = null;
        if (conversation.customerId) {
          const customer = await withTenantTransaction((tx) =>
            tx.customer.findFirst({
              where: { id: conversation.customerId!, businessId: user.businessId },
              select: { phone: true },
            })
          );
          recipientPhone = customer?.phone ?? null;
        }

        const outcome = await sendWhatsAppTextForBusiness({
          businessId: user.businessId,
          toPhone: recipientPhone,
          text: body.contentText,
        });

        const now = new Date();
        if (outcome.ok) {
          messageForResponse = await withTenantTransaction(async (tx) => {
            await tx.message.updateMany({
              where: { id: createdMessage.id, businessId: user.businessId },
              data: {
                sendStatus: "SENT",
                providerMessageId: outcome.providerMessageId,
                sentAt: now,
                sendAttemptedAt: now,
              },
            });
            return tx.message.findFirstOrThrow({
              where: { id: createdMessage.id, businessId: user.businessId },
            });
          });
          whatsappSend = { status: "SENT" };
        } else {
          messageForResponse = await withTenantTransaction(async (tx) => {
            await tx.message.updateMany({
              where: { id: createdMessage.id, businessId: user.businessId },
              data: {
                sendStatus: "FAILED",
                sendAttemptedAt: now,
                sendErrorCode: outcome.code.slice(0, 64),
                sendErrorMessage: outcome.message.slice(0, 500),
              },
            });
            return tx.message.findFirstOrThrow({
              where: { id: createdMessage.id, businessId: user.businessId },
            });
          });
          whatsappSend = { status: "FAILED", reason: outcome.reason };
        }
      }

      try {
        await withTenantTransaction((tx) =>
          applyMessageEvent(
            {
              message: messageForResponse,
              conversation,
              analysis: null,
            },
            { tx }
          )
        );
      } catch (error) {
        console.warn(
          "conversation-state writer (non-customer-inbound) failed:",
          error
        );
      }

      return NextResponse.json(
        {
          message: messageForResponse,
          analysis: null,
          mode: null,
          shouldGenerate: false,
          suggestions: [],
          updatedOutcomeSuggestion: null,
          whatsappSend,
        },
        { status: 201 }
      );
    }

    const contextMessages = await withTenantTransaction((tx) =>
      getContextMessages(createdMessage.conversationId, 5, { tx })
    );

    const previousMessages = contextMessages.filter(
      (message) => message.id !== createdMessage.id
    );

    const analysis = analyzeMessage(body.contentText || "", previousMessages);

    const message = await withTenantTransaction(async (tx) => {
      await tx.messageAnalysis.create({
        data: {
          messageId: createdMessage.id,
          intent: analysis.intent,
          stage: analysis.stage,
        },
      });

      await tx.message.updateMany({
        where: { id: createdMessage.id, businessId: user.businessId },
        data: {
          intentLabel: analysis.intent,
          stageLabel: analysis.stage,
        },
      });
      return tx.message.findFirstOrThrow({
        where: { id: createdMessage.id, businessId: user.businessId },
      });
    });

    try {
      await withTenantTransaction((tx) =>
        applyMessageEvent(
          {
            message,
            conversation,
            analysis,
          },
          { tx }
        )
      );
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
    // Canonical Guardrails handoff flag — lifted to the handler scope so the AUTO
    // suggestions gate (further down, outside the policy try) reads the SAME
    // decision the STARTER path uses. Default false → if the policy block never
    // runs, AUTO behaviour is unchanged.
    let botRequiresHandoff = false;

    try {
      try {
        botRow = await withTenantTransaction((tx) =>
          tx.businessBotSettings.findUnique({
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
          })
        );
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
        inboundMessageCount = await withTenantTransaction((tx) =>
          tx.message.count({
            where: {
              conversationId: conversation.id,
              direction: "INBOUND",
              senderType: "CUSTOMER",
            },
          })
        );
      } catch (countErr) {
        console.warn("inbound message count failed:", countErr);
      }

      const policy = evaluateBotGuardrails({
        message: messageSnapshot,
        analysis: analysisSnapshot,
        conversation: conversationSnapshot,
        settings: settingsSnapshot,
        handoffRules: botRow?.handoffRules,
        inboundMessageCount,
        humanTakeover,
        // Context-aware forbidden check: recent messages so a short reply that
        // continues a forbidden thread ("כן" after a price question) is caught.
        context: {
          recentMessages: previousMessages.map((m) => ({
            direction: m.direction as "INBOUND" | "OUTBOUND",
            contentText: m.contentText,
            createdAt: m.createdAt,
          })),
        },
      });
      botRequiresHandoff = policy.requiresHandoff;

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
          starterBotFlowAlreadyCompleted = await withTenantTransaction((tx) =>
            isStarterBotFlowCompletedSent(
              {
                businessId: user.businessId,
                conversationId: conversation.id,
              },
              { tx }
            )
          );
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
              derivedNextQuestionIndex = await withTenantTransaction((tx) =>
                deriveStarterBotNextQuestionIndex(
                  {
                    businessId: user.businessId,
                    conversationId: conversation.id,
                  },
                  { tx }
                )
              );
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

            const plannerInput = {
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
            };

            // Stage 9 (flag-gated, default OFF → byte-identical to before):
            // mirror of the shared inbound pipeline so BOTH inbound paths honour
            // the Builder compose-context (voice 9B / knowledge 9C / goals 9D)
            // identically once armed. With all flags OFF the draft is unchanged.
            // Never touches the draft-only gate, send path, or any settings.
            let starterDraft = planStarterBotReply(plannerInput);
            if (isBotComposeContextEnabled()) {
              try {
                const voiceArmed = isBotVoiceComposeEnabled();
                const knowledgeArmed = isBotComposeKnowledgeEnabled();
                const goalsApproachArmed = isBotComposeGoalsApproachEnabled();
                const composeContext = await loadBotComposeContext(
                  user.businessId,
                  {
                    includeVoice: voiceArmed,
                    includeKnowledge: knowledgeArmed,
                    includeGoalsApproach: goalsApproachArmed,
                  }
                );
                if (
                  composeContext &&
                  (voiceArmed || knowledgeArmed || goalsApproachArmed)
                ) {
                  const contextForPlanner = {
                    ...composeContext,
                    customerMessageText: message.contentText ?? undefined,
                  };
                  const newDraft = planStarterBotReply(
                    plannerInput,
                    contextForPlanner
                  );
                  if (isBotComposeShadowEnabled()) {
                    // Dev-safe shadow log (no message text / PII) — observe only.
                    console.info("[message-route] compose-shadow", {
                      conversationId: conversation.id,
                      businessId: user.businessId,
                      changed: newDraft.replyText !== starterDraft.replyText,
                      oldLength: starterDraft.replyText.length,
                      newLength: newDraft.replyText.length,
                    });
                  } else {
                    starterDraft = newDraft;
                  }
                }
              } catch (composeErr) {
                console.warn(
                  "[message-route] compose-context failed (ignored):",
                  composeErr
                );
              }
            }

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
                await withTenantTransaction(async (tx) => {
                  const existingBotDraft = await tx.replySuggestion.findFirst({
                    where: {
                      businessId: user.businessId,
                      conversationId: conversation.id,
                      messageId: message.id,
                      suggestionType: "STARTER_BOT_DRAFT",
                    },
                  });

                  if (!existingBotDraft) {
                    const variantType =
                      starterDraft.replyKind &&
                      starterDraft.replyKind.trim().length > 0
                        ? starterDraft.replyKind
                        : "BOT_DRAFT";

                    await tx.replySuggestion.create({
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
                });
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

    const updatedOutcomeSuggestion = await withTenantTransaction((tx) =>
      updateLatestSentSuggestionOutcome(tx, {
        businessId: user.businessId,
        conversationId: createdMessage.conversationId,
        currentMessageCreatedAt: createdMessage.createdAt,
        previousStage: previousMessageWithStage?.stageLabel,
        currentStage: analysis.stage,
      })
    );

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

    // AUTO suggestions must also pass the canonical Guardrails: when the bot must
    // hand off to the owner, NO engine (STARTER or AUTO) drafts a reply.
    const offerAutoSuggestions =
      shouldOfferAutoReplySuggestions({
        workMode: workModeForSuggestions,
        humanTakeover,
      }) && !botRequiresHandoff;

    const generatedSuggestions = offerAutoSuggestions
      ? await withTenantTransaction((tx) =>
          generateReplySuggestions(message, analysis, contextMessages, { tx })
        )
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

    // Stage 4 (flag-gated, DEFAULT OFF → byte-identical): first LLM reply DRAFT
    // via the SHARED runner — identical to the WhatsApp webhook pipeline path.
    // Draft-only, never sent; pre + post Guardrails inside the runner.
    const llmDraftOutcome = await maybeCreateBotLlmDraft(
      {
        businessId: user.businessId,
        conversationId: conversation.id,
        messageId: message.id,
        offerAutoSuggestions,
        humanTakeover,
        botRow,
        message: {
          direction: message.direction,
          senderType: message.senderType,
          contentText: message.contentText,
        },
        analysis: { intent: analysis.intent, stage: analysis.stage },
        conversation: {
          status: conversation.status,
          currentStage: conversation.currentStage,
        },
        recentMessages: previousMessages.map((m) => ({
          direction: m.direction as "INBOUND" | "OUTBOUND",
          contentText: m.contentText,
          createdAt: m.createdAt,
        })),
      },
      defaultBotLlmDraftRunnerDeps()
    );
    if (llmDraftOutcome.status !== "skipped") {
      console.info("[message-route] LLM_DRAFT_OUTCOME", {
        conversationId: conversation.id,
        businessId: user.businessId,
        ...llmDraftOutcome,
      });
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