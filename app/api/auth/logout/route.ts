/**
 * Logout.
 *
 * WHY THIS EXISTS: signing out was previously a client-side act only. The
 * browser deleted its copy of the token and navigated to /login, and the server
 * was never told. The token itself stayed valid until it expired, so anyone who
 * already held a copy — a shared machine, a synced browser profile, anything
 * that had read localStorage — kept full access to the business after the owner
 * believed they had left.
 *
 * Logging out now increments the user's token generation, which invalidates
 * every token issued before this moment. That is deliberately global rather than
 * per-device: there is no device identity in a stateless token to revoke
 * individually, and someone signing out of a machine they do not trust is better
 * served by ending every session than by ending the one they are looking at.
 *
 * This is NOT affected by the public-signup gate. Closing registration stops new
 * accounts being created; it has nothing to do with existing users ending their
 * own sessions.
 */

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  PRODUCT_USAGE_ACTIONS,
  PRODUCT_USAGE_FEATURES,
  PRODUCT_USAGE_OUTCOMES,
} from "@/lib/services/product-usage/product-usage-catalog";
import { recordProductUsageEvent } from "@/lib/services/product-usage/record-product-usage-event";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    // No valid session to end. This is success, not an error: the caller wanted
    // to not be logged in, and they are not logged in. Returning 401 here would
    // make the client treat an already-expired session as a failed logout and
    // leave its local state behind.
    if (!user) {
      return NextResponse.json({ success: true, alreadySignedOut: true });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    await recordProductUsageEvent({
      businessId: user.businessId,
      userId: user.id,
      featureKey: PRODUCT_USAGE_FEATURES.AUTH_LOGOUT,
      action: PRODUCT_USAGE_ACTIONS.COMPLETED,
      outcome: PRODUCT_USAGE_OUTCOMES.SUCCESS,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("LOGOUT_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
