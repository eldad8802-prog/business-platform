import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { approveSupplierPurchase } from "@/lib/services/inventory/supplier-purchase-approval.service";
import { syncInventoryAlertNotifications } from "@/lib/notifications/inventory-alert-notifications";
import { getInventoryAuthenticatedUser as getAuthenticatedUser } from '@/lib/auth/inventory-auth';
import {
  InventoryError,
  InventoryNotFoundError,
  InventoryUnauthorizedError,
  InventoryValidationError,
  NegativeInventoryError,
} from "@/lib/services/inventory/inventory.errors";

function parseDraftId(value: string): number {
  const draftId = Number(value);

  if (!draftId || Number.isNaN(draftId)) {
    throw new InventoryValidationError("Invalid supplier purchase draft id");
  }

  return draftId;
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

  if (error instanceof Error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("Supplier purchase approve route error:", error);

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
    const draftId = parseDraftId(params.id);
    const body = await request.json();

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      throw new InventoryValidationError("lines are required");
    }

    const result = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(
          (tx) =>
            approveSupplierPurchase(
              {
                draftId,
                businessId: user.businessId,
                userId: user.id,
                lines: body.lines,
              },
              { tx }
            ),
          { timeoutMs: 20_000 }
        )
    );

    // AFTER the whole approval transaction has committed. This flow is
    // compound: one transaction creates the purchase order, creates the
    // receiving session, POSTS it into inventory, and marks the draft and its
    // lines approved. So the sync belongs here and nowhere earlier — not after
    // session creation, which moves no stock, and not inside receiving.service,
    // which runs on this route's transaction and has a second commit owner of
    // its own.
    //
    // One sync per approval, not per line. Reached only on a committed
    // approval: the atomic PENDING_REVIEW -> APPROVED transition, every line
    // validation, and any rollback all throw before this and land in the catch.
    //
    // Approval receives goods, so the usual outcome is resolution: an item that
    // was critically low is replenished and its notification closes.
    //
    // Cannot affect the response: approval and receipt are durable by now, and
    // the sync absorbs its own errors and returns them as data. Tenant context
    // is re-entered because the one above closed with the transaction.
    await runWithTenantContext({ businessId: user.businessId }, () =>
      syncInventoryAlertNotifications(user.businessId, new Date())
    );

    return NextResponse.json(result);
  } catch (error) {
    return handleInventoryError(error);
  }
}