import { prisma } from "@/lib/prisma";

const STARTER_BOT_DRAFT = "STARTER_BOT_DRAFT" as const;

/** Proof that a bot draft was acted on (outbound from suggestion or marked SENT). */
const SENT_PROOF_OR = [
  {
    generatedMessages: {
      some: {
        direction: "OUTBOUND" as const,
        senderType: "BUSINESS_USER" as const,
      },
    },
  },
  {
    status: "SENT" as const,
    sentAt: { not: null },
  },
] as const;

/** Terminal closing kinds stored on `ReplySuggestion.variantType` for bot drafts. */
const TERMINAL_BOT_VARIANT_TYPES = ["COMPLETE", "HANDOFF", "FINAL_ACTION"] as const;

/**
 * Derived read-only progression for Starter Bot v2 Lite.
 *
 * Returns `nextQuestionIndex` to pass into `planStarterBotReply` (same semantics as
 * `StarterBotPlannerInput.nextQuestionIndex`).
 *
 * Counts how many bot-draft suggestions for this conversation were **actually used**
 * in at least one business outbound message (`generatedFromSuggestionId`), **or**
 * were marked `SENT` with `sentAt` (covers flows where the message link is missing).
 *
 * If the query fails or signals are ambiguous, callers should treat the result as 0.
 */
export async function deriveStarterBotNextQuestionIndex(params: {
  businessId: number;
  conversationId: number;
}): Promise<number> {
  const { businessId, conversationId } = params;

  const rows = await prisma.replySuggestion.findMany({
    where: {
      businessId,
      conversationId,
      suggestionType: STARTER_BOT_DRAFT,
      OR: [...SENT_PROOF_OR],
    },
    select: { id: true },
    distinct: ["id"],
  });

  return rows.length;
}

/**
 * True once a terminal Starter Bot draft was **sent** (same signals as derive count).
 * Used to stop issuing further `STARTER_BOT_DRAFT` rows for this conversation.
 */
export async function isStarterBotFlowCompletedSent(params: {
  businessId: number;
  conversationId: number;
}): Promise<boolean> {
  const { businessId, conversationId } = params;

  const row = await prisma.replySuggestion.findFirst({
    where: {
      businessId,
      conversationId,
      suggestionType: STARTER_BOT_DRAFT,
      variantType: { in: [...TERMINAL_BOT_VARIANT_TYPES] },
      OR: [...SENT_PROOF_OR],
    },
    select: { id: true },
  });

  return row != null;
}

/**
 * Batch-load terminal Starter Bot draft flags for many conversations (2nd query in inbox list).
 */
export async function findStarterBotTerminalConversationFlags(params: {
  businessId: number;
  conversationIds: readonly number[];
}): Promise<{
  handoffConversationIds: ReadonlySet<number>;
  completedConversationIds: ReadonlySet<number>;
}> {
  const uniqueIds = [...new Set(params.conversationIds)].filter((id) => id > 0);
  if (uniqueIds.length === 0) {
    return {
      handoffConversationIds: new Set(),
      completedConversationIds: new Set(),
    };
  }

  const rows = await prisma.replySuggestion.findMany({
    where: {
      businessId: params.businessId,
      conversationId: { in: uniqueIds },
      suggestionType: STARTER_BOT_DRAFT,
      variantType: { in: [...TERMINAL_BOT_VARIANT_TYPES] },
      OR: [...SENT_PROOF_OR],
    },
    select: { conversationId: true, variantType: true },
  });

  const handoffConversationIds = new Set<number>();
  const completedConversationIds = new Set<number>();
  for (const r of rows) {
    if (r.variantType === "HANDOFF") {
      handoffConversationIds.add(r.conversationId);
    } else {
      completedConversationIds.add(r.conversationId);
    }
  }

  return { handoffConversationIds, completedConversationIds };
}
