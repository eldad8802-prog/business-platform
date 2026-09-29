/**
 * Business Intake · WhatsApp — the first source adapter.
 *
 *   webhook (signature verified, tenant resolved by the routing gate)
 *     → buildMessageReceipt / buildStatusReceipt     (pure)
 *     → recordReceipts                               (durable; THEN the 200)
 *     → drainWhatsAppIntake → processIntakeEvent     (after the response, and
 *                                                      again by the sweeper)
 *
 * The adapter never writes Customer / Conversation / Message itself. A customer
 * message goes through `ingestInboundCustomerMessage` (the one canonical path)
 * and then `runInboundMessagePipeline`; media goes to the existing documents
 * intake; a delivery / read / failed receipt only ever updates the OUTBOUND
 * message it describes.
 *
 * Every function here requires an established tenant context (the webhook and
 * the sweeper wrap calls in `runTenantJob`). Nothing reads a businessId from a
 * payload: it is always the server-resolved one the caller passes in.
 */

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import {
  claimEvent,
  errorCodeOf,
  listDueEventIds,
  markDeferred,
  markFailed,
  markIgnored,
  markPersisted,
  markProcessed,
  type ClaimedEvent,
  type IntakeReceiptInput,
} from "@/lib/intake/intake-event.store";
import { ingestInboundCustomerMessage } from "@/lib/services/conversation/inbound-customer-message.service";
import { runInboundMessagePipeline } from "@/lib/services/conversation/inbound-message-pipeline.service";
import { syncInboxWaitingNotifications } from "@/lib/notifications/inbox-waiting-notifications";
import { processWhatsAppDocumentsIntake } from "@/lib/services/integrations/whatsapp/documents-intake.service";
import type { RoutingDecision } from "@/lib/services/integrations/whatsapp/routing.types";
import type {
  WhatsAppReferralSummary,
  WhatsAppWebhookMessageSummary,
  WhatsAppWebhookStatusSummary,
} from "@/lib/services/integrations/whatsapp/types";

// ─── payload contract (v1) ─────────────────────────────────────────────────
//
// The minimal envelope needed to process the event. Personal data (sender
// number, text, profile name) lives ONLY here, and only until the event is
// processed — the store purges it on PROCESSED / IGNORED.

export type WhatsAppMessagePayloadV1 =
  | {
      v: 1;
      route: "CONVERSATION";
      wamid: string;
      senderPhone: string;
      text: string;
      messageType: string;
      profileName: string | null;
    }
  | {
      v: 1;
      route: "DOCUMENTS";
      wamid: string;
      phoneNumberId: string;
      sender: string;
      mediaType: "image" | "document";
      mediaId: string;
      senderTrust: "allowlist" | "conversation";
    }
  | {
      v: 1;
      route: "UNSUPPORTED";
      wamid: string;
      reason: string;
      messageType: string;
    };

export type WhatsAppStatusPayloadV1 = {
  v: 1;
  route: "STATUS";
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode: string | null;
};

type WhatsAppPayload = WhatsAppMessagePayloadV1 | WhatsAppStatusPayloadV1;

const KNOWN_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** Meta's unix-seconds timestamp → Date, or null when absent / implausible. */
export function parseProviderTimestamp(raw: string | null | undefined, now = new Date()): Date | null {
  if (typeof raw !== "string" || !/^\d{9,11}$/.test(raw)) return null;
  const at = new Date(Number(raw) * 1000);
  // Before WhatsApp Cloud API existed, or more than a day in the future: not a
  // business time we can trust. Null is honest; a clamp would be invented.
  if (at.getTime() < Date.UTC(2015, 0, 1) || at.getTime() > now.getTime() + 86_400_000) return null;
  return at;
}

/**
 * The receipt's replay key: a SHA-256 of the provider's event identity, never
 * the raw wamid. Deterministic, so a redelivery still dedupes; but the receipt
 * does not itself hold the value that reconnects to the live WhatsApp thread.
 * The raw wamid lives on `Message.providerMessageId` (the domain record, which
 * account erasure nulls) and in the payload until it is purged.
 */
export function receiptKey(providerIdentity: string): string {
  return `sha256:${createHash("sha256").update(providerIdentity, "utf8").digest("hex")}`;
}

/** Non-personal facts kept after the payload is purged. */
function messageMetadata(
  messageType: string,
  referral: WhatsAppReferralSummary | null
): Prisma.InputJsonValue {
  return referral ? { messageType, referral } : { messageType };
}

/**
 * The receipt for one customer message. `decision` must come from the routing
 * gate (it carries the server-resolved businessId); STOP decisions have no
 * receipt.
 */
