/**
 * The ONE way an inbound customer message becomes Customer + Conversation +
 * Message.
 *
 * Callers:
 *   - the Business Intake processor, for a provider-authenticated WhatsApp event
 *     (lib/intake/whatsapp/whatsapp-intake.processor.ts);
 *   - the local-development simulator (app/api/dev/simulate-inbound), which is
 *     refused in production.
 * `/api/message` is NOT a caller: a signed-in user can only write business
 * messages, never a customer's.
 *
 * WHAT IT GUARANTEES
 *
 *   1. Serialised per sender. `pg_advisory_xact_lock` on (business, canonical
 *      phone) is taken before anything is read, so two first messages from a new
 *      number arriving together cannot both miss the Customer and race to create
 *      it (the second used to die on Customer_businessId_phone_key and its
 *      message was lost), nor both create an OPEN conversation.
 *   2. Idempotent on the provider's id. A redelivered or retried event finds its
 *      Message and returns it — no second Customer, Conversation or Message.
 *   3. Customer stays the contact record. A new sender becomes a Customer named
 *      after their WhatsApp profile name when the provider sent one, else after
 *      their number (the pre-M2 behaviour). A placeholder name (the number
 *      itself) is upgraded to the profile name later; a name the owner set is
 *      never overwritten.
 *   4. No Lead is created here. A message is not a lead.
 *   5. Conversation activity (timestamps, unanswered count) is recorded through
 *      the shared, replay-safe writer — independent of
 *      CONVERSATION_STATE_WRITER_ENABLED.
 *
 * Everything runs in ONE tenant transaction. No external I/O happens inside it.
 */

import { createHash } from "node:crypto";
import type { Conversation, ConversationChannel, Customer, Message } from "@prisma/client";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";
import { recordConversationActivity } from "@/lib/conversation-state/conversation-activity";

/**
 * Advisory namespace for inbound-sender serialisation. Its own two-integer
 * space ('IS'), so it never waits on the lifecycle ('AD') or document-content
 * ('DC') locks.
 */
export const INBOUND_SENDER_ADVISORY_NAMESPACE = 0x49_53;

/**
 * Lock key for one business's one sender. Both go in, so two businesses never
 * serialise on the same phone. A 32-bit fold can collide; a collision costs a
 * little waiting and never correctness, because every query under the lock is
 * scoped by businessId and phone.
 */
export function inboundSenderLockKey(businessId: number, canonicalPhone: string): number {
  return createHash("sha256").update(`${businessId}:${canonicalPhone}`).digest().readInt32BE(0);
}

