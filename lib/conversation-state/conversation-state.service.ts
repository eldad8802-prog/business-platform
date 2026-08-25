import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type TxOptions = { tx?: Prisma.TransactionClient };
import type {
  Conversation,
  ConversationStage,
  Message,
} from "@prisma/client";
import {
  mapAnalysisToConversationStage,
  type AnalysisInput,
} from "./stage-mapping";

/**
 * Conversation State Writer — v1.
 *
 * Single-purpose service: in response to a Message event, recompute the
 * Conversation row's "live state" fields and write them in a SINGLE update.
 *
 * Scope (v1):
 *   - lastMessageAt
 *   - customerLastInboundAt
 *   - businessLastOutboundAt
 *   - unansweredInboundCount
 *   - currentStage           (only when stage-mapping returns a transition)
 *   - temperatureScore       (rule-based, conservative)
 *   - closeProbabilitySnapshot (rule-based, conservative)
 *   - lastAnalysisAt         (only when analysis ran)
 *
 * Out of scope (v1): sentiment, intentType on conversation, outcomeStatus,
 * latencies, risk reasons, follow-up flags, denormalised pendingSuggestion.
 *
 * Runtime contract:
 *   - Pure additive: never demotes a stage, never overwrites locked stages
 *     (WON/LOST/INACTIVE).
 *   - Idempotent enough for v1: re-running on the same message is safe in
 *     practice (counters/timestamps converge).
 *   - Failure-isolated: callers MUST wrap the call in try/catch. A failure
 *     here must NOT break Message creation. The function does not throw on
 *     missing input; it returns early.
 *   - Single write: exactly one prisma.conversation.update at the end.
 *   - Feature-flagged: gated by CONVERSATION_STATE_WRITER_ENABLED=true.
 */

const FLAG_ENV_NAME = "CONVERSATION_STATE_WRITER_ENABLED";

export function isConversationStateWriterEnabled(): boolean {
  return process.env[FLAG_ENV_NAME] === "true";
}

export type ApplyMessageEventInput = {
  message: Message;
  conversation: Conversation;
  analysis: AnalysisInput;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function computeTemperature(params: {
  stage: ConversationStage;
  unansweredAfterEvent: number;
  customerLastInboundAt: Date | null;
  businessLastOutboundAt: Date | null;
  lastMessageAt: Date | null;
  analysis: AnalysisInput;
  now: Date;
}): number {
  const {
    stage,
    unansweredAfterEvent,
    customerLastInboundAt,
    businessLastOutboundAt,
    lastMessageAt,
    analysis,
    now,
  } = params;

  // Locked outcomes have absolute temperatures
  if (stage === "WON") return 1;
  if (stage === "LOST" || stage === "INACTIVE") return 0;

  let t = 0.5;

  if (stage === "QUALIFIED") t += 0.05;
  else if (stage === "QUOTED") t += 0.15;
  else if (stage === "NEGOTIATION") t += 0.25;

  if (unansweredAfterEvent >= 2) t += 0.05;

  if (customerLastInboundAt) {
    const sinceInbound = now.getTime() - customerLastInboundAt.getTime();
    if (sinceInbound < HOUR_MS) t += 0.1;
    else if (sinceInbound < 4 * HOUR_MS) t += 0.05;
  }

  if (analysis?.stage === "closing") t += 0.1;
  if (analysis?.intent === "booking") t += 0.05;
  else if (analysis?.intent === "price") t += 0.03;

  if (lastMessageAt) {
    const sinceAny = now.getTime() - lastMessageAt.getTime();
    if (sinceAny > 3 * DAY_MS) t -= 0.15;
  }

  if (
    businessLastOutboundAt &&
    (!customerLastInboundAt ||
      businessLastOutboundAt.getTime() > customerLastInboundAt.getTime())
  ) {
    const ghostedMs = now.getTime() - businessLastOutboundAt.getTime();
    if (ghostedMs > 7 * DAY_MS) t -= 0.2;
    else if (ghostedMs > 3 * DAY_MS) t -= 0.1;
    else if (ghostedMs > DAY_MS) t -= 0.05;
  }

  return clamp01(t);
}

const STAGE_BASE_PROBABILITY: Record<ConversationStage, number> = {
  NEW: 0.05,
  QUALIFIED: 0.2,
  QUOTED: 0.45,
  NEGOTIATION: 0.65,
  WON: 1,
  LOST: 0,
  INACTIVE: 0.1,
};

function computeCloseProbability(params: {
  stage: ConversationStage;
  temperature: number;
}): number {
  const base = STAGE_BASE_PROBABILITY[params.stage] ?? 0.05;
  return clamp01(base * 0.7 + params.temperature * 0.3);
}

export async function applyMessageEvent(
  input: ApplyMessageEventInput,
  options?: TxOptions
): Promise<void> {
  if (!isConversationStateWriterEnabled()) {
    return;
  }

  const { message, conversation, analysis } = input;

  if (!message || !conversation) return;
  if (message.conversationId !== conversation.id) return;

  const now = message.createdAt ?? new Date();

  const isCustomerInbound =
    message.direction === "INBOUND" && message.senderType === "CUSTOMER";
  const isOutbound = message.direction === "OUTBOUND";

  // 1. Time fields
  const lastMessageAt = now;
  const customerLastInboundAt = isCustomerInbound
    ? now
    : conversation.customerLastInboundAt;
  const businessLastOutboundAt = isOutbound
    ? now
    : conversation.businessLastOutboundAt;

  // 2. Counter
  let unansweredAfterEvent = conversation.unansweredInboundCount ?? 0;
  if (isCustomerInbound) {
    unansweredAfterEvent += 1;
  } else if (isOutbound) {
    unansweredAfterEvent = 0;
  }
  // SYSTEM / AI inbound — counter unchanged (no business meaning)

  // 3. Stage
  const nextStage = mapAnalysisToConversationStage({
    currentStage: conversation.currentStage,
    direction: message.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
    senderType: message.senderType,
    contentText: message.contentText,
    analysis,
  });
  const effectiveStage: ConversationStage =
    nextStage ?? conversation.currentStage ?? "NEW";

  // 4. Temperature (uses post-event stage and timestamps)
  const temperature = computeTemperature({
    stage: effectiveStage,
    unansweredAfterEvent,
    customerLastInboundAt,
    businessLastOutboundAt,
    lastMessageAt,
    analysis,
    now,
  });

  // 5. Close probability (depends on stage + temperature)
  const closeProbability = computeCloseProbability({
    stage: effectiveStage,
    temperature,
  });

  // 6. lastAnalysisAt — only stamped when analysis actually ran
  // 7. ONE write
  const db = options?.tx ?? prisma;
  await db.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt,
      customerLastInboundAt,
      businessLastOutboundAt,
      unansweredInboundCount: unansweredAfterEvent,
      ...(nextStage ? { currentStage: nextStage } : {}),
      temperatureScore: temperature,
      closeProbabilitySnapshot: closeProbability,
      ...(analysis ? { lastAnalysisAt: now } : {}),
    },
  });
}
