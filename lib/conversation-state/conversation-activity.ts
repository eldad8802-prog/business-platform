/**
 * Conversation activity — the timestamps and the unanswered count, ALWAYS kept.
 *
 * Before M2 these columns had two writers that disagreed:
 *   - WhatsApp intake bumped `unansweredInboundCount` by +1 per message (a replay
 *     or a retry counted twice) and never reset it on reply;
 *   - the flagged state writer (`applyMessageEvent`, CONVERSATION_STATE_WRITER_
 *     ENABLED) recomputed them correctly — but only when its flag was on, and
 *     `/api/message` wrote nothing at all without it.
 *
 * This helper is now the one authoritative writer of:
 *   lastMessageAt · customerLastInboundAt · businessLastOutboundAt ·
 *   unansweredInboundCount
 * and it runs for every persisted message, independent of that flag.
 *
 * Every value is DERIVED, so applying the same message twice leaves the row
 * exactly as applying it once:
 *   - the three timestamps are monotonic — an old message replayed after a newer
 *     one never drags them backwards;
 *   - the counter is "customer-inbound messages since the business last spoke",
 *     recomputed from Message history in one statement.
 *
 * What it deliberately does NOT touch: `currentStage`, `temperatureScore`,
 * `closeProbabilitySnapshot`, `lastAnalysisAt`. Those remain behind
 * CONVERSATION_STATE_WRITER_ENABLED in `applyMessageEvent`, exactly as before —
 * M2 neither switches them on nor off.
 *
 * Tenant-scoped: the write carries a businessId predicate and runs on the
 * caller's tenant transaction, so a foreign conversation id matches nothing.
 */

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type ActivityMessage = {
  conversationId: number;
  businessId: number;
  direction: string;
  senderType: string;
  createdAt: Date;
};

export type ActivityConversation = {
  id: number;
  businessId: number;
  lastMessageAt: Date | null;
  customerLastInboundAt: Date | null;
  businessLastOutboundAt: Date | null;
};

export function latestOf(current: Date | null | undefined, candidate: Date): Date {
  if (!current) return candidate;
  return current.getTime() >= candidate.getTime() ? current : candidate;
}

/**
 * Customer-inbound messages created after the most recent outbound message.
 * One round trip, parameterized, on the caller's transaction (so the tenant GUC
 * and the RLS predicate apply to it).
 */
export async function deriveUnansweredInboundCount(
  db: Tx,
  conversationId: number,
  businessId: number
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n
    FROM "Message" m
    WHERE m."conversationId" = ${conversationId}
      AND m."businessId" = ${businessId}
      AND m."direction" = 'INBOUND'
      AND m."senderType" = 'CUSTOMER'
      AND m."createdAt" > COALESCE(
        (SELECT max(o."createdAt")
           FROM "Message" o
          WHERE o."conversationId" = ${conversationId}
            AND o."businessId" = ${businessId}
            AND o."direction" = 'OUTBOUND'),
        '-infinity'::timestamp
      )`;
  return Number(rows[0]?.n ?? 0);
}

export type ActivityStamps = {
  lastMessageAt: Date;
  customerLastInboundAt: Date | null;
  businessLastOutboundAt: Date | null;
};

/** Pure: the monotonic stamps after `message` is applied to `conversation`. */
export function activityStampsAfter(
  conversation: Pick<ActivityConversation, "lastMessageAt" | "customerLastInboundAt" | "businessLastOutboundAt">,
  message: Pick<ActivityMessage, "direction" | "senderType" | "createdAt">
): ActivityStamps {
  const at = message.createdAt;
  const isCustomerInbound = message.direction === "INBOUND" && message.senderType === "CUSTOMER";
  const isOutbound = message.direction === "OUTBOUND";
  return {
    lastMessageAt: latestOf(conversation.lastMessageAt, at),
    customerLastInboundAt: isCustomerInbound
      ? latestOf(conversation.customerLastInboundAt, at)
      : conversation.customerLastInboundAt,
    businessLastOutboundAt: isOutbound
      ? latestOf(conversation.businessLastOutboundAt, at)
      : conversation.businessLastOutboundAt,
  };
}

/**
 * Apply one persisted message to its conversation's activity columns. Reads the
 * row fresh inside the transaction so concurrent messages converge.
 * Returns the derived unanswered count, or null when the conversation is not
 * this business's (nothing written).
 */
export async function recordConversationActivity(
  tx: Tx,
  message: ActivityMessage
): Promise<{ unansweredInboundCount: number } | null> {
  const conversation = await tx.conversation.findFirst({
    where: { id: message.conversationId, businessId: message.businessId },
    select: {
      id: true,
      businessId: true,
      lastMessageAt: true,
      customerLastInboundAt: true,
      businessLastOutboundAt: true,
    },
  });
  if (!conversation) return null;

  const stamps = activityStampsAfter(conversation, message);
  const unansweredInboundCount = await deriveUnansweredInboundCount(
    tx,
    conversation.id,
    conversation.businessId
  );

  const updated = await tx.conversation.updateMany({
    where: { id: conversation.id, businessId: conversation.businessId },
    data: { ...stamps, unansweredInboundCount },
  });
  return updated.count === 1 ? { unansweredInboundCount } : null;
}
