import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { issueBillingDocument } from "@/lib/services/billing/billing-issue.service";

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
    const billingDocumentId = parseBillingDocumentId(id);

    const document = await issueBillingDocument({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
    });

    return NextResponse.json({ document }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
