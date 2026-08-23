/**
 * Coupon lifecycle — the states a business owner can actually be shown.
 *
 * WHY THERE IS NO `SCHEDULED` (COUPON-02/08):
 * `Offer` has `validUntil` but no `startsAt`, and v1 adds no columns. A coupon
 * therefore goes live the moment it is published; there is no future-dated
 * coupon to schedule. Inventing a SCHEDULED chip would be a state the data
 * cannot produce, so it is deliberately absent.
 *
 * `EXPIRED` is *derived*, never trusted from the stored enum: `Coupon.status`
 * is only flipped to EXPIRED lazily, when someone tries to redeem it. Reading
 * the stored value alone would show a long-dead coupon as ACTIVE in the owner's
 * list. Time is the authority here, so `now` is always injected.
 *
 * Pure: no DB, no clock of its own.
 */

/** What the DB stores. */
export type StoredCouponStatus = "ACTIVE" | "REDEEMED" | "EXPIRED" | "CANCELLED";

/** What the owner is shown. */
export type CouponLifecycleState = "ACTIVE" | "REDEEMED" | "EXPIRED" | "DISABLED";

export const LIFECYCLE_LABEL: Record<CouponLifecycleState, string> = {
  ACTIVE: "פעיל",
  REDEEMED: "מומש",
  EXPIRED: "פג תוקף",
  DISABLED: "מושבת",
};

/**
 * Terminal facts win over intent: a redeemed coupon is spent, and an expired one
 * is over whether or not the owner had also disabled it — which is why an
 * expired coupon can never be re-enabled.
 */
export function deriveLifecycleState(
  coupon: { status: StoredCouponStatus; expiresAt: Date },
  now: Date
): CouponLifecycleState {
  if (coupon.status === "REDEEMED") return "REDEEMED";
  if (coupon.status === "EXPIRED" || coupon.expiresAt <= now) return "EXPIRED";
  if (coupon.status === "CANCELLED") return "DISABLED";
  return "ACTIVE";
}

/** Only a live coupon can be switched off. */
export function canDisable(state: CouponLifecycleState): boolean {
  return state === "ACTIVE";
}

/** Only a still-in-date disabled coupon can be switched back on. */
export function canEnable(state: CouponLifecycleState): boolean {
  return state === "DISABLED";
}

/**
 * v1 edit rule: a coupon's economics are frozen the moment it exists, because a
 * live coupon is a promise already in a customer's hands and the token may
 * already have been shared. The only safe change is to stop it (disable). This
 * keeps the audit's "what is safe to edit after redemption?" question answered
 * conservatively rather than guessed at.
 */
export function canEditEconomics(): boolean {
  return false;
}
