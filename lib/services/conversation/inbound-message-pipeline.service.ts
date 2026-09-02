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

import type { Conversation, Message, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { analyzeMessage } from "@/lib/conversation-analysis/analyze-message";
import { generateReplySuggestions } from "@/lib/reply-suggestions/generate-reply-suggestions";
import { getContextMessages } from "@/lib/conversation-context/get-context-messages";
import { getSuggestionMode } from "@/lib/decision/get-suggestion-mode";
import { applyMessageEvent } from "@/lib/conversation-state/conversation-state.service";
import { recordConversationEvidence } from "@/lib/services/conversation/conversation-evidence.service";
import { maybeCaptureLeadFromMessage } from "@/lib/services/crm/lead-auto-capture.service";
import {
  type BotPolicyAnalysisSnapshot,
  type BotPolicyConversationSnapshot,
  type BotPolicyEngineResult,
  type BotPolicyMessageSnapshot,
  type BotPolicySettingsSnapshot,
} from "@/lib/features/conversation/bot-policy";
import { evaluateBotGuardrails } from "@/lib/features/conversation/guardrails";
import {
  isHumanTakeoverConversation,
  resolveBotWorkMode,
  shouldOfferAutoReplySuggestions,
  shouldOfferStarterBotDrafts,
} from "@/lib/features/conversation/bot-control";
import {
  defaultBotLlmDraftRunnerDeps,
  maybeCreateBotLlmDraft,
} from "@/lib/services/conversation/bot-llm-draft-runner.service";
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

  // Atomic, tenant-scoped transition — a foreign suggestion id can never be
  // a mutation handle.
  await db.replySuggestion.updateMany({
    where: { id: latestSentSuggestion.id, businessId },
    data: dataToUpdate,
  });
  return db.replySuggestion.findFirst({
    where: { id: latestSentSuggestion.id, businessId },
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

  // D2/P7-W4B: the pipeline REQUIRES an established tenant context (webhook
  // runTenantJob / api-message runWithTenantContext). Each DB group below
  // runs on its own SHORT tenant transaction; external/LLM-capable work
  // (maybeCreateBotLlmDraft's OpenAI call) never executes inside one.

  // 1. Context window from prior messages (excluding the message we just
  //    persisted).
  const contextMessages = await withTenantTransaction((tx) =>
    getContextMessages(message.conversationId, 5, { tx })
  );
  const previousMessages = contextMessages.filter((m) => m.id !== message.id);

  // 2. Pure NLU.
  const analysis = analyzeMessage(message.contentText ?? "", previousMessages);

  // 3. Persist MessageAnalysis + write back labels on the Message itself —
  //    one atomic tenant transaction; the label write is tenant-scoped.
  const labelledMessage = await withTenantTransaction(async (tx) => {
    await tx.messageAnalysis.create({
      data: {
        messageId: message.id,
        intent: analysis.intent,
        stage: analysis.stage,
      },
    });

    await tx.message.updateMany({
      where: { id: message.id, businessId },
      data: {
        intentLabel: analysis.intent,
        stageLabel: analysis.stage,
      },
    });
    return tx.message.findFirstOrThrow({
      where: { id: message.id, businessId },
    });
  });

  emit(source, "MESSAGE_ANALYZED", {
    conversationId: conversation.id,
    businessId,
    messageId: message.id,
    intent: analysis.intent,
    stage: analysis.stage,
  });

  // 4. Conversation state machine.
  let writerState: Extract<
    Awaited<ReturnType<typeof applyMessageEvent>>,
    { applied: true }
  >["state"] | null = null;
  try {
    const applied = await withTenantTransaction((tx) =>
      applyMessageEvent(
        {
          message: labelledMessage,
          conversation,
          analysis,
        },
        { tx }
      )
    );
    if (applied.applied) writerState = applied.state;
  } catch (error) {
    console.warn(
      "[inbound-pipeline] conversation-state writer failed:",
      error
    );
  }

  // 4b. W3 — durable evidence. The writer keeps only the CURRENT state, so the
  // transitions it just made are recorded here or lost forever. Best-effort:
  // never breaks the message it describes.
  await withTenantTransaction((tx) =>
    recordConversationEvidence(
      {
        businessId,
        conversationId: conversation.id,
        messageId: labelledMessage.id,
        leadId: conversation.leadId ?? null,
        channel: conversation.channel,
        direction: labelledMessage.direction,
        senderType: labelledMessage.senderType,
        occurredAt: labelledMessage.createdAt ?? new Date(),
        state: writerState,
      },
      { tx }
    )
  ).catch((error) => {
    console.warn("[inbound-pipeline] evidence failed:", error);
  });

  // 4c. W3 — auto-capture, behind LEADS_AUTO_CAPTURE_ENABLED (OFF by default).
  // A real inquiry should not depend on the owner noticing a button.
  try {
    const captured = await withTenantTransaction((tx) =>
      maybeCaptureLeadFromMessage(
        { businessId, conversation, message: labelledMessage },
        { tx }
      )
    );
    if (captured.captured) {
      emit(source, "LEAD_AUTO_CAPTURED", {
        conversationId: conversation.id,
        businessId,
        leadId: captured.leadId,
        outcome: captured.outcome,
      });
    }
  } catch (error) {
    console.warn("[inbound-pipeline] lead auto-capture failed:", error);
  }

  // 5. Bot policy + 6. starter bot.
  const humanTakeover = isHumanTakeoverConversation(conversation.outcomeReason);
  let botRow: BotSettingsObserveRow | null = null;
  let starterBotDraftCreated = false;
  let policyDecision: BotPolicyEngineResult["decision"] = "ALLOW_SUGGESTIONS_ONLY";

  try {
    try {
      botRow = await withTenantTransaction((tx) =>
        tx.businessBotSettings.findUnique({
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
        })
      );
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
      console.warn(
        "[inbound-pipeline] inbound message count failed:",
        countErr
      );
    }

    // Canonical Guardrails — the single enforcement point. STARTER (below) and
    // AUTO suggestions (step 8) both read this ONE decision.
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
        starterBotFlowAlreadyCompleted = await withTenantTransaction((tx) =>
          isStarterBotFlowCompletedSent(
            {
              businessId,
              conversationId: conversation.id,
            },
            { tx }
          )
        );
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
            derivedNextQuestionIndex = await withTenantTransaction((tx) =>
              deriveStarterBotNextQuestionIndex(
                {
                  businessId,
                  conversationId: conversation.id,
                },
                { tx }
              )
            );
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
              const draftCreated = await withTenantTransaction(async (tx) => {
                const existingBotDraft = await tx.replySuggestion.findFirst({
                  where: {
                    businessId,
                    conversationId: conversation.id,
                    messageId: labelledMessage.id,
                    suggestionType: "STARTER_BOT_DRAFT",
                  },
                });

                if (existingBotDraft) return false;
                const variantType =
                  starterDraft.replyKind &&
                  starterDraft.replyKind.trim().length > 0
                    ? starterDraft.replyKind
                    : "BOT_DRAFT";

                await tx.replySuggestion.create({
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
                return true;
              });
              if (draftCreated) {
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

  const updatedOutcomeSuggestion = await withTenantTransaction((tx) =>
    updateLatestSentSuggestionOutcome(tx, {
      businessId,
      conversationId: message.conversationId,
      currentMessageCreatedAt: message.createdAt,
      previousStage: previousMessageWithStage?.stageLabel,
      currentStage: analysis.stage,
    })
  );

  // 8. Auto-suggestions (LLM) + mode filter.
  const mode = getSuggestionMode(analysis, labelledMessage.contentText ?? "");

  const workModeForSuggestions = botRow
    ? resolveBotWorkMode({
        enabled: botRow.enabled,
        showDraftSuggestionsInInbox: botRow.showDraftSuggestionsInInbox,
        handoffRules: botRow.handoffRules,
      })
    : ("MANUAL" as const);

  // AUTO suggestions must also pass the canonical Guardrails: when the bot must
  // hand off to the owner, NO engine (STARTER or AUTO) drafts a reply.
  // `policyDecision` is the handler-scoped mirror of the Guardrails decision
  // (HANDOFF_REQUIRED ⇔ requiresHandoff).
  const offerAutoSuggestions =
    shouldOfferAutoReplySuggestions({
      workMode: workModeForSuggestions,
      humanTakeover,
    }) && policyDecision !== "HANDOFF_REQUIRED";

  const generatedSuggestions = offerAutoSuggestions
    ? await withTenantTransaction((tx) =>
        generateReplySuggestions(labelledMessage, analysis, contextMessages, {
          tx,
        })
      )
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

  // Stage 4 (flag-gated, DEFAULT OFF → byte-identical to before): first LLM reply
  // DRAFT via the SHARED runner — identical to the `/api/message` inline path.
  // Draft-only, never sent; pre + post Guardrails inside the runner.
  const llmDraftOutcome = await maybeCreateBotLlmDraft(
    {
      businessId,
      conversationId: conversation.id,
      messageId: labelledMessage.id,
      offerAutoSuggestions,
      humanTakeover,
      botRow,
      message: {
        direction: labelledMessage.direction,
        senderType: labelledMessage.senderType,
        contentText: labelledMessage.contentText,
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
    console.info("[inbound-pipeline] LLM_DRAFT_OUTCOME", {
      conversationId: conversation.id,
      businessId,
      ...llmDraftOutcome,
    });
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
