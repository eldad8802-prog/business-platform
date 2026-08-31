/**
 * Conversation intake for inbound WhatsApp text messages.
 *
 * # Pipeline
 *
 *   1. Idempotency check by `Message.providerMessageId` (wamid). If a
 *      message with this wamid already exists for this business, return
 *      `{ status: "skipped_duplicate" }`. This protects against Meta
 *      webhook retries when our processing exceeded the response window.
 *
 *   2. Phone normalization → canonical form via `normalizeCustomerPhone`.
 *      A null result here means the webhook gave us an unusable `from`
 *      digits string; return `{ status: "skipped_invalid_sender" }`.
 *
 *   3. Customer resolution — upsert via the
 *      `(businessId, phone)` compound unique index. The upsert path is
 *      race-safe by design.
 *
 *   4. Conversation reuse — find the most recently-active OPEN WhatsApp
 *      conversation for this customer; create one when none exists.
 *      Closed conversations are NOT reused (closing is an explicit "this
 *      is done" signal from the owner).
 *
 *   5. Persist inbound `Message`:
 *        direction = INBOUND
 *        senderType = CUSTOMER
 *        channel = WHATSAPP
 *        contentText = trimmed text
 *        providerMessageId = wamid
 *      In the same step, update conversation lastMessageAt /
 *      customerLastInboundAt / unansweredInboundCount so the 24h send
 *      guard has correct data when the owner replies.
 *
 *   6. Hand off to the shared `runInboundMessagePipeline` — analysis,
 *      bot policy, starter-bot draft, suggestion outcome update.
 *
 * # Idempotency rule
 *
 *   Wamid is unique-per-(business, message) at the Meta level. We don't
 *   yet have a DB-level uniqueness constraint on `Message.providerMessageId`
 *   (would require a partial-index migration). For Bot-MVP-1 we rely on a
 *   findFirst + early-return pre-check; a future sprint can promote this
 *   to a DB constraint.
 *
 * # TODO future policy hook
 *
 *   MAX_CONVERSATION_IDLE_DAYS — when set, an OPEN conversation older than
 *   N days would not be reused (instead a fresh conversation is created).
 *   Intentionally NOT implemented in Bot-MVP-1; reuse is unconditional
 *   while status === OPEN. Discussion: continuity vs. context drift after
 *   long idle.
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { Conversation, Customer, Message } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";

type Db = Prisma.TransactionClient | typeof prisma;
import { normalizeCustomerPhone } from "./phone";
import {
  logEvent,
  maskSenderForLog,
  wamidPrefixForLog,
} from "./webhook-events";
import { runInboundMessagePipeline } from "@/lib/services/conversation/inbound-message-pipeline.service";

export type WhatsAppConversationIntakeInput = {
  businessId: number;
  phoneNumberId: string;
  /** Raw digits-only sender from the webhook, pre-canonicalization. */
  senderPhone: string;
  /** Meta message id (`wamid`). */
  wamid: string;
  /** Trimmed customer text body, guaranteed non-empty. */
  text: string;
};

export type WhatsAppConversationIntakeOutcome =
  | { status: "skipped_duplicate"; messageId: number }
  | { status: "skipped_invalid_sender" }
  | { status: "failed"; reason: string }
  | {
      status: "intaken";
      messageId: number;
      conversationId: number;
      customerId: number;
      conversationWasCreated: boolean;
      customerWasCreated: boolean;
      starterBotDraftCreated: boolean;
    };

/**
 * Per-customer idempotency: have we already stored a message with this
 * wamid for this business? Scoped by businessId so two unrelated
 * businesses receiving the same hypothetical wamid would not collide.
 */
