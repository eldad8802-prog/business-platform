import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, authRequiredResponse } from "@/lib/auth";
import {
  requestAccountDeletion,
  AccountDeletionError,
} from "@/lib/services/account/account-deletion.service";
import { prismaAccountDeletionStore } from "@/lib/services/account/account-deletion.prisma-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-service account deletion (Wave 1B). Deletes/anonymizes the authenticated
 * user's OWN business account and revokes integrations, retaining legally-required
 * fiscal records. Sole-active-user only (v1); fails closed.
 */
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return authRequiredResponse(req);
  }

  try {
    const result = await requestAccountDeletion(prismaAccountDeletionStore, {
      businessId: user.businessId,
      actorUserId: user.id,
    });
    // SEC-E / H-5: "accepted" = quarantined and durably owed; the erasure sweeper
    // finishes it. Never a 500 the owner (whose session just ended) cannot retry.
    return NextResponse.json({ ok: true, status: result.status }, { status: result.status === "accepted" ? 202 : 200 });
  } catch (error) {
    if (error instanceof AccountDeletionError) {
      const status =
        error.code === "not_sole_user"
          ? 409
          : error.code === "business_not_found"
            ? 404
            : 400;
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
    }
    console.error("account deletion error:", error);
    return NextResponse.json({ ok: false, error: "Account deletion failed" }, { status: 500 });
  }
}
