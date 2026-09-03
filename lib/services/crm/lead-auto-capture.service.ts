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

import type { Conversation, Message } from "@prisma/client";
import { leadService, isOpenPhoneCollision } from "@/lib/services/crm/lead.service";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { ValidationError } from "@/lib/errors";

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
  /** The race was detected but recovery could not find the canonical lead. */
  | "collision_unresolved"
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
/**
 * NOTE ON THE MISSING `tx` PARAMETER.
 *
 * This deliberately does NOT accept a caller's transaction. Recovery from the
 * unique-index race requires a SECOND transaction, and a caller that handed us
 * its own would have that transaction aborted underneath it by the collision —
 * taking the caller's other work down with it. Owning both boundaries here is
 * what makes the race recoverable at all.
 *
 * Callers must invoke this INSIDE `runWithTenantContext` (both already do), and
 * must not wrap it in a transaction of their own.
 */
export async function maybeCaptureLeadFromMessage(
  input: AutoCaptureInput
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

  // ── Attempt, in a transaction this service OWNS ──────────────────────────
  //
  // The boundary lives here rather than in the caller for one reason: when the
  // partial unique index rejects the insert, Postgres ABORTS that transaction.
  // Every later statement in it fails, so the adopt branch inside
  // `createFromConversation` cannot run — it is trying to recover inside the
  // very transaction that just died. Owning the boundary is what makes a second
  // one possible.
  try {
    const result = await withTenantTransaction((tx) =>
      leadService.createFromConversation(
        { businessId, conversationId: conversation.id, name: null },
        { tx }
      )
    );
    signal(result.outcome === "created" ? "created" : "adopted", {
      conversationId: conversation.id,
      messageId: message.id,
      leadId: result.lead.id,
    });
    return { captured: true, leadId: result.lead.id, outcome: result.outcome };
  } catch (error) {
    // A lead with no derivable name is the common, legitimate refusal: an
    // unknown WhatsApp number with no profile name gives us nothing to call
    // the person, and inventing a placeholder would pollute the CRM.
    const messageText = error instanceof Error ? error.message : String(error);
    if (isMissingIdentity(error, messageText)) {
      return { captured: false, reason: "no_identity" };
    }

    if (!isRecoverableCaptureRace(error)) {
      console.warn(
        `[lead-auto-capture] failed conversationId=${conversation.id} messageId=${message.id}:`,
        messageText
      );
      return { captured: false, reason: "error" };
    }

    // ── Recovery, in a FRESH transaction ──────────────────────────────────
    //
    // Another conversation for this phone won the race and created the open
    // lead. The aborted transaction is gone; this one starts clean, and
    // `createFromConversation` now takes its ordinary adopt path — the same
    // code that runs when the two inquiries arrive a second apart instead of
    // simultaneously. So the loser converges NOW, not on its next message.
    //
    // Exactly ONE retry. The only thing that can send us here is an open lead
    // existing, and an open lead cannot un-exist, so a second failure means
    // something else is wrong and looping would just hide it.
    try {
      const adopted = await withTenantTransaction((tx) =>
        leadService.createFromConversation(
          { businessId, conversationId: conversation.id, name: null },
          { tx }
        )
      );
      signal("collision_recovered", {
        conversationId: conversation.id,
        messageId: message.id,
        leadId: adopted.lead.id,
      });
      return { captured: true, leadId: adopted.lead.id, outcome: adopted.outcome };
    } catch (retryError) {
      // Fail CLOSED and loudly. Creating a lead blindly here is precisely how a
      // race turns into duplicate opportunities.
      console.warn(
        `[lead-auto-capture] collision recovery failed conversationId=${conversation.id} messageId=${message.id}:`,
        retryError instanceof Error ? retryError.message : retryError
      );
      return { captured: false, reason: "collision_unresolved" };
    }
  }
}

/**
 * One structured line per auto-capture outcome that MATTERS.
 *
 * Failures were already visible; success was silent — so "did adoption work?"
 * and "is the collision path being exercised at all?" were unanswerable from
 * the logs, which is exactly what you need to know in the first hours after
 * enabling this. Three outcomes are worth a line:
 *
 *   created            a new opportunity exists that nobody asked for by hand
 *   adopted            an existing open lead absorbed the conversation
 *   collision_recovered  two inquiries raced and the loser converged
 *
 * IDS ONLY. No phone, no name, no message text — everything here is already a
 * primary key somewhere, and the moment a log line carries customer content it
 * acquires its own retention problem.
 */
function signal(
  outcome: "created" | "adopted" | "collision_recovered",
  ids: { conversationId: number; messageId: number; leadId: number }
): void {
  console.info(
    `[lead-auto-capture] ${outcome} conversationId=${ids.conversationId} messageId=${ids.messageId} leadId=${ids.leadId}`
  );
}

/**
 * Is this failure the concurrent-capture race, and therefore worth exactly one
 * retry in a clean transaction?
 *
 * TWO signatures, because the loser does not always see the collision itself:
 *
 *   1. The unique violation (P2002 on Lead's open-phone index) — what the loser
 *      sees when nothing has swallowed it yet.
 *
 *   2. Postgres 25P02, "current transaction is aborted". This is the one that
 *      actually arrives in practice. `createFromConversation` catches the
 *      P2002 and tries to adopt the winner's lead — but that query runs in the
 *      transaction the violation just killed, so IT fails, and 25P02 is what
 *      propagates. Matching only the P2002 meant the retry never fired: the
 *      error we were looking for had already been consumed upstream.
 *
 * Deliberately narrow. 25P02 means precisely "a previous statement in this
 * transaction failed"; retrying it on a fresh transaction is always the right
 * response. Anything else — a validation error, a dead connection, a genuine
 * bug — is returned to the caller untouched.
 */
function isRecoverableCaptureRace(error: unknown): boolean {
  if (isOpenPhoneCollision(error)) return true;

  const text =
    error instanceof Error ? `${error.message}` : typeof error === "string" ? error : "";
  return (
    text.includes("25P02") ||
    /current transaction is aborted/i.test(text)
  );
}

/**
 * The "no name to call this person" refusal.
 *
 * Matched on the ValidationError the service throws rather than on any message
 * containing "name" — `customerName`, `businessName` and half the schema would
 * otherwise qualify.
 */
function isMissingIdentity(error: unknown, messageText: string): boolean {
  return (
    error instanceof ValidationError &&
    /derive a name/i.test(messageText)
  );
}
