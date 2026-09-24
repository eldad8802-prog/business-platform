import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import {
  getRefundableBalance,
  refundPaymentRequest,
} from "@/lib/services/payments/payment-refund.service";
import { toPaymentTransactionApi } from "@/lib/services/payments/payment-api.serializer";
import { paymentRefundDeps } from "@/lib/services/payments/payments.deps";
import { getProviderDescriptor } from "@/lib/services/payments/providers/provider-registry";
import { runWithTenantContext } from "@/lib/tenant/context";

export const runtime = "nodejs";

function parsePaymentRequestId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid payment request id");
  }
  return num;
}

/**
 * What is still reversible on this payment.
 *
 * A surface should be able to show the refundable balance without attempting a
 * refund to find out, and both answers come from the same rules so they can
 * never disagree. Business-scoped: another business's request is not-found.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);

    const { id } = await context.params;
    const requestId = parsePaymentRequestId(id);

    const deps = paymentRefundDeps();
    const balance = await runWithTenantContext(
      { businessId: actor.businessId },
      () =>
        getRefundableBalance(deps.store, {
          businessId: actor.businessId,
          requestId,
        })
    );

    // What the PROVIDER behind this payment can actually do, so the screen can
    // offer the right action instead of offering one and failing on it. Read
    // from the descriptor rather than assumed: a payment taken through a
    // provider that cannot reverse must not show a refund button at all.
    const request = await runWithTenantContext(
      { businessId: actor.businessId },
      () => deps.store.findPaymentRequestById(requestId)
    );
    const descriptor =
      request && request.businessId === actor.businessId
        ? getProviderDescriptor(request.provider)
        : null;
    const capabilities = descriptor?.capabilities;

    return NextResponse.json(
      {
        ...balance,
        provider: request?.provider ?? null,
        canRefund: capabilities?.refund === true,
        canRefundPartially: capabilities?.partialRefund === true,
        canVoid: capabilities?.void === true,
        canVerifyRefund: capabilities?.refundVerification === true,
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Reverse part or all of a settled payment.
 *
 * THE BODY CARRIES AN AMOUNT AND A REASON, AND NOTHING ELSE THAT MATTERS.
 *
 * Not a business id — that comes from the authenticated actor, so a caller can
 * only ever reverse their own business's money. Not a provider, a customer id,
 * a transaction reference or a credential — every one of those is read from
 * what Dubiz already persisted about this payment. A refund route that accepted
 * provider identifiers from its caller would let one business credit another's
 * customer, which is why none of them appear here.
 *
 * Omitting `amount` refunds the entire remaining balance, which is the common
 * case and the one most easily got wrong by hand.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.REFUND);

    const { id } = await context.params;
    const requestId = parsePaymentRequestId(id);

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    const reason =
      typeof body.reason === "string" && body.reason.trim() !== ""
        ? body.reason.trim()
        : null;

    const result = await runWithTenantContext(
      { businessId: actor.businessId },
      async () => {
        const deps = paymentRefundDeps();

        // A missing amount means "all of what is left". Resolved here, against
        // the same read the refund itself will bound against a moment later.
        let amount = body.amount as string | number | undefined;
        if (amount === undefined || amount === null || amount === "") {
          const balance = await getRefundableBalance(deps.store, {
            businessId: actor.businessId,
            requestId,
          });
          amount = balance.refundableRemaining;
        }

        return refundPaymentRequest(
          {
            businessId: actor.businessId,
            actorUserId: actor.userId,
            requestId,
            amount: amount as string | number,
            reason,
          },
          deps
        );
      }
    );

    return NextResponse.json(
      {
        refund: toPaymentTransactionApi(result.refund),
        outcome: result.outcome,
        refundedTotal: result.refundedTotal,
        refundableRemaining: result.refundableRemaining,
      },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
