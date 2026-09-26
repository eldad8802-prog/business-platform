import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, authRequiredResponse } from "@/lib/auth";
import {
  readStepUpHeader,
  stepUpRequiredBody,
  verifyAndConsumeStepUp,
} from "@/lib/auth/step-up";
import {
  deleteOwnBusinessAccount,
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
  const context = await getAuthContext(req);
  if (!context) {
    return authRequiredResponse(req);
  }
  const user = context.user;

  // M-9: irreversible, so a bearer token alone is not enough. The caller must
  // present a fresh, single-use step-up token for exactly this action, bound to
  // this device and this token generation (POST /api/auth/step-up).
  const stepUp = await verifyAndConsumeStepUp(
    readStepUpHeader(req),
    { userId: user.id, sessionId: context.sessionId, tokenVersion: user.tokenVersion },
    "account.delete"
  );
  if (!stepUp.ok) {
    return NextResponse.json(stepUpRequiredBody(stepUp), {
      status: stepUp.reason === "unavailable" ? 503 : 403,
      headers: { "cache-control": "no-store" },
    });
  }

  try {
    const result = await deleteOwnBusinessAccount(prismaAccountDeletionStore, {
      businessId: user.businessId,
      actorUserId: user.id,
    });
    return NextResponse.json({ ok: true, status: result.status }, { status: 200 });
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
