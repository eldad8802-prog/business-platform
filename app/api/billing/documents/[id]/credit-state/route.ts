import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  getBillingCreditState,
  type BillingCreditState,
} from "@/lib/services/billing/billing-credit-reversal.service";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (
    !num ||
    Number.isNaN(num) ||
    !Number.isInteger(num) ||
    num <= 0
  ) {
    throw new ValidationError("Invalid billing document id");
  }
  return num;
}

function serializeCreditState(state: BillingCreditState) {
  return {
    creditedAmount: state.creditedAmount.toString(),
    remainingAmount: state.remainingAmount.toString(),
    isPartiallyCredited: state.isPartiallyCredited,
    isFullyCredited: state.isFullyCredited,
    creditNoteCount: state.creditNoteCount,
  };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await context.params;
    const sourceBillingDocumentId = parseBillingDocumentId(id);

    const creditState = await billingTenantTx(user.businessId, (tx) =>
      getBillingCreditState(tx, {
        businessId: user.businessId,
        sourceBillingDocumentId,
      })
    );

    return NextResponse.json(
      { creditState: serializeCreditState(creditState) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
