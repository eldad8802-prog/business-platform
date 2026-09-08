/**
 * TEMPORARY Platform-Admin diagnostic: auth-plane RUNTIME IDENTITY probe.
 *
 * Path: POST /api/platform-admin/diagnostics/auth-plane-identity
 *
 * Answers exactly one question that cannot be answered any other way:
 * which database role does `authDb()` actually authenticate as in Production?
 *
 * `AUTH_DATABASE_URL` is a Vercel "sensitive" variable, so its value can never
 * be read back — not by the CLI, not by the API. That is the correct posture
 * for a database credential, and it is also why the identity behind it cannot
 * be inspected from outside. The only remaining way to observe it is to ask the
 * connection itself, from inside the runtime that opens it.
 *
 * This matters because the tenant plane now holds ZERO privilege on
 * "AuthSession" and "AuthSessionSecret". If the auth plane were serving on any
 * other identity, the refresh-session consumer would fail closed with
 * `permission denied` on its very first request. Proving the identity BEFORE
 * that consumer exists is the difference between a check and an outage.
 *
 * This is a THROWAWAY operational tool — it must be removed in a follow-up PR
 * immediately after a single run. It is NOT part of the product API. Protected
 * solely by the canonical Platform-Admin guard used across
 * app/api/platform-admin/* (Bearer + PLATFORM_ADMIN role + email allowlist +
 * MFA elevation), which fails closed. No feature flag, no secret header, no new
 * env var, and deliberately no reliance on the URL being hard to guess.
 *
 * Returns a single boolean. The role name is written to the server log only, so
 * even an authorized caller never receives connection metadata over the wire.
 * Never returns or logs the URL, host, database, user or password.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdminOrResponse,
  type PlatformAdminUser,
} from "@/lib/auth/platform-admin";
import { authDb } from "@/lib/prisma-auth";

// Node.js runtime (match the auth paths); never statically optimized/cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The identity the approved privilege contract was written for. */
export const EXPECTED_AUTH_ROLE = "app_auth_prod";

export type AuthPlaneIdentityDeps = {
  authorize?: (req: Request) => Promise<PlatformAdminUser | NextResponse>;
  readCurrentUser?: () => Promise<string | null>;
};

/**
 * The whole probe: one constant statement, no parameters, no interpolation, no
 * user input anywhere near it. Read through `authDb()` deliberately — a fresh
 * client built from the same URL would prove something about this file rather
 * than about the client the auth paths actually use.
 *
 * The first column of the first row is taken by position: `current_user` is a
 * reserved word, so the key the driver reports for it is not worth depending on.
 */
async function readCurrentUserFromAuthPlane(): Promise<string | null> {
  const rows = await authDb().$queryRaw<Record<string, unknown>[]>`SELECT current_user`;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const value = row ? Object.values(row)[0] : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Testable handler: canonical Platform-Admin authorization (fail-closed) → one
 * read-only statement. Non-admins never reach the database.
 */
export async function handleAuthPlaneIdentityProbe(
  req: NextRequest,
  deps: AuthPlaneIdentityDeps = {}
): Promise<NextResponse> {
  const authorize = deps.authorize ?? requirePlatformAdminOrResponse;
  const readCurrentUser = deps.readCurrentUser ?? readCurrentUserFromAuthPlane;

  try {
    const auth = await authorize(req);
    if (auth instanceof NextResponse) {
      // 401/403 straight from the canonical guard — the probe never runs.
      return auth;
    }

    const currentUser = await readCurrentUser();

    // Server-side evidence. A PostgreSQL role name is not a credential, but it
    // is connection metadata, so it stays out of the HTTP response and lives
    // only in the runtime log the operator already has to be able to read.
    console.log(
      "AUTH_PLANE_IDENTITY_PROBE:",
      currentUser ?? "(no row returned)"
    );

    return NextResponse.json(
      { matchesExpected: currentUser === EXPECTED_AUTH_ROLE },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    // Log only the error name — never the message/stack, which can carry the
    // connection string on a driver-level failure.
    console.error(
      "AUTH_PLANE_IDENTITY_PROBE_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return handleAuthPlaneIdentityProbe(req);
}
