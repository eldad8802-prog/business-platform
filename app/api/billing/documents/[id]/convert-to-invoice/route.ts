import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { convertQuoteToInvoice } from "@/lib/services/billing/convert-quote-to-invoice.service";

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

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const quoteBillingDocumentId = parseBillingDocumentId(id);

    const invoice = await convertQuoteToInvoice({
      businessId: user.businessId,
      actorUserId: user.id,
      quoteBillingDocumentId,
    });

    return NextResponse.json({ document: invoice }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
