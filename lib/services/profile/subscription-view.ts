/**
 * What Profile and Settings show about the business's Dubiz subscription.
 *
 * Dubiz has no subscription system yet: no plan, no price, no billing period,
 * no renewal, no payment method. The screens keep the subscription area on
 * purpose (owner decision — it is reserved for the plans that are coming), and
 * this is the single place that decides what it says.
 *
 * Today there is exactly one honest answer, `unavailable`. When real plans
 * ship, the work is here: read the business's real subscription, return the
 * `active` shape, and the existing card and row render it — no screen is
 * redesigned. Until then nothing in this file may invent a plan, a status or a
 * call to action.
 */

export type SubscriptionView =
  | {
      /** No subscription system exists yet. Rendered as "בקרוב", with no action. */
      status: "unavailable";
    }
  | {
      /**
       * Reserved for the real subscription system. Not produced anywhere yet;
       * the UI already knows how to render it, so connecting the system later
       * is a data change, not a redesign.
       */
      status: "active";
      planName: string;
      /** Where the owner manages the plan — must be a real route when this ships. */
      manageHref: string;
      /** A short real fact about the plan (e.g. renewal date), or null. */
      detail: string | null;
    };

/**
 * The business's subscription view. When plans exist this takes the business
 * and reads its real subscription; today there is nothing to read.
 */
export function resolveSubscriptionView(): SubscriptionView {
  return { status: "unavailable" };
}
