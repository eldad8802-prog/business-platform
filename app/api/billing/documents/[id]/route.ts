import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  updateBillingDraftHeader,
  UpdateBillingDraftHeaderInput,
} from "@/lib/services/billing/billing-draft.service";

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

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const billingDocumentId = parseBillingDocumentId(id);

    const document = await prisma.billingDocument.findFirst({
      where: {
        id: billingDocumentId,
        businessId: user.businessId,
      },
      include: {
        lines: { orderBy: { lineIndex: "asc" } },
      },
    });

    if (!document) {
      throw new NotFoundError("Billing document not found");
    }

    return NextResponse.json({ document }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const billingDocumentId = parseBillingDocumentId(id);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const input: UpdateBillingDraftHeaderInput = {
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
    };

    if ("customerId" in body) {
      input.customerId = body.customerId;
    }
    if ("customerNameSnapshot" in body) {
      input.customerNameSnapshot = body.customerNameSnapshot;
    }

    const document = await updateBillingDraftHeader(input);

    return NextResponse.json({ document }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
