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
 * Stage 1 introduced NO business-role taxonomy, and this still introduces
 * none. What it adds is one rule on the one action that sends money OUT:
 *
 *   REFUND (refund, partial refund, void, and asking about a reversal) is
 *   reserved to the business's ACCOUNT OWNER — the user who opened the
 *   business, i.e. its first user. A business has exactly one user today
 *   (signup creates one; there are no invitations), so nobody who can refund
 *   now loses that right; what changes is that a second user, when invitations
 *   exist, does not inherit "move money out" merely by being logged in. The
 *   route resolves ownership from the database and passes it in; this
 *   function never guesses it.
 *
 * Resolving an indeterminate refund from outside evidence is not a business
 * action at all: it is platform-administrator-only with MFA (admin route).
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
  /** Reverse a payment (refund, partial refund, void). Account owner only. */
  REFUND: "REFUND",
} as const;

export type PaymentAction =
  (typeof PAYMENT_ACTIONS)[keyof typeof PAYMENT_ACTIONS];

/** The minimal subset of a User the seam needs (a `getCurrentUser` result). */
export interface PaymentActorUser {
  id: number;
  businessId: number;
}

/** Facts about the actor the route resolved server-side. Never from input. */
export interface PaymentActorFacts {
  /** True when the actor is the business's account owner (its first user). */
  isBusinessAccountOwner?: boolean;
}

/** Actions reserved to the business's account owner. */
const ACCOUNT_OWNER_ACTIONS: ReadonlySet<PaymentAction> = new Set<PaymentAction>([
  PAYMENT_ACTIONS.REFUND,
]);

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
  action: PaymentAction,
  facts: PaymentActorFacts = {}
): AuthorizedPaymentActor {
  if (!user) {
    throw new UnauthorizedError();
  }
  if (!Number.isInteger(user.businessId) || user.businessId <= 0) {
    // Authenticated but with no business context — cannot touch money.
    throw new ForbiddenError("No business context for payment action");
  }
  // Money OUT is the account owner's. Fail closed: an unresolved fact is "no".
  if (ACCOUNT_OWNER_ACTIONS.has(action) && facts.isBusinessAccountOwner !== true) {
    throw new ForbiddenError("רק בעל החשבון של העסק יכול להחזיר כסף ללקוחות");
  }
  return { userId: user.id, businessId: user.businessId, action };
}
