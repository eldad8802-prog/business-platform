import { NextRequest, NextResponse } from "next/server";
import { reserveBusinessDocument } from "@/lib/services/subscriptions/usage/business-document-usage";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
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
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.BILLING);
  if (featureDenied) return featureDenied;
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const quoteBillingDocumentId = parseBillingDocumentId(id);

    // Subscriptions stage C — the invoice is a NEW business document (a new draft): reserved atomically before, kept
    // when it exists, released when the conversion failed.
    const unit = await reserveBusinessDocument(user.businessId, { kind: "billing", source: "billing.quote.convert", documentType: "TAX_INVOICE" });
    if (unit.denied) return unit.denied;
    let invoice: Awaited<ReturnType<typeof convertQuoteToInvoice>>;
    try {
      invoice = await convertQuoteToInvoice({
        businessId: user.businessId,
        actorUserId: user.id,
        quoteBillingDocumentId,
      });
    } catch (error) {
      await unit.release();
      throw error;
    }
    await unit.commit();

    return NextResponse.json({ document: invoice }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
