/**
 * Run: npx tsx lib/services/payments/payment-authorization.test.ts
 *
 * The M8 authorization seam (Stage 1, B-formalize): authenticated + business
 * ownership, named actions, no role taxonomy yet.
 */
import assert from "node:assert/strict";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "./payment-authorization";

function statusCodeOf(error: unknown): number | undefined {
  return (error as { statusCode?: number })?.statusCode;
}

async function main() {
  // --- authenticated member of a business => authorized, business-scoped ---
  {
    const actor = authorizePaymentAction(
      { id: 5, businessId: 9 },
      PAYMENT_ACTIONS.CREATE_CHARGE
    );
    assert.equal(actor.userId, 5);
    assert.equal(actor.businessId, 9);
    assert.equal(actor.action, "CREATE_CHARGE");
  }

  // --- every current action is allowed for any authenticated member ---
  {
    for (const action of Object.values(PAYMENT_ACTIONS)) {
      const actor = authorizePaymentAction({ id: 1, businessId: 2 }, action);
      assert.equal(actor.action, action);
      assert.equal(actor.businessId, 2);
    }
  }

  // --- unauthenticated => UnauthorizedError (401) ---
  {
    assert.throws(
      () => authorizePaymentAction(null, PAYMENT_ACTIONS.VIEW_TRANSACTIONS),
      (e) => statusCodeOf(e) === 401
    );
    assert.throws(
      () => authorizePaymentAction(undefined, PAYMENT_ACTIONS.CONNECT_PROVIDER),
      (e) => statusCodeOf(e) === 401
    );
  }

  // --- authenticated but no business context => ForbiddenError (403) ---
  {
    assert.throws(
      () =>
        authorizePaymentAction({ id: 1, businessId: 0 }, PAYMENT_ACTIONS.CREATE_CHARGE),
      (e) => statusCodeOf(e) === 403
    );
    assert.throws(
      () =>
        authorizePaymentAction(
          { id: 1, businessId: -3 },
          PAYMENT_ACTIONS.CREATE_CHARGE
        ),
      (e) => statusCodeOf(e) === 403
    );
  }

  // --- ownership: the businessId is always the actor's own ---
  {
    const actor = authorizePaymentAction({ id: 2, businessId: 7 }, PAYMENT_ACTIONS.REFUND);
    assert.equal(actor.businessId, 7); // derived from the actor, not from input
  }

  console.log("payment-authorization tests: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
