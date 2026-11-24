/**
 * The HTTP boundary of the subscriptions & quotas admin routes (subscriptions stage C). SERVER-ONLY.
 *   reads  — an authenticated PLATFORM_ADMIN;
 *   writes — PLATFORM_ADMIN → a FRESH second factor (minted in the last five minutes) → the
 *            SUBSCRIPTION_ADMIN_CHANGES_ENABLED switch (off by default: 503) → the definer-function write, which checks
 *            the actor again inside the database and writes its audit row.
 * Identity before anything is disclosed; the actor is the authenticated admin, never a body field.
 */
import { NextRequest, NextResponse } from "next/server";

import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { ServiceUnavailableError, ValidationError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import { isSubscriptionAdminChangesEnabled } from "@/lib/services/platform-admin/update-business-subscription.service";

const NO_STORE = { "Cache-Control": "no-store" };

export async function adminRead(req: NextRequest, fn: (adminId: number) => Promise<unknown>): Promise<NextResponse> {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    return NextResponse.json(await fn(auth.id), { headers: NO_STORE });
  } catch (error) {
    return handleError(error);
  }
}

export async function adminWrite(
  req: NextRequest,
  fn: (adminId: number, body: Record<string, unknown>) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    const stepUp = freshStepUpRefusal(req, auth.id);
    if (stepUp) return stepUp;
    if (!isSubscriptionAdminChangesEnabled()) throw new ServiceUnavailableError();
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Invalid request body");
    return NextResponse.json(await fn(auth.id, body as Record<string, unknown>), { headers: NO_STORE });
  } catch (error) {
    return handleError(error);
  }
}
