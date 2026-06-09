import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { replaceBillingDraftLines } from "@/lib/services/billing/billing-draft.service";
import { serializeBillingDocumentForApi } from "@/lib/services/billing/billing-document-api.serializer";

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

export async function PUT(
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

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    if (!Array.isArray(body.lines)) {
      throw new ValidationError("lines must be an array");
    }

    const document = await replaceBillingDraftLines({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
      lines: body.lines,
    });

    return NextResponse.json(
      { document: serializeBillingDocumentForApi(document) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
