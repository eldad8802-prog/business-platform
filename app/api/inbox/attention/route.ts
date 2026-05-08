import { NextResponse } from "next/server";
import {
  ConversationChannel,
  ConversationStage,
  ConversationStatus,
  MessageDirection,
  MessageSenderType,
  ReplySuggestionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const SNIPPET_MAX_CHARS = 160;
/** Max OPEN conversations to load messages/suggestions for (MVP scan window). */
const OPEN_CONVERSATION_SCAN_CAP = 200;

type ReasonCode =
  | "WAITING_FOR_REPLY"
  | "PENDING_SMART_SUGGESTION"
  | "RECENTLY_HANDLED";

type PriorityType =
  | "WAITING_FOR_REPLY"
  | "PENDING_SMART_SUGGESTION"
  | "RECENTLY_HANDLED";

type AttentionItem = {
  conversationId: number;
  customerName: string | null;
  channel: ConversationChannel;
  status: ConversationStatus;
  currentStage: ConversationStage | null;
  lastRelevantMessageText: string | null;
  reasonCode: ReasonCode;
  reasonText: string;
  relevantAt: string;
  createdAt: string;
  primaryAction: "OPEN_CONVERSATION";
  hasPendingSuggestion: boolean;
  priorityRank: 1 | 2 | 3;
  priorityType: PriorityType;
};

const REASON_TEXT: Record<ReasonCode, string> = {
  WAITING_FOR_REPLY: "הלקוח שלח הודעה אחרונה; כדאי להשיב כשמתאים.",
  PENDING_SMART_SUGGESTION:
    "יש הצעת תשובה שעדיין לא נשלחה או נסגרה.",
  RECENTLY_HANDLED: "השיחה סומנה לאחרונה כסגורה.",
};

const PENDING_SUGGESTION_STATUSES: ReplySuggestionStatus[] = [
  "GENERATED",
  "SHOWN",
  "SELECTED",
];

function parseLimit(raw: string | null): number {
  if (raw == null || raw === "") {
    return DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function truncateSnippet(text: string | null | undefined): string | null {
  if (text == null) {
    return null;
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length <= SNIPPET_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

function buildCustomerName(
  customer: { name: string } | null | undefined
): string | null {
  if (!customer?.name) {
    return null;
  }
  const n = customer.name.trim();
  return n === "" ? null : n;
}

function toAttentionItemBase(
  conversation: {
    id: number;
    channel: ConversationChannel;
    status: ConversationStatus;
    currentStage: ConversationStage | null;
    createdAt: Date;
    customer: { name: string } | null;
  },
  params: {
    lastRelevantMessageText: string | null;
    reasonCode: ReasonCode;
    relevantAt: Date;
    hasPendingSuggestion: boolean;
    priorityRank: 1 | 2 | 3;
    priorityType: PriorityType;
  }
): AttentionItem {
  return {
    conversationId: conversation.id,
    customerName: buildCustomerName(conversation.customer),
    channel: conversation.channel,
    status: conversation.status,
    currentStage: conversation.currentStage,
    lastRelevantMessageText: params.lastRelevantMessageText,
    reasonCode: params.reasonCode,
    reasonText: REASON_TEXT[params.reasonCode],
    relevantAt: params.relevantAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    primaryAction: "OPEN_CONVERSATION",
    hasPendingSuggestion: params.hasPendingSuggestion,
    priorityRank: params.priorityRank,
    priorityType: params.priorityType,
  };
}

/** Latest message per conversationId (first hit wins when iterating createdAt desc). */
function pickLatestMessagePerConversation<
  T extends {
    conversationId: number;
    createdAt: Date;
  },
>(rows: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows) {
    if (!map.has(row.conversationId)) {
      map.set(row.conversationId, row);
    }
  }
  return map;
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const businessId = user.businessId;
    const { searchParams } = new URL(req.url);
    const limit = parseLimit(searchParams.get("limit"));

    const openConversationRows = await prisma.conversation.findMany({
      where: {
        businessId,
        status: "OPEN",
      },
      orderBy: { updatedAt: "desc" },
      take: OPEN_CONVERSATION_SCAN_CAP,
      select: {
        id: true,
        channel: true,
        status: true,
        currentStage: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
    });

    const openIds = openConversationRows.map((c) => c.id);
    const conversationById = new Map(openConversationRows.map((c) => [c.id, c]));

    let waitingForReply: AttentionItem[] = [];

    if (openIds.length > 0) {
      const recentMessages = await prisma.message.findMany({
        where: {
          businessId,
          conversationId: { in: openIds },
        },
        orderBy: { createdAt: "desc" },
        select: {
          conversationId: true,
          direction: true,
          senderType: true,
          contentText: true,
          createdAt: true,
        },
      });

      const lastByConv = pickLatestMessagePerConversation(recentMessages);

      const candidates: Array<{
        conversationId: number;
        relevantAt: Date;
        snippet: string | null;
      }> = [];

      for (const [, msg] of lastByConv) {
        if (
          msg.direction === MessageDirection.INBOUND &&
          msg.senderType === MessageSenderType.CUSTOMER
        ) {
          candidates.push({
            conversationId: msg.conversationId,
            relevantAt: msg.createdAt,
            snippet: truncateSnippet(msg.contentText),
          });
        }
      }

      candidates.sort((a, b) => b.relevantAt.getTime() - a.relevantAt.getTime());

      const waitingCandidates = candidates.slice(0, limit);
      const waitingConvIds = waitingCandidates.map((c) => c.conversationId);

      let waitingWithOpenSuggestion = new Set<number>();
      if (waitingConvIds.length > 0) {
        const suggestionRows = await prisma.replySuggestion.findMany({
          where: {
            businessId,
            conversationId: { in: waitingConvIds },
            status: { in: PENDING_SUGGESTION_STATUSES },
          },
          select: { conversationId: true },
        });
        waitingWithOpenSuggestion = new Set(
          suggestionRows.map((r) => r.conversationId)
        );
      }

      waitingForReply = waitingCandidates.flatMap((c) => {
        const conv = conversationById.get(c.conversationId);
        if (!conv) {
          return [];
        }
        return [
          toAttentionItemBase(conv, {
            lastRelevantMessageText: c.snippet,
            reasonCode: "WAITING_FOR_REPLY",
            relevantAt: c.relevantAt,
            hasPendingSuggestion: waitingWithOpenSuggestion.has(c.conversationId),
            priorityRank: 1,
            priorityType: "WAITING_FOR_REPLY",
          }),
        ];
      });
    }

    const waitingIdSet = new Set(
      waitingForReply.map((item) => item.conversationId)
    );

    let pendingSmartSuggestion: AttentionItem[] = [];

    if (openIds.length > 0) {
      const pendingSuggestions = await prisma.replySuggestion.findMany({
        where: {
          businessId,
          conversationId: { in: openIds },
          status: { in: PENDING_SUGGESTION_STATUSES },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          conversationId: true,
          text: true,
          createdAt: true,
        },
      });

      const seenConv = new Set<number>();
      const picked: typeof pendingSuggestions = [];
      for (const s of pendingSuggestions) {
        if (waitingIdSet.has(s.conversationId)) {
          continue;
        }
        if (seenConv.has(s.conversationId)) {
          continue;
        }
        seenConv.add(s.conversationId);
        picked.push(s);
        if (picked.length >= limit) {
          break;
        }
      }

      const convIdsNeeded = [...new Set(picked.map((s) => s.conversationId))];
      const convRows =
        convIdsNeeded.length > 0
          ? await prisma.conversation.findMany({
              where: {
                id: { in: convIdsNeeded },
                businessId,
                status: "OPEN",
              },
              select: {
                id: true,
                channel: true,
                status: true,
                currentStage: true,
                createdAt: true,
                customer: { select: { name: true } },
              },
            })
          : [];

      const convMap = new Map(convRows.map((c) => [c.id, c]));

      pendingSmartSuggestion = picked.flatMap((s) => {
        const conv = convMap.get(s.conversationId);
        if (!conv) {
          return [];
        }
        return [
          toAttentionItemBase(conv, {
            lastRelevantMessageText: truncateSnippet(s.text),
            reasonCode: "PENDING_SMART_SUGGESTION",
            relevantAt: s.createdAt,
            hasPendingSuggestion: false,
            priorityRank: 2,
            priorityType: "PENDING_SMART_SUGGESTION",
          }),
        ];
      });

      pendingSmartSuggestion.sort(
        (a, b) =>
          new Date(b.relevantAt).getTime() - new Date(a.relevantAt).getTime()
      );
    }

    const pendingIdSet = new Set(
      pendingSmartSuggestion.map((item) => item.conversationId)
    );
    const reservedForRecent = new Set<number>([
      ...waitingIdSet,
      ...pendingIdSet,
    ]);

    const closedConversations = await prisma.conversation.findMany({
      where: {
        businessId,
        status: "CLOSED",
        closedAt: { not: null },
      },
      orderBy: { closedAt: "desc" },
      take: limit,
      select: {
        id: true,
        channel: true,
        status: true,
        currentStage: true,
        createdAt: true,
        closedAt: true,
        customer: { select: { name: true } },
      },
    });

    const closedForResponse = closedConversations.filter(
      (c) => !reservedForRecent.has(c.id)
    );

    const closedIds = closedForResponse.map((c) => c.id);

    let lastMessageSnippetByClosedId = new Map<number, string | null>();

    if (closedIds.length > 0) {
      const msgsForClosed = await prisma.message.findMany({
        where: {
          businessId,
          conversationId: { in: closedIds },
        },
        orderBy: { createdAt: "desc" },
        select: {
          conversationId: true,
          contentText: true,
          createdAt: true,
        },
      });
      const lastMsgMap = pickLatestMessagePerConversation(msgsForClosed);
      lastMessageSnippetByClosedId = new Map(
        [...lastMsgMap.entries()].map(([id, m]) => [
          id,
          truncateSnippet(m.contentText),
        ])
      );
    }

    const recentlyHandled: AttentionItem[] = closedForResponse.map((conv) => {
      const closedAt = conv.closedAt as Date;
      return toAttentionItemBase(conv, {
        lastRelevantMessageText:
          lastMessageSnippetByClosedId.get(conv.id) ?? null,
        reasonCode: "RECENTLY_HANDLED",
        relevantAt: closedAt,
        hasPendingSuggestion: false,
        priorityRank: 3,
        priorityType: "RECENTLY_HANDLED",
      });
    });

    return NextResponse.json({
      success: true,
      generatedAt: new Date().toISOString(),
      businessId,
      waitingForReply,
      pendingSmartSuggestion,
      recentlyHandled,
    });
  } catch (error: unknown) {
    console.error("GET /api/inbox/attention error:", error);

    const details =
      error instanceof Error ? error.message : String(error);

    return NextResponse.json(
      {
        error: "Failed to load attention inbox",
        details,
      },
      { status: 500 }
    );
  }
}
