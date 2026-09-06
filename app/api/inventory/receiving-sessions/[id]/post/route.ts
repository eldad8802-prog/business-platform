import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { receivingService } from "@/lib/services/inventory/receiving.service";
import { syncInventoryAlertNotifications } from "@/lib/notifications/inventory-alert-notifications";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parseReceivingSessionId(value: string): number {
  const receivingSessionId = Number(value);

  if (!receivingSessionId || Number.isNaN(receivingSessionId)) {
    throw new InventoryValidationError("Invalid receiving session id");
  }

  return receivingSessionId;
}

function handleInventoryError(error: unknown) {
  if (error instanceof InventoryUnauthorizedError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  if (error instanceof InventoryNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  if (
    error instanceof InventoryValidationError ||
    error instanceof NegativeInventoryError
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (error instanceof InventoryError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Receiving post route error:", error);

  return NextResponse.json(
    { error: "Internal server error" },
    { status: 500 }
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request);
    const params = await context.params;
    const receivingSessionId = parseReceivingSessionId(params.id);

    const result = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(
          (tx) =>
            receivingService.postReceivingSession(
              {
                businessId: user.businessId,
                receivingSessionId,
                postedByUserId: user.id,
              },
              { tx }
            ),
          { timeoutMs: 15_000 }
        )
    );

    // AFTER the receiving transaction above has committed. Reached only on a
    // committed post: a bad id, a missing session, a session that is no longer
    // DRAFT, and any rollback all throw before this line and land in the catch.
    //
    // One sync per posted session, not per received line. The reconciliation
    // covers the whole inventory domain for this business, so a session that
    // received twenty lines needs exactly one call.
    //
    // Receiving usually ADDS stock, so the interesting outcome here is normally
    // resolution rather than a new alert: an item that was critically low is
    // healthy again, the domain resolves its alert, and the sync closes the
    // matching notification.
    //
    // Cannot affect the response: the receipt is durable by now, and the sync
    // absorbs its own errors and returns them as data rather than throwing.
    // Tenant context is re-entered because the one above closed with the
    // transaction, and the writer refuses to run without a server-derived tenant.
    await runWithTenantContext({ businessId: user.businessId }, () =>
      syncInventoryAlertNotifications(user.businessId, new Date())
    );

    return NextResponse.json({
      success: true,
      receivingSession: result.receivingSession,
      movements: result.movements,
    });
  } catch (error) {
    return handleInventoryError(error);
  }
}
