/**
 * Shared inbound-message pipeline — single source of truth.
 *
 * Both callers run THIS function:
 *   - `POST /api/message` (the manual / test path the inbox uses today)
 *   - `processWhatsAppConversationIntake` (the new webhook intake path)
 *
 * Discipline contract: there is exactly one orchestration path for what
 * happens after a customer-inbound `Message` is persisted. Any caller that
 * persists an INBOUND CUSTOMER message MUST call `runInboundMessagePipeline`
 * to maintain analysis / state / bot-policy / suggestion parity.
 *
 * Responsibilities (in order):
 *   1. Pull short context window from prior messages.
 *   2. Run deterministic NLU `analyzeMessage` (intent + stage).
 *   3. Persist `MessageAnalysis` row + write back intent/stage on the
 *      Message.
 *   4. Apply the message event to the conversation state machine
 *      (`applyMessageEvent`).
 *   5. Observe bot settings + human takeover + handoff rules + boundary
 *      hits via `runBotPolicyEngine`.
 *   6. When policy is eligible, plan + persist a Starter-Bot
 *      `ReplySuggestion` row (`STARTER_BOT_DRAFT`).
 *   7. Update the latest previously-SENT suggestion's outcome
 *      (customerResponded, ledToStageAdvance).
 *   8. Compute the suggestion mode + generate auto-suggestions when the
 *      work mode allows, returning the mode-filtered surface for the
 *      HTTP response.
 *
 * Side-effect-free for callers: this function reads + writes DB rows but
 * never returns anything sensitive (no tokens, no full message text).
 */

import type { Conversation, Message } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { analyzeMessage } from "@/lib/conversation-analysis/analyze-message";
import { generateReplySuggestions } from "@/lib/reply-suggestions/generate-reply-suggestions";
import { getContextMessages } from "@/lib/conversation-context/get-context-messages";
import { getSuggestionMode } from "@/lib/decision/get-suggestion-mode";
import { applyMessageEvent } from "@/lib/conversation-state/conversation-state.service";
import {
  runBotPolicyEngine,
  type BotPolicyAnalysisSnapshot,
  type BotPolicyConversationSnapshot,
  type BotPolicyEngineResult,
  type BotPolicyMessageSnapshot,
  type BotPolicySettingsSnapshot,
} from "@/lib/features/conversation/bot-policy";
import {
  isHumanTakeoverConversation,
  resolveBotWorkMode,
  shouldOfferAutoReplySuggestions,
  shouldOfferStarterBotDrafts,
} from "@/lib/features/conversation/bot-control";
import {
  deriveStarterBotNextQuestionIndex,
  isStarterBotFlowCompletedSent,
  planStarterBotReply,
  type StarterBotSettingsSnapshot,
} from "@/lib/features/conversation/starter-bot";
import {
  isBotComposeContextEnabled,
  isBotComposeGoalsApproachEnabled,
  isBotComposeKnowledgeEnabled,
  isBotComposeShadowEnabled,
  isBotVoiceComposeEnabled,
  loadBotComposeContext,
} from "@/lib/services/conversation/bot-compose-context.service";
import {
  logEvent,
  type WhatsAppPipelineEvent,
} from "@/lib/services/integrations/whatsapp/webhook-events";

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

// ─── Caller-visible types ──────────────────────────────────────────────────

export type InboundPipelineSource = "webhook" | "http";

export type InboundPipelineParams = {
  /** Conversation the inbound message belongs to. */
  conversation: Conversation;
  /**
   * The already-persisted INBOUND CUSTOMER message. Callers persist this
   * themselves before invoking the pipeline because the persistence shape
   * differs (e.g. providerMessageId / wamid only set by the webhook path).
   */
  message: Message;
  /** Always equal to `conversation.businessId`, passed for log clarity. */
  businessId: number;
  /** Where this call originated — used in structured logs only. */
  source: InboundPipelineSource;
};

export type InboundPipelineResult = {
  analysis: { intent: string; stage: string };
  /** Mode used to filter the auto-suggestions surfaced to the HTTP caller. */
  mode: ReturnType<typeof getSuggestionMode>;
  shouldGenerate: boolean;
  /** Mode-filtered suggestions — already-persisted by `generateReplySuggestions`. */
  suggestions: unknown[];
  /** Outcome update for the previously-SENT suggestion, if any. */
  updatedOutcomeSuggestion: unknown | null;
  /** True when a STARTER_BOT_DRAFT ReplySuggestion row was created. */
  starterBotDraftCreated: boolean;
  /** Bot policy engine decision, surfaced for log clarity. */
  policyDecision: BotPolicyEngineResult["decision"];
};

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

