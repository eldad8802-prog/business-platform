import { NextRequest, NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { revertBillingDocumentToDraft } from "@/lib/services/billing/billing-transition.service";

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
    const billingDocumentId = parseBillingDocumentId(id);

    const document = await revertBillingDocumentToDraft({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
    });

    return NextResponse.json({ document }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
