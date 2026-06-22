import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  getInvoiceSettlementState,
  type InvoiceSettlementState,
} from "@/lib/services/billing/receipt/billing-settlement-state.service";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid billing document id");
  }
  return num;
}

function serializeSettlementState(state: InvoiceSettlementState) {
  return {
    invoiceDocumentId: state.invoiceDocumentId,
    totalAmount: state.totalAmount.toString(),
    allocatedAmount: state.allocatedAmount.toString(),
    remainingAmount: state.remainingAmount.toString(),
    status: state.status,
    allocationCount: state.allocationCount,
  };
}

/** Derived settlement state for an invoice. Read-only; never mutates data. */
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
    const invoiceDocumentId = parseBillingDocumentId(id);

    const settlementState = await getInvoiceSettlementState({
      businessId: user.businessId,
      invoiceDocumentId,
    });

    return NextResponse.json(
      { settlementState: serializeSettlementState(settlementState) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
