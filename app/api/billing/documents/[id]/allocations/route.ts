import { NextRequest, NextResponse } from "next/server";
import type { BillingPaymentAllocation } from "@prisma/client";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { setReceiptAllocations } from "@/lib/services/billing/receipt/billing-payment-allocation.service";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid billing document id");
  }
  return num;
}

function serializeAllocation(a: BillingPaymentAllocation) {
  return {
    id: a.id,
    receiptDocumentId: a.receiptDocumentId,
    invoiceDocumentId: a.invoiceDocumentId,
    allocatedAmount: a.allocatedAmount.toString(),
    currency: a.currency,
  };
}

/**
 * Replace the invoice allocations of a pure RECEIPT draft. Draft-only; the
 * service enforces ISSUED-only invoices, same business/currency, and no
 * over-allocation, and rejects mutation once the receipt is ISSUED.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await context.params;
    const receiptDocumentId = parseBillingDocumentId(id);

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const allocations = (body as { allocations?: unknown }).allocations;
    if (!Array.isArray(allocations)) {
      throw new ValidationError("allocations must be an array");
    }

    const result = await setReceiptAllocations({
      businessId: user.businessId,
      receiptDocumentId,
      allocations,
    });

    return NextResponse.json(
      { allocations: result.map(serializeAllocation) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
