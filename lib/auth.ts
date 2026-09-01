import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { verifyAuthToken } from "./auth-token";
import { acceptsNormalWrites } from "./tenant/business-lifecycle";

export { AuthTokenConfigError, signAuthToken, verifyAuthToken } from "./auth-token";

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

    const userId = verifyAuthToken(token);
    if (userId === null) {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        business: true,
      },
    });

    // Fail closed for a business under account-deletion quarantine (D2/AD-2A).
    // Tokens are stateless HMAC with no server-side session store, so this DB check
    // IS the revocation boundary — and it must fire the moment deletion is REQUESTED,
    // not only once the purge has finished. Checking deletedAt alone left the whole
    // quarantine window authenticated.
    if (user && user.business && !acceptsNormalWrites(user.business)) {
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