export async function lockInboundSender(
  tx: TenantTx,
  businessId: number,
  canonicalPhone: string
): Promise<void> {
  const key = inboundSenderLockKey(businessId, canonicalPhone);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INBOUND_SENDER_ADVISORY_NAMESPACE}::int, ${key}::int)`;
}

/** Maximum stored length of a provider profile name. */
const PROFILE_NAME_MAX = 200;

export function cleanProfileName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Collapse whitespace, strip control characters, bound the length.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, PROFILE_NAME_MAX);
}

export type InboundCustomerMessageInput = {
  businessId: number;
  channel: Extract<ConversationChannel, "WHATSAPP">;
  /** Sender identity as the provider gave it (digits). Canonicalised here. */
  senderPhone: string;
  /** Provider message id (WhatsApp wamid). Null only for the dev simulator. */
  providerMessageId: string | null;
  /** Idempotency token for callers without a provider id (dev simulator). */
  clientRequestId?: string | null;
  /** Message text. Null for a non-text message recorded as a placeholder. */
  text: string | null;
  /** Provider message type ("text", "image", ...). */
  messageType: string;
  /** When the provider says it was sent. Null → now. */
  occurredAt: Date | null;
  /** Provider display name (WhatsApp contacts[].profile.name). */
  profileName: string | null;
};

export type InboundCustomerMessageOutcome =
  | { status: "invalid_sender" }
  | {
      status: "ingested";
      /** True when this call found the message already stored (replay / retry). */
      alreadyExisted: boolean;
      message: Message;
      conversation: Conversation;
      customer: Customer;
      customerWasCreated: boolean;
      conversationWasCreated: boolean;
    };

export async function ingestInboundCustomerMessage(
  input: InboundCustomerMessageInput
): Promise<InboundCustomerMessageOutcome> {
  const canonicalPhone = normalizeCustomerPhone(input.senderPhone);
  if (!canonicalPhone) return { status: "invalid_sender" };
  const profileName = cleanProfileName(input.profileName);

  return withTenantTransaction(async (tx) => {
    await lockInboundSender(tx, input.businessId, canonicalPhone);

    // ── idempotency: the provider's id (or the caller's token) ─────────────
    const existing = await findExistingMessage(tx, input);
    if (existing) {
      const [conversation, customer] = await Promise.all([
        tx.conversation.findFirstOrThrow({
          where: { id: existing.conversationId, businessId: input.businessId },
        }),
        // The customer the message was stored against — not a fresh phone
        // lookup, which would miss if the number was edited since.
        tx.customer.findFirstOrThrow({
          where: { id: existing.customerId ?? -1, businessId: input.businessId },
        }),
      ]);
      return {
        status: "ingested" as const,
        alreadyExisted: true,
        message: existing,
        conversation,
        customer,
        customerWasCreated: false,
        conversationWasCreated: false,
      };
    }

    // ── customer (the contact record) ─────────────────────────────────────
    let customer = await tx.customer.findUnique({
      where: { businessId_phone: { businessId: input.businessId, phone: canonicalPhone } },
    });
    let customerWasCreated = false;
    if (!customer) {
      customer = await tx.customer.create({
        data: {
          businessId: input.businessId,
          name: profileName ?? canonicalPhone,
          phone: canonicalPhone,
        },
      });
      customerWasCreated = true;
    } else if (profileName && isPlaceholderName(customer)) {
      // The number was standing in for a name nobody had given. The provider
      // has now told us one; the owner has not — so it may replace the number.
      await tx.customer.updateMany({
        where: { id: customer.id, businessId: input.businessId, name: customer.name },
        data: { name: profileName },
      });
      customer = { ...customer, name: profileName };
    }

    // ── conversation ──────────────────────────────────────────────────────
    let conversation = await tx.conversation.findFirst({
      where: {
        businessId: input.businessId,
        customerId: customer.id,
        channel: input.channel,
        status: "OPEN",
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    });
    let conversationWasCreated = false;
    if (!conversation) {
      conversation = await tx.conversation.create({
        data: {
          businessId: input.businessId,
          customerId: customer.id,
          channel: input.channel,
          status: "OPEN",
          startedAt: new Date(),
        },
      });
      conversationWasCreated = true;
    }

    // M5.5 — a customer this inbound message brought into existence. The
    // integration did it, not the owner. Same tx: no event without its customer.
    if (customerWasCreated) {
      await recordSensor(
        {
          businessId: input.businessId,
          sensor: "CUSTOMER_CREATED",
          entityId: customer.id,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          payload: { origin: "WHATSAPP", conversationId: conversation.id },
          idempotencyKey: `customer:${customer.id}:created`,
        },
        { tx }
      );
    }

    // ── the message ───────────────────────────────────────────────────────
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        businessId: input.businessId,
        customerId: customer.id,
        channel: input.channel,
        direction: "INBOUND",
        senderType: "CUSTOMER",
        messageType: input.messageType,
        contentText: input.text,
        providerMessageId: input.providerMessageId,
        clientRequestId: input.clientRequestId ?? null,
        sentAt: input.occurredAt ?? new Date(),
      },
    });

    await recordConversationActivity(tx, message);

    const refreshed = await tx.conversation.findFirstOrThrow({
      where: { id: conversation.id, businessId: input.businessId },
    });

    return {
      status: "ingested" as const,
      alreadyExisted: false,
      message,
      conversation: refreshed,
      customer,
      customerWasCreated,
      conversationWasCreated,
    };
  });
}

/** A customer whose name is still just their number. */
function isPlaceholderName(customer: Pick<Customer, "name" | "phone">): boolean {
  const name = customer.name.replace(/\D/g, "");
  return name.length > 0 && customer.phone !== null && name === customer.phone.replace(/\D/g, "");
}

async function findExistingMessage(
  tx: TenantTx,
  input: InboundCustomerMessageInput
): Promise<Message | null> {
  if (input.providerMessageId) {
    return tx.message.findFirst({
      where: { businessId: input.businessId, providerMessageId: input.providerMessageId },
    });
  }
  if (input.clientRequestId) {
    return tx.message.findFirst({
      where: { businessId: input.businessId, clientRequestId: input.clientRequestId },
    });
  }
  return null;
}
