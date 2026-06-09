import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { issueBillingDocument } from "@/lib/services/billing/billing-issue.service";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import {
  readSessionIdFromRequest,
  recordProductUsageEvent,
} from "@/lib/services/product-usage/record-product-usage-event";
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

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  let billingDocumentId: number | null = null;
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await context.params;
    billingDocumentId = parseBillingDocumentId(id);

    const document = await issueBillingDocument({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
    });

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      sessionId: readSessionIdFromRequest(req),
      featureKey: PRODUCT_USAGE_FEATURES.BILLING_DOCUMENT_ISSUE,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
      entityType: "billing_document",
      entityId: String(billingDocumentId),
      metadata: { documentType: document.documentType },
    });

    return NextResponse.json(
      { document: serializeBillingDocumentForApi(document) },
      { status: 200 }
    );
  } catch (error) {
    const user = await getCurrentUser(req).catch(() => null);
    if (user) {
      await recordProductUsageEvent({
        businessId: user.businessId,
        userId: user.id,
        sessionId: readSessionIdFromRequest(req),
        featureKey: PRODUCT_USAGE_FEATURES.BILLING_DOCUMENT_ISSUE,
        action: PRODUCT_USAGE_ACTIONS.FAILED,
        outcome: PRODUCT_USAGE_OUTCOMES.FAILURE,
        entityType: "billing_document",
        entityId: billingDocumentId ? String(billingDocumentId) : null,
        metadata: { reason: "request_error" },
      });
    }
    return handleError(error);
  }
}
