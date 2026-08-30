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

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import {
  evaluateLeadFollowUp,
  leadNeedsAttention,
  type LeadFollowUpState,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";

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
      select: {
        id: true,
        channel: true,
        status: true,
        startedAt: true,
        lastMessageAt: true,
      },
    }),
    db.conversation.count({ where: conversationWhere }),
  ]);

  const status = lead.status as LeadStatusValue;

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
  };
}
