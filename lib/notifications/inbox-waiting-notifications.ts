/**
 * The second notification consumer: a conversation waiting on the business.
 *
 * Same shape as the inventory consumer, and deliberately so — the truth is
 * loaded from the business-status layer, the decision is made by the existing
 * policy, and the memory is the existing writer. This module contributes no
 * rule, no threshold and no severity of its own. `loadAttentionWaiting` and
 * `translateAttentionWaiting` are the same functions `/api/business-status`
 * calls, so the notification and the attention list cannot form two opinions
 * about who is waiting.
 *
 * WHY THIS ONE IS WORTH INTERRUPTING FOR
 *
 * Every other candidate in the domain audit becomes true while the owner is
 * already looking at the screen that shows it. This one becomes true from a
 * webhook, when nobody is watching, and the cost of not knowing is a customer
 * sitting unanswered. The policy already reflects that: HIGH, in-app, twelve
 * hours of quiet between repeats.
 *
 * WHAT "WAITING" MEANS
 *
 * Exactly what the loader says and nothing more: the conversation is OPEN and
 * its most recent message is INBOUND from a CUSTOMER. Any outbound message ends
 * it, whoever sent it — owner, bot or system. That is not a shortcut. If the
 * bot answered, the customer is not waiting on a human, and inventing a second
 * definition here would put this module in disagreement with the inbox itself.
 *
 * ONE CONVERSATION AT A TIME, AND WHY
 *
 * This used to reconcile the whole domain: load the waiting list, write what is
 * on it, close every open notification that is not. That was wrong, and the way
 * it was wrong is worth keeping written down.
 *
 * `loadAttentionWaiting` is a PRESENTATION query. It stops at twelve, because
 * Attention is a shortlist rather than a register. Absence from it therefore
 * means "not in the top twelve", not "answered" — so a business with thirteen
 * people waiting had the thirteenth notification closed as though someone had
 * replied. The list is ranked newest-first, so the one silently dropped was the
 * person who had been waiting longest.
 *
 * Every caller already knows which conversation changed. So instead of
 * inferring from a list, this asks the direct question about that one
 * conversation — is it still waiting? — and acts on the answer. Positive
 * evidence about one entity, rather than an inference from an incomplete set.
 * A conversation nobody touched is left exactly as it was.
 *
 * SCOPE, AND A KEY THAT IS SHARED BY TWO FACTS
 *
 * The inbox domain has a second translator — pending reply suggestions — which
 * emits the same domain, the same category and the same entity type. Its
 * dedupe key for a given conversation is therefore IDENTICAL to this one's.
 * They never collide today for two reasons: the business-status service
 * excludes waiting conversations from the suggestion list, and the suggestion
 * fact is MEDIUM, which no policy rule grants a channel. This consumer syncs
 * ONLY the waiting fact.
 *
 * WHY IT NEVER THROWS
 *
 * The message is committed before this runs. Failing the webhook or the reply
 * afterwards because a notification could not be written would report a lie to
 * the caller and, on the webhook, invite Meta to redeliver a message we already
 * stored. Every failure is swallowed and returned as data. Nothing here sends
 * anything: the inbox rule grants IN_APP only.
 */
import { loadAttentionWaitingForConversation } from "@/lib/business-status/loaders";
import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import { translateAttentionWaiting } from "@/lib/business-status/translators/attention";

import { buildDedupeKey } from "./notification-policy";
import {
  persistSnapshotNotifications,
  resolveNotificationByDedupeKey,
  type WriteOutcome,
} from "./notification-writer";

/**
 * The slice of the notification space this consumer owns. Kept as documentation
 * of what this module may touch: one domain, one entity type. Nothing here ever
 * writes outside it.
 */
export const INBOX_WAITING_SCOPE = {
  domain: "inbox",
  entityTypes: ["conversation"],
} as const;

export type InboxNotificationSync = {
  ok: boolean;
  /** Facts the policy granted a channel and that were written or refreshed. */
  written: WriteOutcome[];
  /** Open notifications closed because their conversation no longer waits. */
  resolved: number;
  /** Present only when the sync failed; the message is unaffected either way. */
  error?: string;
};

/**
 * Reconcile the notification for ONE conversation with the current truth.
 *
 * Call AFTER the message or conversation transaction has committed, inside a
 * tenant context, passing the conversation that changed. It is still a
 * reconciliation rather than an event handler — it asks what is true now, not
 * what happened — so the same call serves an inbound message, an outbound reply
 * and a conversation being closed. Callers do not have to know which.
 *
 * What it will NOT do is touch any other conversation. Every other notification
 * in the domain is left exactly as it was, because this pass has no evidence
 * about them and absence of evidence was the bug.
 *
 * Safe to call when nothing changed. The writer dedupes on the fact's identity
 * and the cooldown decides whether anything is surfaced again, so a redundant
 * call costs two small queries and changes nothing the owner sees.
 */
export async function syncInboxWaitingNotifications(
  businessId: number,
  conversationId: number,
  now: Date,
): Promise<InboxNotificationSync> {
  try {
    // The direct question, about this conversation only. Null means it is not
    // waiting — answered, closed, or never waiting to begin with.
    const row = await loadAttentionWaitingForConversation(businessId, conversationId);

    if (row === null) {
      // Positive evidence that the condition is over, for this one fact. The
      // key is rebuilt from the same policy function that wrote it, so it can
      // only ever address the notification this conversation owns.
      const closed = await resolveNotificationByDedupeKey(
        businessId,
        buildDedupeKey(businessId, {
          domain: INBOX_WAITING_SCOPE.domain as "inbox",
          semanticCategory: "ACTION_REQUIRED",
          entityRef: { type: "conversation", id: conversationId },
        }),
        now,
      );
      return { ok: true, written: [], resolved: closed ? 1 : 0 };
    }

    const items = translateAttentionWaiting([row]).map(finalizeBusinessStatusItem);
    const written = await persistSnapshotNotifications(businessId, items, now);

    return { ok: true, written, resolved: 0 };
  } catch (error) {
    // Deliberately terminal. The message is committed and correct; the owner's
    // notification is not, and that is the lesser failure to absorb.
    console.error("[notifications] inbox waiting sync failed", error);
    return {
      ok: false,
      written: [],
      resolved: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