export function buildMessageReceipt(
  decision: Exclude<RoutingDecision, { kind: "STOP" }>,
  message: WhatsAppWebhookMessageSummary
): IntakeReceiptInput {
  const messageType = message.type?.trim().toLowerCase() ?? "";
  let payload: WhatsAppMessagePayloadV1;
  if (decision.kind === "CONVERSATION_INTAKE") {
    payload = {
      v: 1,
      route: "CONVERSATION",
      wamid: decision.wamid,
      senderPhone: decision.senderPhone,
      text: decision.text,
      messageType: "text",
      profileName: message.profileName,
    };
  } else if (decision.kind === "DOCUMENTS_INTAKE") {
    payload = {
      v: 1,
      route: "DOCUMENTS",
      wamid: decision.wamid,
      phoneNumberId: decision.phoneNumberId,
      sender: decision.sender,
      mediaType: decision.mediaType,
      mediaId: decision.mediaId,
      senderTrust: decision.senderTrust,
    };
  } else {
    payload = {
      v: 1,
      route: "UNSUPPORTED",
      wamid: decision.wamid,
      reason: decision.reason,
      messageType: decision.messageType,
    };
  }
  return {
    provider: "WHATSAPP",
    kind: "MESSAGE_RECEIVED",
    externalEventId: receiptKey(decision.wamid),
    providerAccountRef: decision.phoneNumberId,
    occurredAt: parseProviderTimestamp(message.timestamp),
    payload,
    metadata: messageMetadata(messageType, message.referral),
  };
}

/**
 * The receipt for one delivery / read / failed status, or null when Meta sent
 * something we cannot key (no wamid, unknown status). The key includes the
 * status because one outbound message legitimately produces several.
 */
export function buildStatusReceipt(
  status: WhatsAppWebhookStatusSummary,
  phoneNumberId: string
): IntakeReceiptInput | null {
  const wamid = status.wamid?.trim();
  const value = status.status?.trim().toLowerCase();
  if (!wamid || !value || !KNOWN_STATUSES.has(value)) return null;
  const payload: WhatsAppStatusPayloadV1 = {
    v: 1,
    route: "STATUS",
    wamid,
    status: value as WhatsAppStatusPayloadV1["status"],
    errorCode: status.errorCode,
  };
  return {
    provider: "WHATSAPP",
    kind: "MESSAGE_STATUS",
    externalEventId: receiptKey(`${wamid}:${value}`),
    providerAccountRef: phoneNumberId,
    occurredAt: parseProviderTimestamp(status.timestamp),
    payload,
    metadata: { status: value },
  };
}

// ─── processing ────────────────────────────────────────────────────────────

export type IntakeProcessResult =
  | "not_claimed"
  | "processed"
  | "ignored"
  | "deferred"
  | "failed";

function readPayload(event: ClaimedEvent): WhatsAppPayload | null {
  const p = event.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.v !== 1 || typeof p.route !== "string") return null;
  return p as unknown as WhatsAppPayload;
}

/**
 * Process ONE receipt: claim it, materialise it, record the outcome. Never
 * throws for a processing failure — the failure is recorded on the receipt and
 * retried on its backoff. Returns what happened.
 */
