/**
 * POST /api/platform-admin/passkeys/register/options — start adding a passkey.
 *
 * FULL guard: only an admin who has ALREADY proven a factor in the last
 * 15 minutes may add another one, so a stolen session can never plant a factor.
 */
import { NextResponse } from "next/server";
import { freshStepUpRefusal, requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { beginPasskeyRegistration } from "@/lib/auth/admin-passkey.service";
import {
  NO_STORE,
  passkeyFailure,
  passkeyUnavailableResponse,
} from "@/lib/auth/admin-passkey-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;
  // Changing a factor needs a step-up from the last few minutes, not just a live one.
  const stale = freshStepUpRefusal(req, gate.id);
  if (stale) return stale;

  try {
    const result = await beginPasskeyRegistration(gate);
    if (!result.ok) {
      return NextResponse.json(
        { error: "This account already has the maximum number of passkeys", code: "TOO_MANY_PASSKEYS" },
        { status: 409, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { options: result.options, challengeToken: result.challengeToken },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    return (
      passkeyUnavailableResponse(error) ??
      passkeyFailure("ADMIN_PASSKEY_REGISTER_OPTIONS_ERROR", error)
    );
  }
}
