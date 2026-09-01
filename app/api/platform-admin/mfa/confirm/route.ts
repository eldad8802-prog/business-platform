/**
 * POST /api/platform-admin/mfa/confirm — prove a code, then enable MFA.
 *
 * This is the only place MFA becomes active. An abandoned enrollment leaves the
 * record unconfirmed and MFA OFF, so a half-finished setup can never lock an
 * administrator out.
 *
 * Returns the single-use recovery codes EXACTLY ONCE. They are stored only as
 * SHA-256 hashes and cannot be retrieved again.
 */
import { NextResponse } from "next/server";
import { requirePlatformAdminIdentityOrResponse } from "@/lib/auth/platform-admin";
import { confirmAdminMfaEnrollment } from "@/lib/services/platform-admin/admin-mfa.service";
import { issueAdminElevation, ADMIN_ELEVATION_TTL_SECONDS } from "@/lib/auth/platform-admin-elevation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePlatformAdminIdentityOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  try {
    const result = await confirmAdminMfaEnrollment(gate.id, code);
    if (!result.ok) {
      const status = result.reason === "invalid_code" ? 401 : 409;
      return NextResponse.json({ error: "Could not confirm", code: result.reason }, { status });
    }

    // Confirming is itself a successful factor proof, so hand back an elevation
    // immediately — the admin should not have to enter a second code to keep
    // working right after enrolling.
    return NextResponse.json(
      {
        enrolled: true,
        recoveryCodes: result.recoveryCodes,
        elevation: issueAdminElevation(gate.id),
        elevationExpiresInSeconds: ADMIN_ELEVATION_TTL_SECONDS,
      },
      { status: 200, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error(
      "ADMIN_MFA_CONFIRM_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Confirmation failed" }, { status: 500 });
  }
}
