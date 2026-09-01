/**
 * POST /api/platform-admin/mfa/enroll — begin TOTP enrollment (CASA 3.3.1).
 *
 * Identity-only guard by necessity: elevation cannot be a precondition for
 * obtaining elevation. The caller must still be an authenticated,
 * allowlisted PLATFORM_ADMIN, so an ordinary business user cannot reach this.
 *
 * Returns the provisioning URI EXACTLY ONCE. The seed is stored encrypted and
 * is never returned again — not by this route, not by any other. Enrollment is
 * not yet active: MFA turns on only after /confirm proves a real code.
 */
import { NextResponse } from "next/server";
import {
  requirePlatformAdminIdentityOrResponse,
} from "@/lib/auth/platform-admin";
import { beginAdminMfaEnrollment } from "@/lib/auth/admin-mfa.service";
import { isAdminMfaCryptoConfigured } from "@/lib/auth/admin-mfa-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePlatformAdminIdentityOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  // Fail closed rather than persisting a seed we cannot protect.
  if (!isAdminMfaCryptoConfigured()) {
    return NextResponse.json(
      { error: "MFA is not configured on this environment", code: "MFA_NOT_CONFIGURED" },
      { status: 503 }
    );
  }

  try {
    const result = await beginAdminMfaEnrollment(gate.id);
    if (!result.ok) {
      return NextResponse.json(
        {
          error:
            "This account already has an active authenticator. Reset it before enrolling again.",
          code: "ALREADY_ENROLLED",
        },
        { status: 409 }
      );
    }
    // The URI embeds the seed. It is returned once, never logged, and the
    // response is explicitly non-cacheable.
    return NextResponse.json(
      { otpauthUri: result.otpauthUri },
      { status: 200, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    // Never echo the error: it can carry configuration detail.
    console.error(
      "ADMIN_MFA_ENROLL_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Enrollment failed" }, { status: 500 });
  }
}
