/**
 * PASSWORD POLICY — the single place that decides whether a NEW password is
 * acceptable.
 *
 * Applied to exactly three acts: signup, password change and password reset.
 * It is NEVER applied at login. An owner whose existing password predates this
 * policy must still be able to sign in with it; the policy governs the next
 * password they choose, not the one they have.
 *
 * OWNER POLICY DECISION. The numbers below are conservative defaults chosen
 * against NIST SP 800-63B (memorized secrets: minimum length, no composition
 * rules, no forced rotation, screen against known-compromised values, allow at
 * least 64 characters). They are flagged for the owner to confirm:
 *
 *   MIN_PASSWORD_LENGTH   10 characters (NIST floor is 8; 15 when password is
 *                         the only factor under rev.4 — tenant MFA is not
 *                         mandatory today, so 10 is a usability compromise)
 *   MAX_PASSWORD_BYTES    72 UTF-8 BYTES — a hard technical limit, not policy:
 *                         bcrypt silently ignores everything past byte 72, so a
 *                         longer password would be truncated without the owner
 *                         knowing. Rejecting is honest; truncating is not.
 *   common-password list  a small bundled list (lib/auth/common-passwords.ts)
 *
 * No composition rules (NIST 800-63B §5.1.1.2 advises against them).
 *
 * Dependency-free on purpose, like signup-identity.ts: it is testable in
 * milliseconds without a database.
 */

import { COMMON_PASSWORDS } from "./common-passwords";

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_BYTES = 72;

export type PasswordPolicyViolation =
  | "not_a_string"
  | "too_short"
  | "too_long"
  | "too_common"
  | "matches_identity";

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; reason: PasswordPolicyViolation; message: string };

const MESSAGES: Record<PasswordPolicyViolation, string> = {
  not_a_string: "יש להזין סיסמה",
  too_short: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים`,
  too_long: "הסיסמה ארוכה מדי",
  too_common: "הסיסמה נפוצה מדי וקלה לניחוש. בחרו סיסמה אחרת",
  matches_identity: "הסיסמה לא יכולה להיות זהה לכתובת האימייל",
};

function refuse(reason: PasswordPolicyViolation): PasswordPolicyResult {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/** Length in user-perceived characters (code points), not UTF-16 units. */
function charLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Evaluate a candidate NEW password. The password is never trimmed: it is a
 * secret, not a label (see signup-identity.ts).
 */
export function checkNewPassword(
  password: unknown,
  context: { email?: string | null } = {}
): PasswordPolicyResult {
  if (typeof password !== "string" || password.length === 0) return refuse("not_a_string");
  if (charLength(password) < MIN_PASSWORD_LENGTH) return refuse("too_short");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return refuse("too_long");

  const folded = password.toLowerCase();
  if (COMMON_PASSWORDS.has(folded)) return refuse("too_common");

  const email = context.email?.trim().toLowerCase();
  if (email) {
    const local = email.split("@")[0] ?? "";
    if (folded === email || (local.length >= 4 && folded === local)) {
      return refuse("matches_identity");
    }
  }
  return { ok: true };
}

/**
 * Login-side guard, NOT policy: bcrypt truncates at 72 bytes, so any input past
 * a generous bound is rejected before hashing to cap the work an attacker can
 * force per request. Existing passwords are all ≤ 72 bytes by construction of
 * bcrypt, so no legitimate owner is refused by this.
 */
export const MAX_LOGIN_PASSWORD_BYTES = 1024;
