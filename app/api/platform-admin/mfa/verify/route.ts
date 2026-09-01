/**
 * POST /api/platform-admin/mfa/verify — step up an existing admin session.
 *
 * Accepts a TOTP code or a single-use recovery code. On success it mints a
 * short-lived elevation bound to this admin's user id, which the privileged
 * guard requires once enforcement is on.
 *
 * Rate-limited: this is the one place a code can be guessed, and a six-digit
 * code has only a million values. The limiter is keyed by user, not IP, so it
 * cannot be spread across addresses.
 */
import { NextResponse } from "next/server";
import { requirePlatformAdminIdentityOrResponse } from "@/lib/auth/platform-admin";
import { verifyAdminMfaCode } from "@/lib/services/platform-admin/admin-mfa.service";
import {
  ADMIN_ELEVATION_TTL_SECONDS,
  issueAdminElevation,
} from "@/lib/auth/platform-admin-elevation";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requirePlatformAdminIdentityOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  // Anti-automation on the factor itself: 10 attempts per 5 minutes per admin.
  const rl = await consumeRateLimit({
    key: `admin:mfa:verify:${gate.id}`,
    limit: 10,
    windowMs: 5 * 60_000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly.", code: "RATE_LIMITED" },
      { status: 429 }
    );
  }

  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  try {
    const result = await verifyAdminMfaCode(gate.id, code);
    if (!result.ok) {
      // One generic refusal for every failure mode: a caller must not be able
      // to distinguish "wrong code" from "already used" from "not enrolled".
      const status = result.reason === "not_enrolled" || result.reason === "no_record" ? 409 : 401;
      return NextResponse.json(
        { error: "Verification failed", code: result.reason },
        { status }
      );
    }

    return NextResponse.json(
      {
        elevation: issueAdminElevation(gate.id),
        expiresInSeconds: ADMIN_ELEVATION_TTL_SECONDS,
        via: result.via,
      },
      { status: 200, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error(
      "ADMIN_MFA_VERIFY_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
