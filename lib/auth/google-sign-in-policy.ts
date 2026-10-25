/**
 * Who a verified Google identity may sign in as — checked BEFORE any session is issued.
 *
 * A Google sign-in reaches an account only through a linked subject (lib/auth/oauth-ticket.ts
 * resolveGoogleIdentity), and even then it never bypasses the gates a session is held to:
 *   - a business under account-deletion quarantine (requested or purged) gets no session at all — the
 *     same lifecycle rule getAuthContext and refresh enforce on every request, applied up front;
 *   - a platform administrator does not sign in with Google in version 1 (owner decision, 2026-10-25):
 *     the admin entry keeps its own password + MFA path, unchanged.
 *
 * Scope: the Google path only. The password login route is NOT changed by this module; aligning it with
 * the lifecycle rule is the separate fix F-1, which needs its own approval.
 */

import { UserRole } from "@prisma/client";

import { acceptsNormalWrites, type BusinessLifecycleRow } from "@/lib/tenant/business-lifecycle";

export type GoogleSignInRefusal = "PLATFORM_ADMIN" | "BUSINESS_UNAVAILABLE";

export type GoogleSignInCandidate = {
  role: UserRole;
  business: BusinessLifecycleRow | null;
};

/** Null when the account may receive a session through Google; otherwise why not. */
export function googleSignInRefusal(user: GoogleSignInCandidate): GoogleSignInRefusal | null {
  if (user.role === UserRole.PLATFORM_ADMIN) return "PLATFORM_ADMIN";
  if (!user.business || !acceptsNormalWrites(user.business)) return "BUSINESS_UNAVAILABLE";
  return null;
}
