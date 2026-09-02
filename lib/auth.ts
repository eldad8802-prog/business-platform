import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { verifyAuthTokenPayload } from "./auth-token";
import { acceptsNormalWrites } from "./tenant/business-lifecycle";

export {
  AuthTokenConfigError,
  signAuthToken,
  verifyAuthToken,
  verifyAuthTokenPayload,
} from "./auth-token";

/**
 * The single authentication chokepoint. Inventory (`lib/auth/inventory-auth.ts`)
 * and platform-admin (`lib/auth/platform-admin.ts`) both delegate here, so every
 * gate below applies to every authenticated surface in the product.
 *
 * A request is authenticated only if it clears all three, in this order:
 *
 *   1. token envelope   — authentic signature, known version, not expired
 *   2. account lifecycle — the business still accepts normal use (D2/AD-2A)
 *   3. session generation — the token belongs to the user's CURRENT session
 *
 * The order matters. Cheap cryptography first, then one database read, then the
 * two checks that need that row. Nothing below gate 1 runs for a forged token.
 */
export async function getCurrentUser(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return null;
    }

    // Gate 1 — envelope. Proves the token was minted here and has not expired.
    // It cannot prove the session is still current; that needs the row below.
    const verified = verifyAuthTokenPayload(token);
    if (verified === null) {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: { id: verified.userId },
      include: {
        business: true,
      },
    });

    if (!user) {
      return null;
    }

    // Gate 2 — account lifecycle (D2/AD-2A). Fail closed for a business under
    // account-deletion quarantine. Tokens are stateless HMAC with no server-side
    // session store, so this DB check IS the revocation boundary — and it must
    // fire the moment deletion is REQUESTED, not only once the purge has
    // finished. Checking deletedAt alone left the whole quarantine window
    // authenticated.
    if (user.business && !acceptsNormalWrites(user.business)) {
      return null;
    }

    // Gate 3 — session generation. The token carries the generation it was
    // minted under; logging out increments the user's generation, so every token
    // issued before that moment — including ones already copied off this device
    // — stops verifying here. Signing out used to be a purely client-side act:
    // the browser forgot the token, and the server went on honouring it until it
    // expired.
    //
    // Inequality rather than "older than", so a token from a FUTURE generation
    // is refused too. If those ever disagree in that direction something is
    // wrong, and the safe reading of "wrong" is "not authenticated".
    if (verified.tokenVersion !== user.tokenVersion) {
      return null;
    }

    return user;
  } catch (error) {
    console.error("getCurrentUser error:", error);
    return null;
  }
}

/** Standard 401 response for routes that require an authenticated user. */
export function authRequiredResponse(_req: Request): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
