/**
 * The DEDICATED permission to review and decide legal identity correction requests (owner decision 2026-11-13).
 *
 * Built on the existing platform-admin model — no parallel permission system:
 *   1. the caller is a platform admin (`assertPlatformAdminAccess`: PLATFORM_ADMIN role AND PLATFORM_ADMIN_EMAILS);
 *   2. AND the caller's email is in PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS (same parsing, same fail-closed rule:
 *      unset or empty denies EVERYONE — there is no dev/test bypass).
 * The database enforces its own, independent layer: legal_identity_correction_decide / _request_info refuse an
 * approver who has no row in "LegalIdentityApprover", is the requester, or belongs to the request's business.
 * Neither layer is enough alone; both must agree.
 *
 * Pure (no database): the env list is read per call, so revoking someone is an environment change, no redeploy.
 */

import type { UserRole } from "@prisma/client";

import { assertPlatformAdminAccess } from "@/lib/auth/platform-admin";

export const LEGAL_IDENTITY_APPROVER_REQUIRED_CODE = "LEGAL_IDENTITY_APPROVER_REQUIRED";

function parseApproverEmails(raw: string | undefined): Set<string> {
  const value = raw?.trim();
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * True only for a platform admin whose email is on the approver list. Never throws: any refusal of the
 * platform-admin check (no user, wrong role, not on PLATFORM_ADMIN_EMAILS) is simply "not an approver".
 */
export function isLegalIdentityApprover(
  user: { role: UserRole; email: string } | null,
  env: Record<string, string | undefined> = process.env
): boolean {
  try {
    assertPlatformAdminAccess(user);
  } catch {
    return false;
  }
  const approvers = parseApproverEmails(env.PLATFORM_ADMIN_LEGAL_IDENTITY_APPROVERS);
  if (approvers.size === 0) return false;
  return approvers.has((user as { email: string }).email.trim().toLowerCase());
}
