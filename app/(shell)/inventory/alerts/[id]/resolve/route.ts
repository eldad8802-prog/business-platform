import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { syncInventoryAlertNotifications } from "@/lib/notifications/inventory-alert-notifications";

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
        withTenantTransaction(async (tx) => {
          // M5.5 — stamp resolvedAt only on the transition from open. Resolving an already-resolved
          // alert keeps succeeding (same response as before) but must not move its resolution time.
          const opened = await tx.inventoryAlert.updateMany({
            where: { id: alertId, businessId: user.businessId, isResolved: false },
            data: { isResolved: true, resolvedAt: new Date() },
          });
          if (opened.count === 1) return 1;
          return tx.inventoryAlert.count({
            where: { id: alertId, businessId: user.businessId },
          });
        })
    );

    if (resolvedCount !== 1) {
      return NextResponse.json(
        { error: "Alert not found" },
        { status: 404 }
      );
    }

    // After commit, like every other route that opens or closes inventory alerts
    // (movements, sales, receiving, approvals): reconcile the notification centre
    // with the open alerts. Same sync, same policy; it never throws.
    await runWithTenantContext({ businessId: user.businessId }, () =>
      syncInventoryAlertNotifications(user.businessId, new Date())
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Resolve alert error:", error instanceof Error ? error.name : "unknown");

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}