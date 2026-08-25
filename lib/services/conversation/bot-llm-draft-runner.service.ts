/**
 * Shared LLM-draft runner — the SINGLE implementation both inbound paths use
 * (the WhatsApp webhook shared pipeline AND the `/api/message` inline route), so
 * they behave identically. Flag-gated (DEFAULT OFF → complete no-op). Draft-only.
 *
 * Order (identical on both paths): flag → workMode gate (offerAutoSuggestions) →
 * pre-guardrails + context (inside generateBotLlmDraft) → compose context →
 * LLM draft → post-response guardrail → persist GENERATED draft only.
 *
 * Injectable deps make the gating + persistence decisions testable without a DB
 * or a real model.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4B: each DB dep runs on a short tenant transaction when a tenant
// context is established (webhook/api-message paths always are). The OpenAI
// call dep never runs inside a transaction.
async function dbStep<T>(
  fn: (db: Prisma.TransactionClient | typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(prisma);
}
import { parseBotControlHandoffRules } from "@/lib/features/conversation/bot-control";
import type { BotGuardrailContextMessage } from "@/lib/features/conversation/guardrails";
import {
  completeBotLlmDraftOpenAI,
  generateBotLlmDraft,
  getBotLlmDraftDailyCap,
  getBotLlmDraftSampleRate,
  getDailyLlmCount,
  incrementDailyLlmCount,
  isBotLlmDraftSampledIn,
  isBotLlmDraftsLogTextEnabled,
  resolveBotLlmDraftMode,
  type BotLlmDraftMode,
  type BotLlmPrompt,
} from "@/lib/features/conversation/llm-draft";
import {
  loadBotComposeContext,
} from "@/lib/services/conversation/bot-compose-context.service";
import type { BotComposeContext } from "@/lib/features/bot";

export type BotLlmPriorDraftMeta = { suggestionType: string; length: number };
export type BotLlmPriorDraftText = { suggestionType: string; text: string };

/**
 * Measurement record for one LLM-draft run (shadow OR visible). Metadata is
 * ALWAYS present; the `*Text` fields appear ONLY when full-text logging is on
 * (default off → PII-safe).
 */
export type BotLlmShadowRecord = {
  businessId: number;
  conversationId: number;
  messageId: number;
  mode: "shadow" | "visible";
  outcome:
    | "draft"
    | "blocked_pre"
    | "blocked_post"
    | "no_draft"
    | "skipped_sample"
    | "skipped_daily_cap";
  blockedReason: string | null;
  draftLength: number | null;
  intent: string | null;
  // ── comparison vs prior suggestions (metadata — always recorded) ──
  priorStarterDraft: boolean;
  priorAutoSuggestion: boolean;
  priorSuggestionTypes: string[];
  priorDrafts: BotLlmPriorDraftMeta[];
  // ── full text — ONLY when BOT_LLM_DRAFTS_LOG_TEXT is on ──
  draftText?: string | null;
  priorTexts?: BotLlmPriorDraftText[];
};

export type BotLlmDraftRunnerDeps = {
  resolveMode: () => BotLlmDraftMode;
  /** Full-text logging switch (default off → metadata-only records). */
  isTextLoggingEnabled: () => boolean;
  /** Sample rate [0,1] — default 0 → never runs the (cost-bearing) model. */
  getSampleRate: () => number;
  /** Deterministic sampling decision (keyed on messageId). */
  isSampledIn: (key: number, rate: number) => boolean;
  /** Daily cap on actual LLM calls — default 0 (fail-closed). */
  getDailyCap: () => number;
  /** Actual LLM calls made today (this process). */
  getDailyUsage: () => number;
  /** Record that one actual LLM call happened. */
  incrementDailyUsage: () => void;
  complete: (prompt: BotLlmPrompt) => Promise<string | null>;
  loadComposeContext: (
    businessId: number,
    opts: { includeVoice: boolean; includeKnowledge: boolean; includeGoalsApproach: boolean }
  ) => Promise<BotComposeContext | null>;
  countInboundCustomer: (conversationId: number) => Promise<number>;
  /** Existing reply drafts for this message (type + text), for comparison metrics. */
  priorSuggestions: (args: {
    businessId: number;
    conversationId: number;
    messageId: number;
  }) => Promise<{ items: Array<{ suggestionType: string; text: string }> }>;
  /** Record a measurement row. Never shown to the owner. */
  recordMetrics: (record: BotLlmShadowRecord) => void;
  hasExistingLlmDraft: (args: {
    businessId: number;
    conversationId: number;
    messageId: number;
  }) => Promise<boolean>;
  createLlmDraft: (args: {
    businessId: number;
    conversationId: number;
    messageId: number;
    text: string;
  }) => Promise<void>;
};

