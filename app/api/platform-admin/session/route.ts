import { NextRequest, NextResponse } from "next/server";
import {
  isPlatformAdminMfaRequired,
  requirePlatformAdminIdentityOrResponse,
} from "@/lib/auth/platform-admin";
import { getAdminMfaState } from "@/lib/auth/admin-mfa.service";
import {
  countActivePasskeysSafe,
  passkeyAvailability,
} from "@/lib/auth/admin-passkey.service";
import {
  readAdminElevationHeader,
  verifyAdminElevation,
} from "@/lib/auth/platform-admin-elevation";
import { handleError } from "@/lib/handle-error";
import { logPlatformAdminAreaEnteredIfDue } from "@/lib/services/platform-admin/platform-audit.service";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";

export async function GET(req: NextRequest) {
  try {
    // IDENTITY-ONLY by design: this is the endpoint the admin UI calls to find out
    // whether it must prompt for enrollment or for a code. Requiring elevation here
    // would make that impossible to discover.
    const auth = await requirePlatformAdminIdentityOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    await logPlatformAdminAreaEnteredIfDue(auth.id, req);

    const body: PlatformAdminSessionResponse = {
      admin: {
        id: auth.id,
        email: auth.email,
        name: auth.name,
      },
      serverTime: new Date().toISOString(),
      mfa: await (async () => {
        const state = await getAdminMfaState(auth.id);
        const elevation = verifyAdminElevation(readAdminElevationHeader(req), auth.id);
        return {
          required: isPlatformAdminMfaRequired(),
          enrolled: state.enrolled,
          elevated: elevation.ok,
          elevationExpiresAt: elevation.ok
            ? new Date(elevation.expiresAt * 1000).toISOString()
            : null,
          recoveryCodesRemaining: state.recoveryCodesRemaining,
          passkeys: {
            available: passkeyAvailability().enabled,
            count: await countActivePasskeysSafe(auth.id),
          },
        };
      })(),
      environment: process.env.NODE_ENV ?? "development",
      // NODE_ENV is "production" on Preview too; the console marks the real
      // deployment so a Production session is never mistaken for a test one.
      deployment:
        process.env.VERCEL_ENV === "production"
          ? "production"
          : process.env.VERCEL_ENV === "preview"
            ? "preview"
            : "local",
    };

    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
