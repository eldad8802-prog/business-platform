import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return authRequiredResponse(request);
    }

    const params = await context.params;
    const alertId = Number(params.id);

    if (!alertId || Number.isNaN(alertId)) {
      return NextResponse.json(
        { error: "Invalid alert id" },
        { status: 400 }
      );
    }

    // Tenant-scoped write: the businessId predicate lives in the UPDATE itself
    // (no id-only mutation window) inside a tenant transaction.
    const resolvedCount = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.inventoryAlert
            .updateMany({
              where: { id: alertId, businessId: user.businessId },
              data: {
                isResolved: true,
              },
            })
            .then((r) => r.count)
        )
    );

    if (resolvedCount !== 1) {
      return NextResponse.json(
        { error: "Alert not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Resolve alert error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}