/** Production deps — prisma + compose-context + OpenAI + the real flag. */
export function defaultBotLlmDraftRunnerDeps(): BotLlmDraftRunnerDeps {
  return {
    resolveMode: resolveBotLlmDraftMode,
    isTextLoggingEnabled: isBotLlmDraftsLogTextEnabled,
    getSampleRate: getBotLlmDraftSampleRate,
    isSampledIn: isBotLlmDraftSampledIn,
    getDailyCap: getBotLlmDraftDailyCap,
    getDailyUsage: getDailyLlmCount,
    incrementDailyUsage: incrementDailyLlmCount,
    complete: completeBotLlmDraftOpenAI,
    loadComposeContext: (businessId, opts) => loadBotComposeContext(businessId, opts),
    countInboundCustomer: (conversationId) =>
      dbStep((db) =>
        db.message.count({
          where: { conversationId, direction: "INBOUND", senderType: "CUSTOMER" },
        })
      ),
    priorSuggestions: async ({ businessId, conversationId, messageId }) => {
      const rows = await dbStep((db) =>
        db.replySuggestion.findMany({
          where: { businessId, conversationId, messageId },
          select: { suggestionType: true, text: true },
        })
      );
      return {
        items: rows.map((r) => ({
          suggestionType: r.suggestionType,
          text: r.text ?? "",
        })),
      };
    },
    recordMetrics: (record) => {
      // Internal measurement record — structured log, no schema change, never
      // surfaced to the owner. Can later be pointed at an analytics sink.
      console.info("[bot-llm-draft] SHADOW_METRIC", record);
    },
    hasExistingLlmDraft: async ({ businessId, conversationId, messageId }) => {
      const existing = await dbStep((db) =>
        db.replySuggestion.findFirst({
          where: { businessId, conversationId, messageId, suggestionType: "LLM_DRAFT" },
        })
      );
      return existing != null;
    },
    createLlmDraft: async ({ businessId, conversationId, messageId, text }) => {
      await dbStep((db) =>
        db.replySuggestion.create({
        data: {
          businessId,
          conversationId,
          messageId,
          suggestionType: "LLM_DRAFT",
          strategyType: "LLM",
          variantType: "LLM_DRAFT",
          variantIndex: 0,
          text,
          toneLabel: "bot",
          strategyLabel: "LLM Draft",
          status: "GENERATED",
        },
        })
      );
    },
  };
}

export type BotLlmDraftRunnerInput = {
  businessId: number;
  conversationId: number;
  messageId: number;
  /** The AUTO/SMART_DRAFTS work-mode gate (already accounts for MANUAL + handoff). */
  offerAutoSuggestions: boolean;
  humanTakeover: boolean;
  botRow: {
    enabled: boolean;
    mode: string;
    channel: string;
    welcomeMessage: string | null;
    questions: unknown;
    finalAction: string | null;
    handoffRules: unknown;
  } | null;
  message: { direction: string; senderType: string; contentText: string | null };
  analysis: { intent: string; stage: string };
  conversation: { status?: string | null; currentStage?: string | null };
  /** Recent messages (most-recent last) for the context-aware pre-guardrail + prompt. */
  recentMessages: BotGuardrailContextMessage[];
};

