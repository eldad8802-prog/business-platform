import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

export type PlatformAdminUser = {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
};

function parsePlatformAdminEmails(): Set<string> {
  const raw = process.env.PLATFORM_ADMIN_EMAILS?.trim();
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isEmailAllowlisted(email: string): boolean {
  const allowlist = parsePlatformAdminEmails();
  if (allowlist.size === 0) {
    // Fail closed EVERYWHERE (D2/P7-W2-GATE hardening): an unset/empty
    // PLATFORM_ADMIN_EMAILS denies all platform-admin access in every
    // environment. There is deliberately NO dev/test bypass — once an admin
    // DB credential exists, no admin surface may be reachable through a
    // weaker auth path. Local dev/tests must set an explicit allowlist.
    return false;
  }
  return allowlist.has(email.trim().toLowerCase());
}

/**
 * Pure access decision (exported for the mechanical test matrix): throws
 * UnauthorizedError for a missing user, ForbiddenError for wrong role or a
 * non-allowlisted email. An unset/empty allowlist denies EVERYONE.
 */
export function assertPlatformAdminAccess(
  user: { role: UserRole; email: string } | null
): void {
  if (!user) {
    throw new UnauthorizedError();
  }
  if (user.role !== UserRole.PLATFORM_ADMIN) {
    throw new ForbiddenError();
  }
  if (!isEmailAllowlisted(user.email)) {
    throw new ForbiddenError();
  }
}

/**
 * Requires a valid Bearer token, PLATFORM_ADMIN role, and membership in
 * PLATFORM_ADMIN_EMAILS. An unset/empty allowlist denies all access in EVERY
 * environment (fail closed — no dev/test bypass).
 */
export async function requirePlatformAdmin(
  req: Request
): Promise<PlatformAdminUser> {
  const user = await getCurrentUser(req);

  assertPlatformAdminAccess(user);
  const admin = user as NonNullable<typeof user>;

  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
  };
}

export function requirePlatformAdminOrResponse(
  req: Request
): Promise<PlatformAdminUser | NextResponse> {
  return requirePlatformAdmin(req).catch((error: unknown) => {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  });
}