async function findExistingByWamid(
  db: Db,
  businessId: number,
  wamid: string
): Promise<Message | null> {
  return db.message.findFirst({
    where: { businessId, providerMessageId: wamid },
    select: {
      id: true,
      conversationId: true,
      businessId: true,
      customerId: true,
      channel: true,
      direction: true,
      senderType: true,
      messageType: true,
      contentText: true,
      languageCode: true,
      intentLabel: true,
      intentConfidence: true,
      sentimentLabel: true,
      sentimentScore: true,
      objectionLabel: true,
      objectionConfidence: true,
      stageLabel: true,
      urgencyScore: true,
      leadScoreSnapshot: true,
      generatedFromSuggestionId: true,
      recommendationId: true,
      wasEditedBeforeSend: true,
      replyLatencySec: true,
      gotReplyWithin24h: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      sendStatus: true,
      providerMessageId: true,
      clientRequestId: true,
      sendErrorCode: true,
      sendErrorMessage: true,
      sendAttemptedAt: true,
      createdAt: true,
    },
  });
}

async function upsertCustomer(
  db: Db,
  businessId: number,
  normalizedPhone: string
): Promise<{ customer: Customer; created: boolean }> {
  const existing = await db.customer.findUnique({
    where: { businessId_phone: { businessId, phone: normalizedPhone } },
  });
  if (existing) {
    return { customer: existing, created: false };
  }
  const customer = await db.customer.create({
    data: {
      businessId,
      name: normalizedPhone,
      phone: normalizedPhone,
    },
  });
  return { customer, created: true };
}

