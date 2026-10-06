/**
 * Lead Card read-model — one tenant-scoped aggregation of what a lead REALLY
 * has. It invents nothing: every field maps to an existing row, and the only
 * computed values are the follow-up state and `needsAttention`, both derived at
 * read time by the pure functions in `lead-core.ts`.
 *
 * Mirrors `customer-card.read-model.ts`: double-scoped queries (`businessId` AND
 * the entity id), Dates serialized to ISO, a bounded `take` per relation.
 *
 * CUSTOMER CONTINUITY: the card does NOT copy notes, files or conversation
 * identity onto the lead. Notes and attachments are served by the generic CRM
 * subject engines (subjectType `LEAD`), and conversations are READ through the
 * relations that already exist — nothing is duplicated into Lead storage.
 */

import { lastUnreturnedCallByLead } from "@/lib/services/calls/call-attention";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import {
  evaluateLeadFollowUp,
  leadNeedsAttention,
  type LeadFollowUpState,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";
import {
  evaluateLeadAttention,
  leadAttentionReasonLabel,
  leadAttentionSummary,
  type LeadEvidenceClass,
} from "@/lib/services/crm/lead-attention";
import {
  LEAD_NEXT_ACTION_LABELS,
  isLeadNextActionKind,
  suggestionDueAt,
  type LeadSuggestion,
} from "@/lib/services/crm/lead-lifecycle-core";
import {
  dismissedSuggestionRules,
  getLeadLifecycleHistory,
  lastCustomerInboundByLead,
  openIdentityProposalCounts,
  type LeadLifecycleHistoryItem,
} from "@/lib/services/crm/lead-lifecycle.service";
import { PENDING_SUGGESTION_STATUSES } from "@/lib/inbox-view/inbox-item.serializer";
import {
  deriveLeadConversationIntelligence,
  evaluateLeadPriority,
  type LeadConversationIntelligence,
  type LeadPriority,
} from "@/lib/services/crm/lead-intelligence";

type CardTx = Prisma.TransactionClient;

const RELATION_TAKE = 20;

export type LeadCardLead = {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  status: LeadStatusValue;
  sourceChannel: string | null;
  intentSnapshot: string | null;
  followUpNote: string | null;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  closedAt: string | null;
  lostReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** M5 — send back as `expectedVersion` on a lifecycle write (stale protection). */
  lifecycleVersion: number;
  /** M5 — what the open next action is (null for a pre-M5 follow-up or none). */
  nextActionKind: string | null;
  nextActionLabel: string | null;
  firstHandledAt: string | null;
  /** M5 — the owner's estimate / the amount agreed at WON (fixed-point strings). */
  valueEstimate: string | null;
  finalPrice: string | null;
  currency: string | null;
};

/** M5 — the lifecycle section of the card. */
export type LeadCardLifecycle = {
  /** Why the lead wants the owner, and how much that claim rests on. */
  attention: {
    reason: string | null;
    label: string | null;
    summary: string | null;
    evidenceClass: LeadEvidenceClass | null;
  };
  /** Dubiz's proposal — shown as a proposal, applied only if the owner accepts it. */
  suggestion: (LeadSuggestion & { dueAt: string }) | null;
  /** Newest first. Durable history (LeadLifecycleEvent); no personal data. */
  history: LeadLifecycleHistoryItem[];
};

export type LeadCardCustomer = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  isActive: boolean;
};

export type LeadCardConversation = {
  id: number;
  channel: string;
  status: string;
  startedAt: string;
  lastMessageAt: string | null;
};

export type LeadCardSection<T> = {
  items: T[];
  total: number;
};

export type LeadCard = {
  lead: LeadCardLead;
  /** Derived at read time — never stored. */
  followUp: LeadFollowUpState;
  /** True when this lead wants the owner right now. */
  needsAttention: boolean;
  /** The identity behind the lead, when one is linked. */
  customer: LeadCardCustomer | null;
  /**
   * Conversations reachable from this lead: linked directly (`leadId`) or
   * belonging to the linked customer. Read-only context in W1 — creating and
   * linking conversations from a lead is W3.
   */
  conversations: LeadCardSection<LeadCardConversation>;
  /** W3 — live conversation readings. Null when the lead has no conversation. */
  intelligence: LeadConversationIntelligence | null;
  /** W3 — why this lead sits where it does in the queue. */
  priority: LeadPriority;
  /** M5 — lifecycle attention, suggestion and history. */
  lifecycle: LeadCardLifecycle;
};

export type GetLeadCardInput = {
  businessId: number;
  leadId: number;
};

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError("Invalid business id");
  }
}

