/**
 * Business Intake · WhatsApp — the first source adapter of the canonical core.
 *
 *   webhook (signature verified, tenant resolved by the routing gate — the
 *            adapter's trusted resolver: phone_number_id → WhatsAppConnection)
 *     → buildMessageReceipt / buildStatusReceipt     (pure; canonical drafts)
 *     → recordReceipts                               (durable; THEN the 200)
 *     → drainIntake(intakeRegistry) → core processor (after the response, and
 *        → whatsAppIntakeAdapter.normalize / route    again by the sweeper)
 *          / enrich
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

import type { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import type {
  ClaimedIntakeEvent,
  IntakeAdapter,
  IntakeReceiptDraft,
  NormalizedIntake,
  RouteResult,
} from "@/lib/intake/core/contract";
import { deriveEventIdentity, sha256Key } from "@/lib/intake/core/event-identity";
import { sanitizeAttribution } from "@/lib/intake/core/attribution";
import { normalizeContactHints } from "@/lib/intake/core/contact";
import {
  listBusinessIdsWithWhatsAppConnection,
  resolveBusinessIdByPhoneNumberId,
} from "@/lib/services/integrations/whatsapp/connection.service";
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
  // Identical to the M2 key (sha256 of the wamid), so a redelivery after the M3
  // deploy still dedupes against a receipt recorded before it.
  return sha256Key(providerIdentity);
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
): IntakeReceiptDraft {
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
  const identity = deriveEventIdentity({ providerEventId: decision.wamid });
  return {
    family: "MESSAGE",
    eventType: "message.received",
    externalEventId: identity.externalEventId,
    dedupeBasis: identity.dedupeBasis,
    legacy: { provider: "WHATSAPP", kind: "MESSAGE_RECEIVED" },
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
): IntakeReceiptDraft | null {
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
  const identity = deriveEventIdentity({ providerEventId: `${wamid}:${value}` });
  return {
    family: "MESSAGE",
    eventType: "message.status",
    externalEventId: identity.externalEventId,
    dedupeBasis: identity.dedupeBasis,
    legacy: { provider: "WHATSAPP", kind: "MESSAGE_STATUS" },
    providerAccountRef: phoneNumberId,
    occurredAt: parseProviderTimestamp(status.timestamp),
    payload,
    metadata: { status: value },
  };
}

// ─── the adapter (normalize / route / enrich) ──────────────────────────────

function readPayload(event: ClaimedIntakeEvent): WhatsAppPayload | null {
  const p = event.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.v !== 1 || typeof p.route !== "string") return null;
  return p as unknown as WhatsAppPayload;
}

/** Click-to-WhatsApp referral (kept in receipt metadata) → canonical attribution. */
function attributionFrom(event: ClaimedIntakeEvent): NormalizedIntake["attribution"] {
  const meta = event.metadata as { referral?: WhatsAppReferralSummary | null } | null;
  const ref = meta?.referral;
  if (!ref) return sanitizeAttribution({ channel: "whatsapp", provider: "whatsapp" });
  return sanitizeAttribution({
    channel: "whatsapp",
    provider: "whatsapp",
    source: ref.sourceType === "ad" ? "meta_ads" : ref.sourceType ?? undefined,
    referralSourceType: ref.sourceType ?? undefined,
    adId: ref.sourceType === "ad" ? ref.sourceId ?? undefined : undefined,
    referralSourceUrl: ref.sourceUrl ?? undefined,
    headline: ref.headline ?? undefined,
    clickId: ref.ctwaClid ?? undefined,
  });
}

/** What the WhatsApp route produces for the enrich step. */
type ConversationContext = {
  conversation: Parameters<typeof runInboundMessagePipeline>[0]["conversation"];
  message: Parameters<typeof runInboundMessagePipeline>[0]["message"];
};

/**
 * The WhatsApp source adapter. Route semantics are exactly M2's:
 *   CONVERSATION → the one canonical inbound path (ingestInboundCustomerMessage),
 *                  then the inbound pipeline as enrichment (resume-safe);
 *   STATUS       → updates only the OUTBOUND message it names;
 *   DOCUMENTS    → the documents intake (stays authoritative for documents);
 *   UNSUPPORTED  → understood, deliberately not materialised.
 * A WhatsApp message is never a Lead.
 */
