import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { verifyAuthToken } from "./auth-token";

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
