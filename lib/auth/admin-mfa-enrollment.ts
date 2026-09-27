/**
 * Platform-admin MFA ENROLLMENT AUTHORITY (M-10).
 *
 * Enrollment used to require only the admin identity (bearer + role +
 * allowlist). While no authenticator was confirmed, anyone holding a stolen
 * admin bearer could call /enroll, receive a seed of THEIR choosing into their
 * own authenticator, /confirm it, and obtain elevation — trust on first use,
 * handed to whoever used it first.
 *
 * Enrollment now also requires an OUT-OF-BAND bootstrap code: a high-entropy
 * secret the owner generates and holds, whose SHA-256 is set as
 * PLATFORM_ADMIN_ENROLLMENT_CODE_HASH (64 hex chars) in the deployment. The
 * plaintext never touches the server's configuration. Comparison is constant
 * time. When the variable is unset or malformed enrollment is DISABLED
 * (fail-closed) in every environment.
 *
 * One-time use is OPERATIONAL, not stored (no schema): the code is only usable
 * while the admin has no confirmed authenticator (re-enrollment of an active
 * authenticator is refused), and the owner removes/rotates the variable after
 * enrolling. Enrollment attempts are rate-limited per admin and per address.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const ENROLLMENT_CODE_ENV = "PLATFORM_ADMIN_ENROLLMENT_CODE_HASH";

export type EnrollmentCodeVerdict = "ok" | "disabled" | "invalid";

function configuredHash(): Buffer | null {
  const raw = process.env[ENROLLMENT_CODE_ENV]?.trim().toLowerCase();
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  return Buffer.from(raw, "hex");
}

export function isAdminEnrollmentEnabled(): boolean {
  return configuredHash() !== null;
}

export function verifyAdminEnrollmentCode(code: unknown): EnrollmentCodeVerdict {
  const expected = configuredHash();
  if (!expected) return "disabled";
  if (typeof code !== "string" || code.length === 0 || code.length > 512) return "invalid";
  const presented = createHash("sha256").update(code.trim(), "utf8").digest();
  return timingSafeEqual(presented, expected) ? "ok" : "invalid";
}
