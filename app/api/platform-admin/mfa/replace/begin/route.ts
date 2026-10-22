/**
 * POST /api/platform-admin/mfa/replace/begin — start replacing this admin's
 * authenticator app (a new phone, or a lost one after a recovery-code step-up).
 *
 * FULL guard plus a step-up from the last 5 minutes: changing a factor must not
 * ride on an elevation that is merely still alive. Nothing is written here — the
 * new seed travels encrypted in a short-lived envelope, and the CURRENT
 * authenticator keeps working until /replace/confirm proves a code from the new
 * one. Returns the provisioning URI exactly once.
 */
import { NextResponse } from "next/server";
import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { beginAdminMfaReplacement } from "@/lib/auth/admin-mfa.service";
import { isAdminMfaCryptoConfigured } from "@/lib/auth/admin-mfa-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(req: Request) {
  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;
  const stale = freshStepUpRefusal(req, gate.id);
  if (stale) return stale;

  if (!isAdminMfaCryptoConfigured()) {
    return NextResponse.json(
      { error: "MFA is not configured on this environment", code: "MFA_NOT_CONFIGURED" },
      { status: 503 }
    );
  }

  try {
    const result = await beginAdminMfaReplacement(gate.id);
    if (!result.ok) {
      return NextResponse.json(
        { error: "No active authenticator to replace", code: "NOT_ENROLLED" },
        { status: 409, headers: NO_STORE }
      );
    }
    // The URI embeds the seed: returned once, never logged, never cached.
    return NextResponse.json(
      { otpauthUri: result.otpauthUri, replacementToken: result.replacementToken },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    console.error("ADMIN_MFA_REPLACE_BEGIN_ERROR:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Replacement failed" }, { status: 500 });
  }
}
