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
 * That matters for resolution. `presentDedupeKeys` must contain waiting
 * conversations and nothing else: adding suggestion items would keep a
 * notification open for a conversation the business has already replied to,
 * which is precisely the state this is supposed to close.
 *
 * WHY IT NEVER THROWS
 *
 * The message is committed before this runs. Failing the webhook or the reply
 * afterwards because a notification could not be written would report a lie to
 * the caller and, on the webhook, invite Meta to redeliver a message we already
 * stored. Every failure is swallowed and returned as data. Nothing here sends
 * anything: the inbox rule grants IN_APP only.
 */
import { loadAttentionWaiting } from "@/lib/business-status/loaders";
import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import { translateAttentionWaiting } from "@/lib/business-status/translators/attention";

import { buildDedupeKey } from "./notification-policy";
import {
  persistSnapshotNotifications,
  resolveAbsentNotifications,
  type WriteOutcome,
} from "./notification-writer";

/**
 * The slice of the notification space this consumer owns. Resolution is scoped
 * to exactly this, so a pass here can never close an inventory, document or
 * billing notification it never looked at.
 *
 * One entity type, because both inbox translators key on the conversation.
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
 * Reconcile inbox-waiting notifications with the current truth.
 *
 * Call AFTER the message or conversation transaction has committed, inside a
 * tenant context. It is a reconciliation, not an event handler: it opens what
 * is now waiting and closes what is not, so the same call serves an inbound
 * message, an outbound reply and a conversation being closed. Callers do not
 * have to know which of those just happened.
 *
 * Safe to call when nothing changed. The writer dedupes on the fact's identity
 * and the cooldown decides whether anything is surfaced again, so a redundant
 * call costs a query and changes nothing the owner sees.
 */
export async function syncInboxWaitingNotifications(
  businessId: number,
  now: Date,
): Promise<InboxNotificationSync> {
  try {
    // The same two calls, in the same order, that the business-status service
    // makes for this fact. Truth is loaded, never recomputed here.
    const rows = await loadAttentionWaiting(businessId);
    const items = translateAttentionWaiting(rows).map(finalizeBusinessStatusItem);

    const written = await persistSnapshotNotifications(businessId, items, now);

    // The complement: every inbox notification still open whose conversation is
    // no longer waiting — because the business replied, or because the
    // conversation was closed. Built from the same items, so the two halves
    // cannot disagree about what is currently true.
    //
    // Note this is the set of ALL currently-waiting conversations, not only the
    // ones the policy chose to notify about. A fact the policy silences must
    // still count as present, or the next pass would "resolve" a notification
    // whose condition is very much still there.
    const presentKeys = items.map((item) => buildDedupeKey(businessId, item));
    const resolved = await resolveAbsentNotifications(
      businessId,
      INBOX_WAITING_SCOPE,
      presentKeys,
      now,
    );

    return { ok: true, written, resolved };
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
