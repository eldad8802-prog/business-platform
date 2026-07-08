import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getOpenReceivables } from "@/lib/services/billing/receivables.service";

/**
 * Read-only open receivables (issued tax invoices not yet collected).
 * Pure derivation over Billing data — no new source of truth.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const result = await getOpenReceivables(user.businessId);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