export type BotLlmDraftRunnerOutcome =
  | { status: "skipped"; reason: string }
  | { status: "created" }
  | { status: "shadow_recorded" }
  | { status: "handoff"; phase: "pre" | "post"; reason: string }
  | { status: "no_draft"; reason: string };

export async function maybeCreateBotLlmDraft(
  input: BotLlmDraftRunnerInput,
  deps: BotLlmDraftRunnerDeps
): Promise<BotLlmDraftRunnerOutcome> {
  const mode = deps.resolveMode();
  if (mode === "off") return { status: "skipped", reason: "FLAG_OFF" };
  if (!input.offerAutoSuggestions) return { status: "skipped", reason: "NOT_OFFERED" };
  const botRow = input.botRow;
  if (!botRow) return { status: "skipped", reason: "NO_SETTINGS" };

  // Rate control — deterministic sampling keyed on messageId. Sampled-out
  // messages record a lightweight metric and never call the model or read prior
  // drafts (keeps cost + load bounded).
  const sampleRate = deps.getSampleRate();
  if (!deps.isSampledIn(input.messageId, sampleRate)) {
    deps.recordMetrics({
      businessId: input.businessId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      mode,
      outcome: "skipped_sample",
      blockedReason: null,
      draftLength: null,
      intent: input.analysis.intent || null,
      priorStarterDraft: false,
      priorAutoSuggestion: false,
      priorSuggestionTypes: [],
      priorDrafts: [],
    });
    return { status: "skipped", reason: "SAMPLED_OUT" };
  }

  // Daily cap — a hard brake on ACTUAL LLM calls. Fail-closed: default cap 0 →
  // `0 >= 0` → blocks everything, so cost only starts with an explicit cap > 0.
  const dailyCap = deps.getDailyCap();
  if (deps.getDailyUsage() >= dailyCap) {
    deps.recordMetrics({
      businessId: input.businessId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      mode,
      outcome: "skipped_daily_cap",
      blockedReason: null,
      draftLength: null,
      intent: input.analysis.intent || null,
      priorStarterDraft: false,
      priorAutoSuggestion: false,
      priorSuggestionTypes: [],
      priorDrafts: [],
    });
    return { status: "skipped", reason: "DAILY_CAP_REACHED" };
  }

  try {
    const composeContext = await deps.loadComposeContext(input.businessId, {
      includeVoice: true,
      includeKnowledge: true,
      includeGoalsApproach: true,
    });
    const rules = parseBotControlHandoffRules(botRow.handoffRules);
    const q = botRow.questions as { items?: unknown } | null;
    const questionItems = Array.isArray(q?.items)
      ? (q.items as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const recentForPrompt = input.recentMessages
      .filter((m) => typeof m.contentText === "string" && m.contentText.trim())
      .map((m) => ({ direction: m.direction, text: m.contentText as string }));
    let inboundCount = 0;
    try {
      inboundCount = await deps.countInboundCustomer(input.conversationId);
    } catch {
      /* best-effort; 0 only relaxes the message-count boundary */
    }

    const priorResult = await deps
      .priorSuggestions({
        businessId: input.businessId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      })
      .catch(() => ({ items: [] as Array<{ suggestionType: string; text: string }> }));
    const priorItems = priorResult.items;
    const logText = deps.isTextLoggingEnabled();
    const baseRecord = {
      businessId: input.businessId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      mode,
      intent: input.analysis.intent || null,
      priorStarterDraft: priorItems.some((i) => i.suggestionType === "STARTER_BOT_DRAFT"),
      priorAutoSuggestion: priorItems.some((i) => i.suggestionType === "AUTO"),
      priorSuggestionTypes: [...new Set(priorItems.map((i) => i.suggestionType))],
      priorDrafts: priorItems.map((i) => ({
        suggestionType: i.suggestionType,
        length: i.text.length,
      })),
      // Full text only behind the flag (default off → PII-safe).
      ...(logText
        ? {
            priorTexts: priorItems.map((i) => ({
              suggestionType: i.suggestionType,
              text: i.text,
            })),
          }
        : {}),
    };

    const result = await generateBotLlmDraft(
      {
        guardrailInput: {
          message: {
            direction: input.message.direction as "INBOUND" | "OUTBOUND",
            senderType: input.message.senderType as
              | "CUSTOMER"
              | "BUSINESS_USER"
              | "SYSTEM"
              | "AI",
            contentText: input.message.contentText,
          },
          analysis: { intent: input.analysis.intent, stage: input.analysis.stage },
          conversation: {
            status: input.conversation.status,
            currentStage: input.conversation.currentStage,
          },
          settings: {
            enabled: botRow.enabled,
            mode: botRow.mode,
            channel: botRow.channel,
          },
          handoffRules: botRow.handoffRules,
          inboundMessageCount: inboundCount,
          humanTakeover: input.humanTakeover,
          context: { recentMessages: input.recentMessages },
        },
        promptData: {
          displayName: composeContext?.identity.displayName,
          welcomeMessage: botRow.welcomeMessage,
          questions: questionItems,
          finalAction: botRow.finalAction,
          voiceTone: composeContext?.voice.tone ?? null,
          voiceLanguages: composeContext?.voice.languages,
          personalityTraits: composeContext?.personalityTraits,
          personalityVerbosity: composeContext?.personalityVerbosity ?? null,
          approachSaleStyle: composeContext?.approach?.saleStyle ?? null,
          approachInitiative: composeContext?.approach?.initiativeLevel ?? null,
          approachPriorities: composeContext?.approach?.priorities,
          goals: composeContext?.goals,
          knowledgeHours: composeContext?.knowledge?.hours ?? null,
          knowledgeAddress: composeContext?.knowledge?.address ?? null,
          knowledgeNotes: composeContext?.knowledge?.notes ?? null,
          faq: composeContext?.knowledge?.faq,
          forbidden: rules.forbidden,
          customerMessage: input.message.contentText ?? "",
          recentMessages: recentForPrompt,
        },
        handoffRules: botRow.handoffRules,
      },
      { complete: deps.complete }
    );

    // Count actual model usage toward the daily cap. A pre-guardrail handoff
    // never calls the model, so it does NOT consume the cap.
    const modelWasCalled = !(result.kind === "handoff" && result.phase === "pre");
    if (modelWasCalled) deps.incrementDailyUsage();

    if (result.kind === "handoff") {
      deps.recordMetrics({
        ...baseRecord,
        outcome: result.phase === "pre" ? "blocked_pre" : "blocked_post",
        blockedReason: result.reason,
        draftLength: null,
      });
      return { status: "handoff", phase: result.phase, reason: result.reason };
    }
    if (result.kind === "no_draft") {
      deps.recordMetrics({
        ...baseRecord,
        outcome: "no_draft",
        blockedReason: result.reason,
        draftLength: null,
      });
      return { status: "no_draft", reason: result.reason };
    }
    const draftText = result.text.trim();
    if (!draftText) {
      deps.recordMetrics({
        ...baseRecord,
        outcome: "no_draft",
        blockedReason: "EMPTY_TEXT",
        draftLength: 0,
      });
      return { status: "no_draft", reason: "EMPTY_TEXT" };
    }

    // A draft was produced and passed pre + post Guardrails — record it.
    deps.recordMetrics({
      ...baseRecord,
      outcome: "draft",
      blockedReason: null,
      draftLength: draftText.length,
      ...(logText ? { draftText } : {}),
    });

    // SHADOW: measure only — never surface a visible draft to the owner.
    if (mode === "shadow") {
      return { status: "shadow_recorded" };
    }

    // VISIBLE: persist a GENERATED draft for the owner to review.
    const exists = await deps.hasExistingLlmDraft({
      businessId: input.businessId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    });
    if (exists) return { status: "skipped", reason: "ALREADY_EXISTS" };

    await deps.createLlmDraft({
      businessId: input.businessId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      text: draftText,
    });
    return { status: "created" };
  } catch {
    return { status: "no_draft", reason: "RUNNER_ERROR" };
  }
}
