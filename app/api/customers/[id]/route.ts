import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getCustomerCard } from "@/lib/services/crm/customer-card.read-model";

/**
 * Customer Card read-model. Returns the customer plus its REAL related rows
 * (billing documents, payment requests, conversations, appointments), all
 * tenant-scoped. No fabricated status or financial rollups.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await context.params;

    const card = await getCustomerCard({
      businessId: user.businessId,
      customerId: Number(id),
    });

    return NextResponse.json(card, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
