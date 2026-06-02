/**
 * Routing gate for inbound WhatsApp messages.
 *
 * Branches (first match wins):
 *
 *   1. DOCUMENTS_INTAKE   — image / document with media_id, allowlisted sender
 *   2. CONVERSATION_INTAKE — text body present (allowlist BYPASSED — see below)
 *   3. STOP                — everything else
 *
 * # Allowlist asymmetry (Bot-MVP-1 decision)
 *
 * `DOCUMENTS_INTAKE` continues to enforce the per-business sender allowlist
 * (`WHATSAPP_ALLOWLIST_BY_BUSINESS` env JSON, owned by `allowlist.service`).
 * This preserves the existing security posture for the document pipeline
 * and keeps `webhook-pr3.media.test.ts` + `webhook-pr4.intake.test.ts`
 * passing without modification.
 *
 * `CONVERSATION_INTAKE` bypasses the allowlist. Real customers cannot be
 * pre-allowlisted, so the gate for text intake is the presence of an
 * active `WhatsAppConnection` row for the business (validated upstream by
 * `business-resolve.service`).
 */

import { checkSenderAllowlisted } from "./allowlist.service";
import { resolveBusinessFromPhoneNumberId } from "./business-resolve.service";
import { normalizePhoneDigits } from "./config";
import type { WhatsAppWebhookMessageSummary } from "./types";
import type {
  DocumentsIntakeMediaType,
  RoutingDecision,
  RoutingStopReason,
} from "./routing.types";

const INTAKE_MEDIA_TYPES = new Set<DocumentsIntakeMediaType>([
  "image",
  "document",
]);

function stop(
  reason: RoutingStopReason,
  extra?: Partial<{ phoneNumberId: string }>
): RoutingDecision {
  return { kind: "STOP", reason, ...extra };
}

/**
 * Resolve a single inbound message to a routing decision.
 *
 * Async because the primary business resolution path is now DB-backed
 * (`WhatsAppConnection`). The webhook handler is already async so the
 * cascade is safe.
 */
export async function routeInboundWhatsAppMessage(
  message: WhatsAppWebhookMessageSummary
): Promise<RoutingDecision> {
  // ── identity boundary: phoneNumberId → businessId ────────────────────
  const business = await resolveBusinessFromPhoneNumberId(message.phoneNumberId);
  if (!business.ok) {
    return stop(business.reason, {
      phoneNumberId: business.phoneNumberId ?? undefined,
    });
  }

  if (!message.wamid || message.wamid.trim().length === 0) {
    return stop("invalid_message");
  }
  const wamid = message.wamid.trim();

  const type = message.type?.trim().toLowerCase() ?? "";
  if (!type) {
    return stop("unsupported_message_type");
  }

  // ── Branch 1: DOCUMENTS_INTAKE (image / document) ────────────────────
  // The business is already identified above. Media routes to the document
  // pipeline either when the sender is allowlisted (`senderTrust:
  // "allowlist"`, unchanged behavior) OR when the sender is NOT allowlisted
  // but the media arrived inside a normal customer conversation
  // (`senderTrust: "conversation"`). The `missing_media_id` guard is shared
  // by both paths, so absence of `mediaId` always STOPs regardless of trust.
  if (INTAKE_MEDIA_TYPES.has(type as DocumentsIntakeMediaType)) {
    if (!message.mediaId || message.mediaId.trim().length === 0) {
      return stop("missing_media_id");
    }

    const allowlist = checkSenderAllowlisted({
      businessId: business.businessId,
      sender: message.from,
    });

    if (allowlist.ok) {
      return {
        kind: "DOCUMENTS_INTAKE",
        businessId: business.businessId,
        phoneNumberId: business.phoneNumberId,
        sender: allowlist.senderDigits,
        wamid,
        mediaType: type as DocumentsIntakeMediaType,
        mediaId: message.mediaId.trim(),
        senderTrust: "allowlist",
      };
    }

    // Sender not allowlisted. Business is identified, so accept the media
    // as conversation-origin intake. Reject only when we cannot derive a
    // usable sender from the webhook payload.
    const senderDigits = normalizePhoneDigits(message.from ?? "");
    if (senderDigits.length < 8) {
      return stop("missing_sender");
    }
    return {
      kind: "DOCUMENTS_INTAKE",
      businessId: business.businessId,
      phoneNumberId: business.phoneNumberId,
      sender: senderDigits,
      wamid,
      mediaType: type as DocumentsIntakeMediaType,
      mediaId: message.mediaId.trim(),
      senderTrust: "conversation",
    };
  }

  // ── Branch 2: CONVERSATION_INTAKE (text) ─────────────────────────────
  // Allowlist BYPASSED for text — see file docstring.
  if (type === "text") {
    if (!message.from || message.from.trim().length === 0) {
      return stop("missing_sender");
    }
    if (!message.textBody) {
      return stop("missing_text_body");
    }
    const senderPhone = normalizePhoneDigits(message.from);
    if (senderPhone.length < 8) {
      return stop("missing_sender");
    }
    return {
      kind: "CONVERSATION_INTAKE",
      businessId: business.businessId,
      phoneNumberId: business.phoneNumberId,
      senderPhone,
      wamid,
      text: message.textBody,
    };
  }

  // ── Branch 3: STOP for anything else (audio/video/sticker/location/etc.)
  return stop("unsupported_message_type");
}

/** Masks sender for logs — last 4 digits only. */
export function maskSenderDigits(senderDigits: string): string {
  if (senderDigits.length <= 4) return "****";
  return `***${senderDigits.slice(-4)}`;
}

export function routingDecisionLogFields(
  decision: RoutingDecision
): Record<string, unknown> {
  if (decision.kind === "DOCUMENTS_INTAKE") {
    return {
      decision: "DOCUMENTS_INTAKE",
      businessId: decision.businessId,
      phoneNumberId: decision.phoneNumberId,
      mediaType: decision.mediaType,
      senderMasked: maskSenderDigits(decision.sender),
      senderTrust: decision.senderTrust,
      wamidPrefix: decision.wamid.slice(0, 16),
      hasMediaId: true,
    };
  }

  if (decision.kind === "CONVERSATION_INTAKE") {
    return {
      decision: "CONVERSATION_INTAKE",
      businessId: decision.businessId,
      phoneNumberId: decision.phoneNumberId,
      senderMasked: maskSenderDigits(decision.senderPhone),
      wamidPrefix: decision.wamid.slice(0, 16),
      textLength: decision.text.length,
    };
  }

  return {
    decision: "STOP",
    stopReason: decision.reason,
    ...(decision.phoneNumberId ? { phoneNumberId: decision.phoneNumberId } : {}),
  };
}
