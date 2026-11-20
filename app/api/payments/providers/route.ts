import { NextRequest, NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { listProviderDescriptors } from "@/lib/services/payments/providers/provider-registry";

export const runtime = "nodejs";

/**
 * Provider catalog for the data-driven connection UI. Metadata ONLY — key,
 * label, field definitions, capabilities. Never any secret or connection value.
 * Adding a provider surfaces here automatically (no UI/route change).
 */
export async function GET(req: NextRequest) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.BILLING);
  if (featureDenied) return featureDenied;
  try {
    const user = await getCurrentUser(req);
    authorizePaymentAction(user, PAYMENT_ACTIONS.CONNECT_PROVIDER);
    return NextResponse.json(
      { providers: listProviderDescriptors() },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
