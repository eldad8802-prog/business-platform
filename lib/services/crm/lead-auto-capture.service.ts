/**
 * Lead auto-capture — W3.
 *
 * The gap this closes: a real inquiry could arrive on WhatsApp, be answered,
 * and never become a lead — because becoming a lead required the owner to
 * notice a chip and press it. Everything downstream of Leads (follow-ups,
 * attention, the bell, conversion history) therefore only ever saw the
 * inquiries somebody remembered to file. The busiest days lost the most.
 *
 * This turns the FIRST genuine customer message on an unlinked conversation
 * into a lead, using the exact path the manual button already uses —
 * `leadService.createFromConversation` — so the dedupe, the adopt-an-open-lead
 * behaviour, the identity rules and the `LEAD_CREATED_FROM_CONVERSATION` event
 * are the proven ones, not a second implementation.
 *
 * ── It is a behaviour change, so it is flagged ─────────────────────────────
 *
 * `LEADS_AUTO_CAPTURE_ENABLED` must be exactly "true". Absent, "false", or
 * anything else leaves the product behaving precisely as it does today. The
 * flag is read per call, never cached.
 *
 * ── What it must never do ──────────────────────────────────────────────────
 *
 * Create a lead from an outbound message, a system or AI message, an empty
 * message, a replay, or a conversation that already has an open lead. Each of
 * those is refused explicitly below with a named reason rather than falling
 * through some general condition, because "why didn't a lead appear?" has to be
 * answerable.
 *
 * ── Why a closed lead does not block a new one ─────────────────────────────
 *
 * A customer whose deal was WON last month and who asks about something new is
 * a NEW opportunity, not a reopening. `createFromConversation` already adopts
 * only OPEN leads, so a closed one falls through to creation — and the partial
 * unique index (`Lead_open_phone_key`) remains the final arbiter of "one open
 * lead per phone".
 */

import type { Conversation, Message, Prisma } from "@prisma/client";
import { leadService } from "@/lib/services/crm/lead.service";

const FLAG_ENV_NAME = "LEADS_AUTO_CAPTURE_ENABLED";

export function isLeadAutoCaptureEnabled(): boolean {
  return process.env[FLAG_ENV_NAME]?.trim().toLowerCase() === "true";
}

export type AutoCaptureRefusalReason =
  | "flag_disabled"
  | "not_customer_inbound"
  | "empty_message"
  | "already_linked"
  | "tenant_mismatch"
  | "no_identity"
  | "error";

export type AutoCaptureResult =
  | { captured: true; leadId: number; outcome: "created" | "linked_existing" | "already_linked" }
  | { captured: false; reason: AutoCaptureRefusalReason };

export type AutoCaptureInput = {
  businessId: number;
  conversation: Conversation;
  message: Pick<
    Message,
    "id" | "businessId" | "conversationId" | "direction" | "senderType" | "contentText"
  >;
};

/**
 * Capture a lead from an inbound customer message, when every condition holds.
 *
 * Returns a reason rather than throwing: a capture failure must never break the
 * message that triggered it.
 */
export async function maybeCaptureLeadFromMessage(
  input: AutoCaptureInput,
  options?: { tx?: Prisma.TransactionClient }
): Promise<AutoCaptureResult> {
  if (!isLeadAutoCaptureEnabled()) {
    return { captured: false, reason: "flag_disabled" };
  }

  const { conversation, message, businessId } = input;

  // Only a real person saying a real thing starts a lead. Outbound is the
  // business talking to itself; SYSTEM / AI is the product talking.
  if (message.direction !== "INBOUND" || message.senderType !== "CUSTOMER") {
    return { captured: false, reason: "not_customer_inbound" };
  }
  if (!message.contentText || message.contentText.trim().length === 0) {
    return { captured: false, reason: "empty_message" };
  }

  // The message is the evidence for the capture; if it belongs to another
  // business it cannot be evidence about this conversation.
  if (
    message.businessId !== businessId ||
    conversation.businessId !== businessId ||
    message.conversationId !== conversation.id
  ) {
    return { captured: false, reason: "tenant_mismatch" };
  }

  // Already a lead's conversation → nothing to capture. This is the cheap
  // guard; `createFromConversation` is idempotent anyway, so a race that gets
  // past it still cannot produce two leads.
  if (conversation.leadId != null) {
    return { captured: false, reason: "already_linked" };
  }

  try {
    const result = await leadService.createFromConversation(
      { businessId, conversationId: conversation.id, name: null },
      options
    );
    return {
      captured: true,
      leadId: result.lead.id,
      outcome: result.outcome,
    };
  } catch (error) {
    // A lead with no derivable name is the common, legitimate refusal: an
    // unknown WhatsApp number with no profile name gives us nothing to call
    // the person, and inventing a placeholder would pollute the CRM.
    const messageText = error instanceof Error ? error.message : String(error);
    if (/name/i.test(messageText)) {
      return { captured: false, reason: "no_identity" };
    }
    console.warn(
      `[lead-auto-capture] failed conversationId=${conversation.id} messageId=${message.id}:`,
      messageText
    );
    return { captured: false, reason: "error" };
  }
}
