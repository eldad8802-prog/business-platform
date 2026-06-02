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
    // Fail closed in production: an unset/empty PLATFORM_ADMIN_EMAILS must
    // never grant platform-admin access. Outside production we keep the
    // convenient open behavior so local dev/test do not require the env.
    return process.env.NODE_ENV !== "production";
  }
  return allowlist.has(email.trim().toLowerCase());
}

/**
 * Requires a valid Bearer token, PLATFORM_ADMIN role, and membership in
 * PLATFORM_ADMIN_EMAILS. In production an unset/empty allowlist denies all
 * access (fail closed); in dev/test an empty allowlist is permissive.
 */
export async function requirePlatformAdmin(
  req: Request
): Promise<PlatformAdminUser> {
  const user = await getCurrentUser(req);

  if (!user) {
    throw new UnauthorizedError();
  }

  if (user.role !== UserRole.PLATFORM_ADMIN) {
    throw new ForbiddenError();
  }

  if (!isEmailAllowlisted(user.email)) {
    throw new ForbiddenError();
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
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
