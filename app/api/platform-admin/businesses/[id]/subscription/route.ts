/**
 * PATCH /api/platform-admin/businesses/:id/subscription — subscriptions stage B: the admin's manual change of a
 * business's account type and plan. Body: { accountType: "TESTER" | "INTERNAL" | "CUSTOMER", plan, reason }.
 *
 * Order (identity before anything is disclosed): platform admin → a FRESH second factor (minted in the last five
 * minutes — a commercial change) → the SUBSCRIPTION_ADMIN_CHANGES_ENABLED switch (off by default: 503) → the
 * write (update-business-subscription.service.ts). The actor is the authenticated admin, never a body field.
 * Shadow only: the record grants and refuses nothing yet.
 */
import { NextRequest, NextResponse } from "next/server";

import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import {
  isSubscriptionAdminChangesEnabled,
  updateBusinessSubscription,
} from "@/lib/services/platform-admin/update-business-subscription.service";

function parseBusinessId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError("Invalid business id");
  return id;
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;

    const stepUp = freshStepUpRefusal(req, auth.id);
    if (stepUp) return stepUp;

    if (!isSubscriptionAdminChangesEnabled()) throw new ServiceUnavailableError();

    const { id } = await context.params;
    const businessId = parseBusinessId(id);
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new ValidationError("Invalid request body");
    const record = body as Record<string, unknown>;

    const result = await updateBusinessSubscription({
      actorUserId: auth.id,
      businessId,
      request: { accountType: record.accountType, plan: record.plan ?? null, reason: record.reason },
      req,
    });
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
