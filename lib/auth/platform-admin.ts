import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import {
  readAdminElevationHeader,
  verifyAdminElevation,
} from "./platform-admin-elevation";

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
 * CASA 3.3.1 enforcement switch.
 *
 * OFF during B-3a so the sole production administrator can reach the enrollment
 * flow; ON in B-3b once enrollment is proven. Enforcement is read per request,
 * so disabling it is an environment change and needs no redeploy — which is the
 * break-glass if elevation ever misbehaves.
 */
export function isPlatformAdminMfaRequired(): boolean {
  return process.env.PLATFORM_ADMIN_MFA_REQUIRED?.trim().toLowerCase() === "true";
}

/**
 * IDENTITY ONLY — valid Bearer token, PLATFORM_ADMIN role, and membership in
 * PLATFORM_ADMIN_EMAILS. An unset/empty allowlist denies all access in EVERY
 * environment (fail closed — no dev/test bypass).
 *
 * This deliberately does NOT check MFA elevation, and exists for exactly two
 * kinds of caller: the MFA enrollment/verification endpoints themselves (which
 * would otherwise be unreachable — you cannot require elevation in order to
 * obtain elevation), and the session endpoint the admin UI uses to discover
 * whether it must prompt for enrollment or a code.
 *
 * Everything else must use `requirePlatformAdmin`.
 */
export async function requirePlatformAdminIdentity(
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

/**
 * The canonical privileged guard: platform-admin identity AND, when enforcement
 * is on, a valid MFA elevation bound to that same user.
 *
 * Keeping the MFA requirement inside the existing guard name is deliberate —
 * every current privileged route already calls this, so enforcement lands on all
 * of them at once rather than route by route, and CI-3 keeps new routes covered.
 */
export async function requirePlatformAdmin(
  req: Request
): Promise<PlatformAdminUser> {
  const admin = await requirePlatformAdminIdentity(req);

  if (isPlatformAdminMfaRequired()) {
    const result = verifyAdminElevation(
      readAdminElevationHeader(req),
      admin.id
    );
    if (!result.ok) {
      // Distinct code so the UI can prompt for a code (or for enrollment)
      // instead of showing a generic refusal. Never leaks why beyond the reason.
      throw new ForbiddenError(
        "Multi-factor elevation required",
        ADMIN_MFA_REQUIRED_CODE
      );
    }
  }

  return admin;
}

/** Error code surfaced to the admin UI when a step-up is needed. */
export const ADMIN_MFA_REQUIRED_CODE = "ADMIN_MFA_REQUIRED";

export function requirePlatformAdminOrResponse(
  req: Request
): Promise<PlatformAdminUser | NextResponse> {
  return requirePlatformAdmin(req).catch((error: unknown) => {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: 403 }
      );
    }
    throw error;
  });
}

/** Identity-only variant, response-wrapped. See `requirePlatformAdminIdentity`. */
export function requirePlatformAdminIdentityOrResponse(
  req: Request
): Promise<PlatformAdminUser | NextResponse> {
  return requirePlatformAdminIdentity(req).catch((error: unknown) => {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  });
}

/**
 * True when this request carries a valid elevation for `userId`. Used by
 * privileged capabilities that live OUTSIDE the admin namespace and therefore
 * cannot simply call the guard — see the cross-tenant branch of the Tax
 * Authority OAuth start.
 */
export function hasAdminElevation(req: Request, userId: number): boolean {
  if (!isPlatformAdminMfaRequired()) return true;
  return verifyAdminElevation(readAdminElevationHeader(req), userId).ok;
}