async function findOrCreateOpenConversation(args: {
  db: Db;
  businessId: number;
  customerId: number;
}): Promise<{ conversation: Conversation; created: boolean }> {
  const { db, businessId, customerId } = args;

  // Reuse rule: most-recently-active OPEN WhatsApp conversation.
  // Closed/Archived → create new (explicit lifecycle reset by owner).
  // Future hook: MAX_CONVERSATION_IDLE_DAYS — not implemented in MVP-1.
  const existing = await db.conversation.findFirst({
    where: {
      businessId,
      customerId,
      channel: "WHATSAPP",
      status: "OPEN",
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
  });

  if (existing) return { conversation: existing, created: false };

  const created = await db.conversation.create({
    data: {
      businessId,
      customerId,
      channel: "WHATSAPP",
      status: "OPEN",
      startedAt: new Date(),
    },
  });
  return { conversation: created, created: true };
}

export async function processWhatsAppConversationIntake(
  input: WhatsAppConversationIntakeInput
): Promise<WhatsAppConversationIntakeOutcome> {
  logEvent("INBOUND_WHATSAPP_RECEIVED", {
    source: "webhook",
    businessId: input.businessId,
    phoneNumberId: input.phoneNumberId,
    senderMasked: maskSenderForLog(input.senderPhone),
    wamidPrefix: wamidPrefixForLog(input.wamid),
    textLength: input.text.length,
  });

  // ── Step 2: canonicalize sender phone ─────────────────────────────────
  const normalizedPhone = normalizeCustomerPhone(input.senderPhone);
  if (!normalizedPhone) {
    return { status: "skipped_invalid_sender" };
  }

  try {
    // D2/P7-W4A Phase A: dedup + customer + conversation + message
    // persistence run on ONE tenant transaction (GUC-carrying, established
    // from the explicit runTenantJob context set by the webhook). The shared
    // pipeline (Phase B/C — analysis, bot policy, optional LLM call)
    // deliberately runs AFTER the transaction: no external I/O ever executes
    // while the tenant transaction is held.
    const persisted = await withTenantTransaction(async (tx) => {
      // ── Step 1: wamid idempotency (advisory pre-check; the DB-level
      // (businessId, providerMessageId) unique is the real guarantee) ─────
      const existing = await findExistingByWamid(
        tx,
        input.businessId,
        input.wamid
      );
      if (existing) {
        return { kind: "duplicate" as const, messageId: existing.id };
      }

      // ── Step 3: customer ───────────────────────────────────────────────
      const { customer, created: customerWasCreated } = await upsertCustomer(
        tx,
        input.businessId,
        normalizedPhone
      );

      // ── Step 4: conversation ───────────────────────────────────────────
      const { conversation, created: conversationWasCreated } =
        await findOrCreateOpenConversation({
          db: tx,
          businessId: input.businessId,
          customerId: customer.id,
        });

      // ── Step 5: persist inbound Message + update conversation counters ─
      const now = new Date();
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          businessId: input.businessId,
          customerId: customer.id,
          channel: "WHATSAPP",
          direction: "INBOUND",
          senderType: "CUSTOMER",
          messageType: "text",
          contentText: input.text,
          providerMessageId: input.wamid,
          sentAt: now,
        },
      });

      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: now,
          customerLastInboundAt: now,
          unansweredInboundCount: { increment: 1 },
        },
      });

      return {
        kind: "intaken" as const,
        customer,
        customerWasCreated,
        conversation,
        conversationWasCreated,
        message,
      };
    });

    if (persisted.kind === "duplicate") {
      return { status: "skipped_duplicate", messageId: persisted.messageId };
    }

    const {
      customer,
      customerWasCreated,
      conversation,
      conversationWasCreated,
      message,
    } = persisted;
    logEvent("CUSTOMER_RESOLVED", {
      source: "webhook",
      businessId: input.businessId,
      customerId: customer.id,
      created: customerWasCreated,
    });
    logEvent("CONVERSATION_RESOLVED", {
      source: "webhook",
      businessId: input.businessId,
      conversationId: conversation.id,
      customerId: customer.id,
      created: conversationWasCreated,
    });

    // Re-read the updated conversation so the pipeline sees the freshest
    // counters (some downstream helpers compare against
    // `customerLastInboundAt`).
    const refreshedConversation = await withTenantTransaction((tx) =>
      tx.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
      })
    );

    // ── Step 6: shared pipeline (analysis + bot policy + drafts) — outside
    // any transaction (may call an LLM provider) ─────────────────────────
    const pipelineResult = await runInboundMessagePipeline({
      conversation: refreshedConversation,
      message,
      businessId: input.businessId,
      source: "webhook",
    });

    return {
      status: "intaken",
      messageId: message.id,
      conversationId: conversation.id,
      customerId: customer.id,
      conversationWasCreated,
      customerWasCreated,
      starterBotDraftCreated: pipelineResult.starterBotDraftCreated,
    };
  } catch (err) {
    // Concurrency-safe replay: when two deliveries of the same wamid race,
    // both pass the advisory pre-check and the (businessId, providerMessageId)
    // unique aborts the second transaction. Resolve it as the duplicate it is.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await withTenantTransaction((tx) =>
        findExistingByWamid(tx, input.businessId, input.wamid)
      );
      if (existing) {
        return { status: "skipped_duplicate", messageId: existing.id };
      }
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[whatsapp-conversation-intake] failed:", reason);
    return { status: "failed", reason };
  }
}

/**
 * Structured log payload for the webhook handler so each branch logs the
 * same shape regardless of outcome.
 */
export function intakeOutcomeLogFields(
  businessId: number,
  wamid: string,
  outcome: WhatsAppConversationIntakeOutcome
): Record<string, unknown> {
  const base = {
    businessId,
    wamidPrefix: wamidPrefixForLog(wamid),
    status: outcome.status,
  };
  if (outcome.status === "intaken") {
    return {
      ...base,
      conversationId: outcome.conversationId,
      customerId: outcome.customerId,
      starterBotDraftCreated: outcome.starterBotDraftCreated,
      conversationWasCreated: outcome.conversationWasCreated,
      customerWasCreated: outcome.customerWasCreated,
    };
  }
  if (outcome.status === "skipped_duplicate") {
    return { ...base, messageId: outcome.messageId };
  }
  if (outcome.status === "failed") {
    return { ...base, reason: outcome.reason.slice(0, 200) };
  }
  return base;
}