export async function processIntakeEvent(
  businessId: number,
  eventId: number,
  now: Date = new Date()
): Promise<IntakeProcessResult> {
  const event = await claimEvent(businessId, eventId, now);
  if (!event) return "not_claimed";

  let status = event.status;
  try {
    const payload = readPayload(event);
    if (!payload) {
      // Purged or malformed: nothing left to act on, and retrying cannot help.
      await markIgnored(businessId, event.id, "payload_unavailable");
      return "ignored";
    }

    switch (payload.route) {
      case "UNSUPPORTED": {
        await markIgnored(businessId, event.id, `unsupported:${payload.reason}`);
        return "ignored";
      }

      case "STATUS": {
        const applied = await applyOutboundStatus(businessId, payload, event.occurredAt ?? now);
        if (applied === null) {
          await markIgnored(businessId, event.id, "unknown_outbound_message");
          return "ignored";
        }
        await markProcessed(businessId, event.id, {
          messageId: applied.messageId,
          conversationId: applied.conversationId,
        });
        return "processed";
      }

      case "DOCUMENTS": {
        const gate = await checkRateLimit({ bucket: "WHATSAPP_INTAKE", business: businessId });
        if (!gate.allowed) {
          // Deferred, not dropped (M1 W11): the receipt waits and is retried.
          const until = new Date(now.getTime() + Math.max(gate.retryAfterSeconds ?? 60, 30) * 1000);
          await markDeferred(businessId, event, until, "throttled");
          return "deferred";
        }
        const outcome = await processWhatsAppDocumentsIntake({
          businessId,
          phoneNumberId: payload.phoneNumberId,
          sender: payload.sender,
          wamid: payload.wamid,
          mediaType: payload.mediaType,
          mediaId: payload.mediaId,
        });
        if (outcome.status === "failed") {
          // The documents subsystem recorded this failure on its own import row;
          // a blind retry would meet its wamid dedup. Kept visible, not retried.
          await markIgnored(businessId, event.id, `documents_failed:${outcome.reason}`);
          return "ignored";
        }
        await markProcessed(businessId, event.id);
        return "processed";
      }

      case "CONVERSATION": {
        const ingested = await ingestInboundCustomerMessage({
          businessId,
          channel: "WHATSAPP",
          senderPhone: payload.senderPhone,
          providerMessageId: payload.wamid,
          text: payload.text,
          messageType: payload.messageType,
          occurredAt: event.occurredAt,
          profileName: payload.profileName,
        });
        if (ingested.status === "invalid_sender") {
          await markIgnored(businessId, event.id, "invalid_sender");
          return "ignored";
        }
        const refs = {
          messageId: ingested.message.id,
          conversationId: ingested.conversation.id,
          customerId: ingested.customer.id,
        };
        await markPersisted(businessId, event.id, refs);
        status = "PERSISTED";

        // Enrichment. A resumed run (the message was already stored by an
        // earlier attempt) repeats only what is safe to repeat.
        await runInboundMessagePipeline({
          conversation: ingested.conversation,
          message: ingested.message,
          businessId,
          source: "webhook",
          resume: ingested.alreadyExisted || event.status === "PERSISTED",
        });
        await syncInboxWaitingNotifications(businessId, ingested.conversation.id, new Date());

        await markProcessed(businessId, event.id, refs);
        return "processed";
      }
    }
  } catch (error) {
    await markFailed(businessId, { id: event.id, attempts: event.attempts, status }, errorCodeOf(error));
    console.warn("[intake] event failed", {
      businessId,
      eventId: event.id,
      attempt: event.attempts,
      code: errorCodeOf(error),
    });
    return "failed";
  }
}

/**
 * Process the named receipts, then whatever else of this business is due —
 * oldest first, one at a time (a sender's messages keep their order). Bounded,
 * so a backlog is worked down across calls rather than in one request.
 */
export async function drainWhatsAppIntake(
  businessId: number,
  options: { eventIds?: number[]; limit?: number; now?: Date } = {}
): Promise<Record<IntakeProcessResult, number>> {
  const now = options.now ?? new Date();
  const due = await listDueEventIds(businessId, now, options.limit ?? 25);
  const ids = [...new Set([...(options.eventIds ?? []), ...due])].sort((a, b) => a - b);
  const tally: Record<IntakeProcessResult, number> = {
    not_claimed: 0,
    processed: 0,
    ignored: 0,
    deferred: 0,
    failed: 0,
  };
  for (const id of ids) {
    tally[await processIntakeEvent(businessId, id, now)] += 1;
  }
  return tally;
}

// ─── delivery / read / failed receipts ─────────────────────────────────────

/**
 * Apply a provider status to the OUTBOUND message it describes. Never creates a
 * message. Monotonic: a late "delivered" never erases a "read", and a "failed"
 * after the customer already received the message is not believed.
 *
 * Returns null when no outbound message of this business has that wamid.
 */
export async function applyOutboundStatus(
  businessId: number,
  payload: WhatsAppStatusPayloadV1,
  at: Date
): Promise<{ messageId: number; conversationId: number } | null> {
  return withTenantTransaction(async (tx) => {
    const message = await tx.message.findFirst({
      where: { businessId, providerMessageId: payload.wamid, direction: "OUTBOUND" },
      select: {
        id: true,
        conversationId: true,
        sendStatus: true,
        deliveredAt: true,
        readAt: true,
      },
    });
    if (!message) return null;

    const data: Prisma.MessageUpdateManyMutationInput = {};
    switch (payload.status) {
      case "sent":
        if (message.sendStatus === null || message.sendStatus === "PENDING") data.sendStatus = "SENT";
        break;
      case "delivered":
        if (!message.deliveredAt) data.deliveredAt = at;
        if (message.sendStatus !== "SENT") data.sendStatus = "SENT";
        break;
      case "read":
        if (!message.readAt) data.readAt = at;
        if (!message.deliveredAt) data.deliveredAt = at;
        if (message.sendStatus !== "SENT") data.sendStatus = "SENT";
        break;
      case "failed":
        // Meta does not fail a message it already delivered; if it appears to,
        // the earlier delivery is the fact.
        if (!message.deliveredAt && !message.readAt) {
          data.sendStatus = "FAILED";
          data.sendErrorCode = `meta:${payload.errorCode ?? "unknown"}`.slice(0, 64);
        }
        break;
    }
    if (Object.keys(data).length > 0) {
      await tx.message.updateMany({ where: { id: message.id, businessId }, data });
    }
    return { messageId: message.id, conversationId: message.conversationId };
  });
}
