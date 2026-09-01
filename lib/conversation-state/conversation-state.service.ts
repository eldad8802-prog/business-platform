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
 *   - IDEMPOTENT (W2.5). Applying the same message twice leaves the row in the
 *     same state as applying it once. See "Replay safety" below.
 *   - TENANT-SCOPED (W2.5). The write carries a `businessId` predicate, so a
 *     conversation id from another business can never become a write handle.
 *   - Failure-isolated: callers MUST wrap the call in try/catch. A failure
 *     here must NOT break Message creation. The function does not throw on
 *     missing input; it returns a reason.
 *   - Single write: exactly one tenant-scoped update at the end.
 *   - Feature-flagged: gated by CONVERSATION_STATE_WRITER_ENABLED=true.
 *
 * ── Replay safety (W2.5) ────────────────────────────────────────────────────
 * v1 kept `unansweredInboundCount` as a read-modify-write increment, so the same
 * message arriving twice counted twice. The WhatsApp path is guarded upstream by
 * wamid, but `/api/message` is not — and "guarded by whoever calls us" is not a
 * property the writer can claim about itself.
 *
 * The counter is now DERIVED from Message history: customer-inbound messages
 * created after the most recent outbound. That is a function of persisted facts,
 * so replaying an event recomputes the same number instead of adding to it. It
 * also self-heals — a state that has drifted for any reason converges on the
 * next event rather than staying wrong forever.
 *
 * Every other written field was already a function of the event and the row, so
 * with the counter derived the whole write is idempotent. The remaining hazard
 * is ORDERING: replaying an OLD message after a newer one must not drag
 * `lastMessageAt` (or the inbound/outbound stamps) backwards. Those three are
 * therefore monotonic — they only ever move forward.
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

/**
 * Why a call did or did not write. Callers ignore it (they only care that the
 * writer cannot break message creation); tests assert on it, so a suppression
 * is visible as a REASON rather than as a silent no-op.
 */
export type ApplyMessageEventResult =
  | { applied: true; unansweredInboundCount: number }
  | {
      applied: false;
      reason:
        | "flag_disabled"
        | "missing_input"
        | "conversation_mismatch"
        | "tenant_mismatch"
        | "conversation_not_found";
    };

/** Keep the later of two instants; `null` loses to any real timestamp. */
function latest(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

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
): Promise<ApplyMessageEventResult> {
  if (!isConversationStateWriterEnabled()) {
    return { applied: false, reason: "flag_disabled" };
  }

  const { message, conversation, analysis } = input;

  if (!message || !conversation) return { applied: false, reason: "missing_input" };
  if (message.conversationId !== conversation.id) {
    return refused("conversation_mismatch", conversation.id, message.id);
  }
  // The message is the EVIDENCE for the state change; if it belongs to another
  // business it cannot be evidence about this conversation, whatever the caller
  // believes.
  if (message.businessId !== conversation.businessId) {
    return refused("tenant_mismatch", conversation.id, message.id);
  }

  const businessId = conversation.businessId;
  const db = options?.tx ?? prisma;
  const now = message.createdAt ?? new Date();

  const isCustomerInbound =
    message.direction === "INBOUND" && message.senderType === "CUSTOMER";
  const isOutbound = message.direction === "OUTBOUND";

  // 1. Time fields — MONOTONIC. Replaying an older message after a newer one
  //    must not drag the clock backwards.
  const lastMessageAt = latest(conversation.lastMessageAt, now) ?? now;
  const customerLastInboundAt = isCustomerInbound
    ? latest(conversation.customerLastInboundAt, now)
    : conversation.customerLastInboundAt;
  const businessLastOutboundAt = isOutbound
    ? latest(conversation.businessLastOutboundAt, now)
    : conversation.businessLastOutboundAt;

  // 2. Counter — DERIVED, never incremented.
  //
  //    "Customer-inbound messages since the business last spoke" is exactly what
  //    the old increment/reset pair approximated, so the semantics are unchanged
  //    — but computing it from the rows makes a replay recompute the same number
  //    instead of adding to it, and lets a drifted value heal on the next event.
  //
  //    SYSTEM / AI inbound is excluded by the senderType filter, matching v1's
  //    "counter unchanged" rule for those.
  //    ONE round trip, not two. This runs on the hot inbound path inside the
  //    tenant transaction, and Prisma's interactive-transaction budget is not
  //    generous — a naive "find last outbound, then count" cost an extra
  //    round trip per message and blew the 5s budget against a remote database.
  //    The correlated subquery does the same work in a single statement.
  //
  //    Parameterized (never interpolated), and it runs on `tx`, so the tenant
  //    GUC and the RLS predicate apply to it exactly as to any other read.
  const unansweredRows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n
    FROM "Message" m
    WHERE m."conversationId" = ${conversation.id}
      AND m."businessId" = ${businessId}
      AND m."direction" = 'INBOUND'
      AND m."senderType" = 'CUSTOMER'
      AND m."createdAt" > COALESCE(
        (SELECT max(o."createdAt")
           FROM "Message" o
          WHERE o."conversationId" = ${conversation.id}
            AND o."businessId" = ${businessId}
            AND o."direction" = 'OUTBOUND'),
        '-infinity'::timestamp
      )`;
  const unansweredAfterEvent = Number(unansweredRows[0]?.n ?? 0);

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

  // 6. lastAnalysisAt — only stamped when analysis actually ran, and monotonic
  //    for the same reason the other stamps are.
  const lastAnalysisAt = analysis
    ? latest(conversation.lastAnalysisAt, now)
    : undefined;

  // 7. ONE write, TENANT-SCOPED.
  //
  //    `updateMany` with the businessId predicate rather than `update` by id:
  //    a conversation id belonging to another business matches nothing and
  //    writes nothing, instead of being a usable write handle. This is the same
  //    rule every D2 wave applies to every other mutation.
  const updated = await db.conversation.updateMany({
    where: { id: conversation.id, businessId },
    data: {
      lastMessageAt,
      customerLastInboundAt,
      businessLastOutboundAt,
      unansweredInboundCount: unansweredAfterEvent,
      ...(nextStage ? { currentStage: nextStage } : {}),
      temperatureScore: temperature,
      closeProbabilitySnapshot: closeProbability,
      ...(lastAnalysisAt ? { lastAnalysisAt } : {}),
    },
  });

  if (updated.count !== 1) {
    return refused("conversation_not_found", conversation.id, message.id);
  }

  return { applied: true, unansweredInboundCount: unansweredAfterEvent };
}

/**
 * A refusal that is not simply "the flag is off" means the writer was handed
 * something inconsistent — a foreign message, a mismatched conversation, a row
 * that vanished. Those are silent today, which is how a tenant-shaped bug would
 * hide. One structured warn line on the existing console channel makes them
 * greppable without standing up a monitoring subsystem.
 *
 * Deliberately carries ids only — no message text, no customer data.
 */
function refused(
  reason: Exclude<
    Extract<ApplyMessageEventResult, { applied: false }>["reason"],
    "flag_disabled"
  >,
  conversationId: number,
  messageId: number
): ApplyMessageEventResult {
  console.warn(
    `[conversation-state] refused reason=${reason} conversationId=${conversationId} messageId=${messageId}`
  );
  return { applied: false, reason };
}
