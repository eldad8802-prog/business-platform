/**
 * POST /api/platform-admin/passkeys/auth/options — start a passkey step-up.
 *
 * Identity-only guard by necessity (elevation cannot be a precondition for
 * obtaining it), exactly like /mfa/verify. Rate-limited per admin.
 */
import { NextResponse } from "next/server";
import { requirePlatformAdminIdentityOrResponse } from "@/lib/auth/platform-admin";
import { beginPasskeyAuthentication } from "@/lib/auth/admin-passkey.service";
import {
  NO_STORE,
  passkeyFailure,
  passkeyUnavailableResponse,
} from "@/lib/auth/admin-passkey-http";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePlatformAdminIdentityOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  const rl = await consumeRateLimit({
    key: `admin:passkey:options:${gate.id}`,
    limit: 20,
    windowMs: 5 * 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly.", code: "RATE_LIMITED" },
      { status: 429, headers: NO_STORE }
    );
  }

  try {
    const result = await beginPasskeyAuthentication(gate.id);
    if (!result.ok) {
      return NextResponse.json(
        { error: "No passkey on this account", code: "NO_PASSKEYS" },
        { status: 409, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { options: result.options, challengeToken: result.challengeToken },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    return (
      passkeyUnavailableResponse(error) ?? passkeyFailure("ADMIN_PASSKEY_AUTH_OPTIONS_ERROR", error)
    );
  }
}
