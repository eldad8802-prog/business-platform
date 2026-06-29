/**
 * Payments authorization seam (M8, Stage 1 — B-formalize).
 *
 * A single function every user-facing payment route calls before doing anything.
 * It formalizes the two invariants that already governed the payment routes,
 * into one place with a named-action vocabulary:
 *
 *   1. AUTHENTICATED — there is a real, logged-in user.
 *   2. OWNERSHIP     — the action runs within that user's own business. The
 *      businessId is taken from the authenticated actor, never from request
 *      input, so a caller can only ever touch their own business's money.
 *
 * Stage 1 deliberately introduces NO business-role taxonomy: every authenticated
 * member of the business is authorized for every payment action. Role
 * differentiation (owner / finance / viewer) is a future, additive step that
 * will plug into THIS function without changing a single call site.
 *
 * REFUND and MANAGE_SETTINGS are reserved action constants with no route yet
 * (Stage 1 Non-Goals: no Refund, no settings UI) — present so future work has a
 * stable vocabulary to gate on.
 */

import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

export const PAYMENT_ACTIONS = {
  /** Create a charge / payment request. */
  CREATE_CHARGE: "CREATE_CHARGE",
  /** Connect or update a payment provider connection. */
  CONNECT_PROVIDER: "CONNECT_PROVIDER",
  /** Read payment requests / transactions / connections. */
  VIEW_TRANSACTIONS: "VIEW_TRANSACTIONS",
  /** Change payment settings / policy. Reserved — no route in Stage 1. */
  MANAGE_SETTINGS: "MANAGE_SETTINGS",
  /** Reverse a payment. Reserved — no route in Stage 1 (Non-Goal). */
  REFUND: "REFUND",
} as const;

export type PaymentAction =
  (typeof PAYMENT_ACTIONS)[keyof typeof PAYMENT_ACTIONS];

/** The minimal subset of a User the seam needs (a `getCurrentUser` result). */
export interface PaymentActorUser {
  id: number;
  businessId: number;
}

export interface AuthorizedPaymentActor {
  userId: number;
  businessId: number;
  action: PaymentAction;
}

/**
 * Authorize a payment action for the current user. Returns the business-scoped
 * actor context the route must use (its businessId, NOT any client-supplied id).
 * Throws UnauthorizedError (401) when not authenticated, ForbiddenError (403)
 * when the user has no business to act within.
 */
export function authorizePaymentAction(
  user: PaymentActorUser | null | undefined,
  action: PaymentAction
): AuthorizedPaymentActor {
  if (!user) {
    throw new UnauthorizedError();
  }
  if (!Number.isInteger(user.businessId) || user.businessId <= 0) {
    // Authenticated but with no business context — cannot touch money.
    throw new ForbiddenError("No business context for payment action");
  }
  // Stage 1: every authenticated member of the business is authorized. This is
  // where future role checks (REFUND, MANAGE_SETTINGS, ...) will live.
  return { userId: user.id, businessId: user.businessId, action };
}
