import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { replaceReceiptPaymentLines } from "@/lib/services/billing/receipt/billing-receipt-draft.service";
import { serializeBillingDocumentForApi } from "@/lib/services/billing/billing-document-api.serializer";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid billing document id");
  }
  return num;
}

/**
 * Replace the payment lines of a RECEIPT / TAX_INVOICE_RECEIPT draft.
 * Draft-only: the service rejects the mutation once the document is ISSUED.
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
    const billingDocumentId = parseBillingDocumentId(id);

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const payments = (body as { payments?: unknown }).payments;
    if (!Array.isArray(payments)) {
      throw new ValidationError("payments must be an array");
    }

    const document = await replaceReceiptPaymentLines({
      businessId: user.businessId,
      billingDocumentId,
      paymentLines: payments,
    });

    return NextResponse.json(
      { document: serializeBillingDocumentForApi(document) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
