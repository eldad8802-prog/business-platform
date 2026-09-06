/**
 * The first notification consumer: inventory stock alerts.
 *
 * Closes the chain the previous phases built one piece at a time:
 *
 *   inventory movement commits
 *     -> existing business-status loader + translator (the truth)
 *     -> existing notification policy (the decision)
 *     -> merged notification writer (the memory)
 *
 * Every one of those three already exists and is used verbatim. This module
 * contributes no rule, no threshold and no severity of its own — it is wiring,
 * and it must stay that way. `loadInventoryAlertsUnresolved`,
 * `translateInventoryAlerts` and `finalizeBusinessStatusItem` are the same
 * functions `/api/business-status` calls, so the notification layer and the
 * attention list can never drift into two opinions about inventory.
 *
 * WHY NOT INSIDE createMovement
 *
 * The approved trigger was `inventoryService.createMovement`, and it turned out
 * it cannot be the call site. `createMovement` takes an optional `tx`, and every
 * production caller passes one, so it returns while the caller's transaction is
 * still open. Calling from there would run BEFORE the commit and would nest a
 * transaction inside a transaction — the opposite of the requirement that
 * persistence run only after the movement has committed. The commit boundary
 * lives at the route, so that is where this is invoked.
 *
 * WHY IT NEVER THROWS
 *
 * A stock movement that has already committed is a fact about the business.
 * Failing the request afterwards because a notification could not be written
 * would report a lie to the caller. Every failure is therefore swallowed and
 * returned as data. Nothing here sends anything: PUSH is persisted as PENDING
 * by the writer and no external delivery exists in this phase.
 */
import {
  loadInventoryAlertsUnresolved,
} from "@/lib/business-status/loaders";
import { finalizeBusinessStatusItem } from "@/lib/business-status/priority";
import { translateInventoryAlerts } from "@/lib/business-status/translators/inventory";

import {
  persistSnapshotNotifications,
  resolveAbsentNotifications,
  type WriteOutcome,
} from "./notification-writer";
import { buildDedupeKey } from "./notification-policy";

/**
 * The slice of the notification space this consumer owns. Resolution is scoped
 * to exactly this, so a pass here can never close a document, lead or billing
 * notification it never looked at.
 *
 * `entityType` mirrors the `entityRef.type` the inventory translator emits.
 */
export const INVENTORY_ALERT_SCOPE = {
  domain: "inventory",
  entityType: "inventory_alert",
} as const;

export type InventoryNotificationSync = {
  ok: boolean;
  /** Facts the policy granted a channel and that were written or refreshed. */
  written: WriteOutcome[];
  /** Open notifications closed because their alert is no longer unresolved. */
  resolved: number;
  /** Present only when the sync failed; the movement is unaffected either way. */
  error?: string;
};

/**
 * Reconcile inventory-alert notifications with the current truth.
 *
 * Call AFTER the inventory transaction has committed, inside a tenant context.
 * Safe to call when nothing changed: the writer dedupes on the fact's identity
 * and the cooldown decides whether anything is re-notified, so a redundant call
 * costs a query and changes nothing the owner sees.
 */
export async function syncInventoryAlertNotifications(
  businessId: number,
  now: Date,
): Promise<InventoryNotificationSync> {
  try {
    // The same three calls, in the same order, that the business-status service
    // makes for this domain. Truth is loaded, never recomputed here.
    const rows = await loadInventoryAlertsUnresolved(businessId);
    const items = translateInventoryAlerts(rows).map(finalizeBusinessStatusItem);

    const written = await persistSnapshotNotifications(businessId, items, now);

    // The complement: every inventory-alert notification still open whose alert
    // is no longer in the unresolved set. Built from the same items, so the two
    // halves cannot disagree about what is currently true.
    //
    // Note this is the set of ALL currently-true inventory facts, not just the
    // ones the policy chose to notify about. A fact the policy silences must
    // still count as present, or the next pass would "resolve" a notification
    // whose condition is very much still there.
    const presentKeys = items.map((item) => buildDedupeKey(businessId, item));
    const resolved = await resolveAbsentNotifications(
      businessId,
      INVENTORY_ALERT_SCOPE,
      presentKeys,
      now,
    );

    return { ok: true, written, resolved };
  } catch (error) {
    // Deliberately terminal. The movement is committed and correct; the owner's
    // notification is not, and that is the lesser failure to absorb.
    console.error("[notifications] inventory alert sync failed", error);
    return {
      ok: false,
      written: [],
      resolved: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
