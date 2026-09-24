import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { resolveUnresolvedReversal } from "@/lib/services/payments/payment-refund.service";
import { paymentRefundDeps } from "@/lib/services/payments/payments.deps";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Same shape the sibling refund route enforces: a positive integer id. */
function parsePaymentRequestId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError("Invalid payment request id");
  }
  return id;
}

/**
 * Ask the provider what became of a reversal it never established.
 *
 * THIS IS NOT AN OVERRIDE. It carries no body and takes no outcome: the caller
 * cannot say what happened, only ask. A button that let an owner mark an
 * indeterminate refund settled would write a money movement nobody observed,
 * and one that let them mark it failed would release a reservation that may be
 * the only thing preventing a second refund of money that already left.
 *
 * Safe to call repeatedly — by a person, by a screen, by two people at once.
 * A reversal that has already resolved is reported from the ledger without the
 * provider being touched, and only a provider VERDICT ever moves one.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    // Reversing money is a stronger right than reading it, and asking about a
    // reversal can change durable state — so it takes the same permission as
    // issuing one, not the weaker read permission.
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.REFUND);

    const { id } = await context.params;
    const requestId = parsePaymentRequestId(id);

    const result = await runWithTenantContext({ businessId: actor.businessId }, () =>
      resolveUnresolvedReversal(
        {
          businessId: actor.businessId,
          actorUserId: actor.userId,
          requestId,
        },
        paymentRefundDeps()
      )
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