// ─── Sub-step helpers (kept in this file so the orchestration stays in
//     one place — these are not exported) ──────────────────────────────────

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
      sentAt: { not: null, lte: currentMessageCreatedAt },
    },
    orderBy: { sentAt: "desc" },
  });

  if (!latestSentSuggestion) return null;

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

  return prisma.replySuggestion.update({
    where: { id: latestSentSuggestion.id },
    data: dataToUpdate,
  });
}

function emit(
  source: InboundPipelineSource,
  event: WhatsAppPipelineEvent,
  fields: Record<string, unknown>
) {
  logEvent(event, { source, ...fields });
}

// ─── Pipeline entry point ──────────────────────────────────────────────────

export async function runInboundMessagePipeline(
  params: InboundPipelineParams
): Promise<InboundPipelineResult> {
  const { conversation, message, businessId, source } = params;

  // 1. Context window from prior messages (excluding the message we just
  //    persisted).
  const contextMessages = await getContextMessages(message.conversationId, 5);
  const previousMessages = contextMessages.filter((m) => m.id !== message.id);

  // 2. Pure NLU.
  const analysis = analyzeMessage(message.contentText ?? "", previousMessages);

  // 3. Persist MessageAnalysis + write back labels on the Message itself.
  await prisma.messageAnalysis.create({
    data: {
      messageId: message.id,
      intent: analysis.intent,
      stage: analysis.stage,
    },
  });

  const labelledMessage = await prisma.message.update({
    where: { id: message.id },
    data: {
      intentLabel: analysis.intent,
      stageLabel: analysis.stage,
    },
  });

  emit(source, "MESSAGE_ANALYZED", {
    conversationId: conversation.id,
    businessId,
    messageId: message.id,
    intent: analysis.intent,
    stage: analysis.stage,
  });

  // 4. Conversation state machine.
  try {
    await applyMessageEvent({
      message: labelledMessage,
      conversation,
      analysis,
    });
  } catch (error) {
    console.warn(
      "[inbound-pipeline] conversation-state writer failed:",
      error
    );
  }

  // 5. Bot policy + 6. starter bot.
  const humanTakeover = isHumanTakeoverConversation(conversation.outcomeReason);
  let botRow: BotSettingsObserveRow | null = null;
  let starterBotDraftCreated = false;
  let policyDecision: BotPolicyEngineResult["decision"] = "ALLOW_SUGGESTIONS_ONLY";

  try {
    try {
      botRow = await prisma.businessBotSettings.findUnique({
        where: { businessId },
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
      console.warn(
        "[inbound-pipeline] bot-settings load failed:",
        settingsErr
      );
    }

    const settingsSnapshot: BotPolicySettingsSnapshot = botRow
      ? {
          enabled: botRow.enabled,
          mode: botRow.mode,
          channel: botRow.channel,
        }
      : null;

    const messageSnapshot: BotPolicyMessageSnapshot = {
      direction: labelledMessage.direction as BotPolicyMessageSnapshot["direction"],
      senderType:
        labelledMessage.senderType as BotPolicyMessageSnapshot["senderType"],
      contentText: labelledMessage.contentText,
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
      console.warn(
        "[inbound-pipeline] inbound message count failed:",
        countErr
      );
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
    policyDecision = policy.decision;

    emit(source, "BOT_POLICY_DECISION", {
      conversationId: conversation.id,
      businessId,
      decision: policy.decision,
      reason: policy.reason,
      canAutoReply: policy.canAutoReply,
      requiresHandoff: policy.requiresHandoff,
    });

    if (policy.decision === "STARTER_BOT_ELIGIBLE" && botRow) {
      let starterBotFlowAlreadyCompleted = false;
      try {
        starterBotFlowAlreadyCompleted = await isStarterBotFlowCompletedSent({
          businessId,
          conversationId: conversation.id,
        });
      } catch (completedCheckErr) {
        console.warn(
          "[inbound-pipeline] starter-bot flow completion check failed:",
          completedCheckErr
        );
        starterBotFlowAlreadyCompleted = false;
      }

      if (!starterBotFlowAlreadyCompleted) {
        try {
          let derivedNextQuestionIndex = 0;
          try {
            derivedNextQuestionIndex = await deriveStarterBotNextQuestionIndex({
              businessId,
              conversationId: conversation.id,
            });
          } catch (deriveErr) {
            console.warn(
              "[inbound-pipeline] derive starter-bot nextQuestionIndex failed:",
              deriveErr
            );
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

          // Stage 9 (flag-gated, default OFF → byte-identical to before): build a
          // read-only compose context with ONLY the armed capabilities
          // (voice 9B / knowledge 9C). Capabilities are applied unless SHADOW is
          // on, in which case the new draft is computed for observation only and
          // the baseline draft is returned. Any failure falls back to baseline.
          // Does NOT touch the draft-only gate, send path, or any settings.
          let starterDraft = planStarterBotReply(plannerInput);
          if (isBotComposeContextEnabled()) {
            try {
              const voiceArmed = isBotVoiceComposeEnabled();
              const knowledgeArmed = isBotComposeKnowledgeEnabled();
              const goalsApproachArmed = isBotComposeGoalsApproachEnabled();
              const composeContext = await loadBotComposeContext(businessId, {
                includeVoice: voiceArmed,
                includeKnowledge: knowledgeArmed,
                includeGoalsApproach: goalsApproachArmed,
              });
              if (composeContext && (voiceArmed || knowledgeArmed || goalsApproachArmed)) {
                const contextForPlanner = {
                  ...composeContext,
                  customerMessageText: labelledMessage.contentText ?? undefined,
                };
                const newDraft = planStarterBotReply(plannerInput, contextForPlanner);
                if (isBotComposeShadowEnabled()) {
                  // Dev-safe shadow log (no message text / PII) — observe only.
                  console.info("[inbound-pipeline] compose-shadow", {
                    conversationId: conversation.id,
                    businessId,
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
                "[inbound-pipeline] compose-context failed (ignored):",
                composeErr
              );
            }
          }

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
            starterDraft.shouldDraftReply === true &&
            starterDraft.replyText.trim().length > 0
          ) {
            try {
              const existingBotDraft = await prisma.replySuggestion.findFirst({
                where: {
                  businessId,
                  conversationId: conversation.id,
                  messageId: labelledMessage.id,
                  suggestionType: "STARTER_BOT_DRAFT",
                },
              });

              if (!existingBotDraft) {
                const variantType =
                  starterDraft.replyKind &&
                  starterDraft.replyKind.trim().length > 0
                    ? starterDraft.replyKind
                    : "BOT_DRAFT";

                await prisma.replySuggestion.create({
                  data: {
                    businessId,
                    conversationId: conversation.id,
                    messageId: labelledMessage.id,
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
                starterBotDraftCreated = true;
                emit(source, "STARTER_BOT_DRAFT_CREATED", {
                  conversationId: conversation.id,
                  businessId,
                  messageId: labelledMessage.id,
                  replyKind: starterDraft.replyKind,
                  nextQuestionIndex: derivedNextQuestionIndex,
                });
              }
            } catch (botDraftSuggestionErr) {
              console.warn(
                "[inbound-pipeline] starter-bot ReplySuggestion create failed:",
                botDraftSuggestionErr
              );
            }
          }
        } catch (plannerErr) {
          console.warn(
            "[inbound-pipeline] starter-bot planner failed:",
            plannerErr
          );
        }
      }
    }
  } catch (policyErr) {
    console.warn("[inbound-pipeline] bot-policy block failed:", policyErr);
  }

  // 7. Update latest-sent suggestion outcome.
  const previousMessageWithStage = [...previousMessages]
    .reverse()
    .find((m) => m.stageLabel);

  const updatedOutcomeSuggestion = await updateLatestSentSuggestionOutcome({
    conversationId: message.conversationId,
    currentMessageCreatedAt: message.createdAt,
    previousStage: previousMessageWithStage?.stageLabel,
    currentStage: analysis.stage,
  });

  // 8. Auto-suggestions (LLM) + mode filter.
  const mode = getSuggestionMode(analysis, labelledMessage.contentText ?? "");

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
    ? await generateReplySuggestions(labelledMessage, analysis, contextMessages)
    : [];

  let suggestions: unknown[] = [];
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

  return {
    analysis,
    mode,
    shouldGenerate,
    suggestions,
    updatedOutcomeSuggestion,
    starterBotDraftCreated,
    policyDecision,
  };
}