function normalizeLeadId(value: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError("Invalid lead id");
  }
  return parsed;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export async function getLeadCard(
  input: GetLeadCardInput,
  options?: { tx?: CardTx }
): Promise<LeadCard> {
  assertBusinessId(input.businessId);
  const leadId = normalizeLeadId(input.leadId);
  const db = options?.tx ?? prisma;
  const now = new Date();

  const lead = await db.lead.findFirst({
    where: { id: leadId, businessId: input.businessId },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          city: true,
          isActive: true,
        },
      },
    },
  });

  // Identical response whether the lead is missing or belongs to another
  // business — deliberately no cross-tenant existence disclosure.
  if (!lead) throw new NotFoundError("Lead not found");

  // Every branch of this OR is still bounded by `businessId`, so a conversation
  // from another tenant can never be reached through a borrowed customerId.
  const conversationWhere: Prisma.ConversationWhereInput = {
    businessId: input.businessId,
    OR: [
      { leadId: lead.id },
      ...(lead.customerId ? [{ customerId: lead.customerId }] : []),
    ],
  };

  const [conversations, conversationsTotal] = await Promise.all([
    db.conversation.findMany({
      where: conversationWhere,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: RELATION_TAKE,
      // The SAME query the bare list used, widened to what
      // `serializeInboxItem` needs. No extra round trip: the card already
      // fetched these rows, it just used to throw the intelligence away.
      include: {
        customer: true,
        lead: true,
        messages: {
          take: 1,
          orderBy: { createdAt: "desc" },
          select: {
            contentText: true,
            senderType: true,
            createdAt: true,
            direction: true,
            analysis: { select: { intent: true } },
          },
        },
        replySuggestions: {
          where: { status: { in: [...PENDING_SUGGESTION_STATUSES] } },
          take: 1,
          select: {
            id: true,
            status: true,
            createdAt: true,
            suggestionType: true,
          },
        },
      },
    }),
    db.conversation.count({ where: conversationWhere }),
  ]);

  const status = lead.status as LeadStatusValue;

  // W3: the conversation readings the owner needs in order to decide. Derived
  // read-time from rows already in hand, through the SAME serializer the Inbox
  // uses. Nothing here writes, and nothing here touches `lead.status` — the
  // stage a conversation reports is evidence, the status is the owner's call.
  const intelligence = deriveLeadConversationIntelligence({ conversations, now });
  // M5 — the same lifecycle facts the attention loader reads, for this one lead.
  const tx = db as CardTx;
  const [dismissed, proposals, inbound, history, calls] = await Promise.all([
    dismissedSuggestionRules(tx, input.businessId, [lead.id]),
    openIdentityProposalCounts(tx, input.businessId, [lead.id]),
    lastCustomerInboundByLead(tx, input.businessId, [lead.id]),
    getLeadLifecycleHistory(tx, input.businessId, lead.id, 30),
    lastUnreturnedCallByLead(tx, input.businessId, [lead.id]),
  ]);
  const attention = evaluateLeadAttention(
    {
      status,
      nextFollowUpAt: lead.nextFollowUpAt,
      createdAt: lead.createdAt,
      lastActivityAt: lead.lastActivityAt,
      lastCustomerInboundAt: inbound.get(lead.id) ?? null,
      lastUnreturnedCallAt: calls.get(lead.id) ?? null,
      openIdentityProposals: proposals.get(lead.id) ?? 0,
      dismissedRuleIds: dismissed.get(lead.id) ?? [],
    },
    now
  );
  const priority = evaluateLeadPriority({ status, attention, intelligence });

  return {
    lead: {
      id: lead.id,
      name: lead.customerName,
      phone: lead.phone,
      email: lead.email,
      status,
      sourceChannel: lead.sourceChannel,
      intentSnapshot: lead.intentSnapshot,
      followUpNote: lead.followUpNote,
      nextFollowUpAt: iso(lead.nextFollowUpAt),
      lastActivityAt: iso(lead.lastActivityAt),
      closedAt: iso(lead.closedAt),
      lostReason: lead.lostReason,
      createdAt: lead.createdAt.toISOString(),
      updatedAt: lead.updatedAt.toISOString(),
      lifecycleVersion: lead.lifecycleVersion,
      nextActionKind: lead.nextActionKind,
      nextActionLabel: isLeadNextActionKind(lead.nextActionKind)
        ? LEAD_NEXT_ACTION_LABELS[lead.nextActionKind]
        : null,
      firstHandledAt: iso(lead.firstHandledAt),
      valueEstimate: lead.valueEstimate === null ? null : lead.valueEstimate.toFixed(2),
      finalPrice: lead.finalPrice === null ? null : lead.finalPrice.toFixed(2),
      currency: lead.currency,
    },
    followUp: evaluateLeadFollowUp(lead.nextFollowUpAt, now),
    needsAttention: leadNeedsAttention(
      { status, nextFollowUpAt: lead.nextFollowUpAt },
      now
    ),
    customer: lead.customer
      ? {
          id: lead.customer.id,
          name: lead.customer.name,
          phone: lead.customer.phone,
          email: lead.customer.email,
          city: lead.customer.city,
          isActive: lead.customer.isActive,
        }
      : null,
    conversations: {
      items: conversations.map((c) => ({
        id: c.id,
        channel: c.channel,
        status: c.status,
        startedAt: c.startedAt.toISOString(),
        lastMessageAt: iso(c.lastMessageAt),
      })),
      total: conversationsTotal,
    },
    intelligence,
    priority,
    lifecycle: {
      attention: {
        reason: attention.reason,
        label: attention.reason ? leadAttentionReasonLabel(attention.reason) : null,
        summary: attention.reason ? leadAttentionSummary(attention, lead.nextFollowUpAt, now) || null : null,
        evidenceClass: attention.evidenceClass ?? null,
      },
      suggestion: attention.suggestion
        ? { ...attention.suggestion, dueAt: suggestionDueAt(attention.suggestion, now).toISOString() }
        : null,
      history,
    },
  };
}