export const whatsAppIntakeAdapter: IntakeAdapter = {
  sourceKey: "whatsapp",
  families: ["MESSAGE"],
  normalizerVersion: "whatsapp@1",

  resolveTenant: (phoneNumberId) => resolveBusinessIdByPhoneNumberId(phoneNumberId),
  listTenants: () => listBusinessIdsWithWhatsAppConnection(),

  normalize(event) {
    const payload = readPayload(event);
    if (!payload) return { ok: false, code: "malformed_payload" };
    const attribution = payload.route === "STATUS" ? null : attributionFrom(event);
    switch (payload.route) {
      case "CONVERSATION": {
        const contact = normalizeContactHints({ phone: payload.senderPhone, displayName: payload.profileName });
        return {
          ok: true,
          normalized: {
            occurredAt: event.occurredAt,
            contactHints: contact.hints,
            signals: contact.signals,
            identity: "delegated",
            attribution,
            target: "conversation",
          },
        };
      }
      case "DOCUMENTS": {
        const contact = normalizeContactHints({ phone: payload.sender });
        return {
          ok: true,
          normalized: {
            occurredAt: event.occurredAt,
            contactHints: contact.hints,
            signals: contact.signals,
            identity: "delegated",
            attribution,
            target: "document",
          },
        };
      }
      case "STATUS":
        return {
          ok: true,
          normalized: {
            occurredAt: event.occurredAt,
            contactHints: null,
            signals: {},
            identity: "none",
            attribution: null,
            target: "message_status",
          },
        };
      case "UNSUPPORTED":
        return {
          ok: true,
          normalized: {
            occurredAt: event.occurredAt,
            contactHints: null,
            signals: {},
            identity: "none",
            attribution,
            target: "none",
          },
        };
    }
  },

  async route({ businessId, now }, _normalized, event): Promise<RouteResult> {
    const payload = readPayload(event);
    if (!payload) return { kind: "ignored", code: "payload_unavailable" };
    switch (payload.route) {
      case "UNSUPPORTED":
        return { kind: "ignored", code: `unsupported:${payload.reason}` };

      case "STATUS": {
        const applied = await applyOutboundStatus(businessId, payload, event.occurredAt ?? now);
        if (applied === null) return { kind: "ignored", code: "unknown_outbound_message" };
        return { kind: "routed", refs: { messageId: applied.messageId, conversationId: applied.conversationId } };
      }

      case "DOCUMENTS": {
        const gate = await checkRateLimit({ bucket: "WHATSAPP_INTAKE", business: businessId });
        if (!gate.allowed) {
          // Deferred, not dropped (M1 W11): the receipt waits and is retried.
          const until = new Date(now.getTime() + Math.max(gate.retryAfterSeconds ?? 60, 30) * 1000);
          return { kind: "deferred", code: "throttled", until };
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
          return { kind: "ignored", code: `documents_failed:${outcome.reason}` };
        }
        return { kind: "routed", refs: {} };
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
        if (ingested.status === "invalid_sender") return { kind: "ignored", code: "invalid_sender" };
        const context: ConversationContext = { conversation: ingested.conversation, message: ingested.message };
        return {
          kind: "routed",
          refs: {
            messageId: ingested.message.id,
            conversationId: ingested.conversation.id,
            customerId: ingested.customer.id,
          },
          alreadyExisted: ingested.alreadyExisted,
          context,
        };
      }
    }
  },

  async enrich({ businessId }, routed, _event, resume) {
    const context = routed.context as ConversationContext | undefined;
    if (!context) return; // STATUS / DOCUMENTS: nothing to enrich
    // Enrichment. A resumed run (the message was already stored by an earlier
    // attempt) repeats only what is safe to repeat.
    await runInboundMessagePipeline({
      conversation: context.conversation,
      message: context.message,
      businessId,
      source: "webhook",
      resume,
    });
    await syncInboxWaitingNotifications(businessId, context.conversation.id, new Date());
  },
};

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
