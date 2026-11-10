import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { buildAuthorityDocumentState } from "@/lib/services/billing/authority/billing-authority-document-state";
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

    const document = await billingTenantTx(user.businessId, (tx) =>
      tx.billingDocument.findFirst({
        where: {
          id: billingDocumentId,
          businessId: user.businessId,
        },
        include: {
          lines: { orderBy: { lineIndex: "asc" } },
          // Read-only: the allocation state the screen shows after a reload.
          authoritySubmission: {
            select: { status: true, errorCode: true, heldDecisionType: true, heldDecisionReportedAt: true },
          },
        },
      })
    );

    if (!document) {
      throw new NotFoundError("Billing document not found");
    }

    // The raw submission row stays server-side; the screen gets the derived state,
    // decided by the same delivery rule as the PDF route.
    const { authoritySubmission, ...rest } = document;
    const authorityState = buildAuthorityDocumentState({
      documentStatus: document.status,
      documentType: document.documentType,
      allocationNumber: document.allocationNumber,
      submission: authoritySubmission,
    });

    return NextResponse.json({ document: { ...rest, authorityState } }, { status: 200 });
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

    if ("validUntil" in body) {
      const raw = body.validUntil;
      if (raw === null || raw === "") {
        input.validUntil = null;
      } else if (typeof raw === "string") {
        input.validUntil = raw;
      } else {
        throw new ValidationError("validUntil must be a string, null, or empty");
      }
    }

    const document = await updateBillingDraftHeader(input);

    return NextResponse.json({ document }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
