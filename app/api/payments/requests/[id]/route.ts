import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { getPaymentRequestDetail } from "@/lib/services/payments/payment-ledger.service";
import { toPaymentRequestDetailApi } from "@/lib/services/payments/payment-api.serializer";
import { paymentRequestDeps } from "@/lib/services/payments/payments.deps";

export const runtime = "nodejs";

function parsePaymentRequestId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid payment request id");
  }
  return num;
}

/**
 * Ledger detail (M4) for a single payment request: the request, its settlement
 * transactions, and its audit timeline. Read-only, business-scoped via the
 * authorization seam — a request owned by another business is reported as
 * not-found.
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

    const detail = await getPaymentRequestDetail(paymentRequestDeps().store, {
      businessId: actor.businessId,
      requestId,
    });

    return NextResponse.json(toPaymentRequestDetailApi(detail), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
