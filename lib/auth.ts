import { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import {
  BUSINESS_ARCHIVED_ERROR_CODE,
  BUSINESS_ARCHIVED_MESSAGE,
  BusinessArchivedError,
  UnauthorizedError,
} from "@/lib/errors";
import { prisma } from "./prisma";
import { verifyAuthToken } from "./auth-token";

export { AuthTokenConfigError, signAuthToken, verifyAuthToken } from "./auth-token";
export { BusinessArchivedError, BUSINESS_ARCHIVED_ERROR_CODE, BUSINESS_ARCHIVED_MESSAGE };

const ARCHIVE_GATE_BLOCKED = Symbol.for("dubiz.auth.archiveGateBlocked");

type RequestWithArchiveGate = Request & {
  [ARCHIVE_GATE_BLOCKED]?: boolean;
};

export type GetCurrentUserOptions = {
  /** Platform Admin and /api/auth/me bypass tenant archive gate. */
  skipArchiveGate?: boolean;
};

export function businessArchivedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: BUSINESS_ARCHIVED_ERROR_CODE,
      message: BUSINESS_ARCHIVED_MESSAGE,
    },
    { status: 403 }
  );
}

function markArchiveGateBlocked(req: Request): void {
  (req as RequestWithArchiveGate)[ARCHIVE_GATE_BLOCKED] = true;
}

export function wasArchiveGateBlocked(req: Request): boolean {
  return Boolean((req as RequestWithArchiveGate)[ARCHIVE_GATE_BLOCKED]);
}

/** Resolve null from getCurrentUser into 401 Unauthorized vs 403 BUSINESS_ARCHIVED. */
export function authRequiredResponse(req: Request): NextResponse {
  if (wasArchiveGateBlocked(req)) {
    return businessArchivedResponse();
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function requireTenantUser(req: Request, user: User | null): User {
  if (!user) {
    if (wasArchiveGateBlocked(req)) {
      throw new BusinessArchivedError();
    }
    throw new UnauthorizedError();
  }

  return user;
}

export async function getCurrentUser(
  req: Request,
  options?: GetCurrentUserOptions
) {
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

    if (!user) {
      return null;
    }

    if (user.business?.archivedAt && !options?.skipArchiveGate) {
      markArchiveGateBlocked(req);
      return null;
    }

    return user;
  } catch (error) {
    console.error("getCurrentUser error:", error);
    return null;
  }
}
