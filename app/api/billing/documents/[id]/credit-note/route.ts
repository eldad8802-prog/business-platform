import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { createBillingCreditNoteDraft } from "@/lib/services/billing/billing-credit-reversal.service";

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
      return authRequiredResponse(req);
    }

    const { id } = await context.params;
    const sourceBillingDocumentId = parseBillingDocumentId(id);

    const creditNote = await createBillingCreditNoteDraft({
      businessId: user.businessId,
      actorUserId: user.id,
      sourceBillingDocumentId,
    });

    return NextResponse.json({ creditNoteId: creditNote.id }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
