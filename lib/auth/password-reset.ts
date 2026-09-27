/**
 * PASSWORD RESET — token and delivery port.
 *
 * TOKEN (no table, no schema). A purpose-bound HMAC envelope carrying:
 *   sub  the user id
 *   tv   the user's token generation AT ISSUE
 *   pf   a fingerprint of the password hash AT ISSUE
 *   n    128 random bits
 *   exp  issue + 30 minutes
 *
 * Nothing is stored, so nothing in the database can be replayed. The token is:
 *   - EXPIRING: exp is inside the MAC.
 *   - SINGLE-USE: consuming it moves the generation with a conditional UPDATE
 *     `WHERE tokenVersion = tv` (advanceTokenGeneration) — of two concurrent
 *     consumes exactly one matches; afterwards `tv` is stale forever.
 *   - BOUND: to the user and to the generation at issue, so ANY later logout,
 *     password change or reset kills every outstanding reset token; and to the
 *     password hash, so a password changed by any other path kills it too.
 *
 * DELIVERY. No approved email provider exists in this repository (checked for
 * resend / sendgrid / nodemailer / SES / postmark / mailgun / SMTP). Delivery is
 * therefore a PORT with a disabled production adapter, and the whole flow FAILS
 * CLOSED: with no configured sender, a reset request still returns the generic
 * response (no enumeration), mints nothing, and the confirm endpoint refuses
 * every token. Choosing a provider is an OWNER ACTION.
 */

import { createHash } from "node:crypto";

import { openEnvelope, randomNonce, sealEnvelope } from "./signed-envelope";

const LABEL = "dubiz-password-reset-v1";
const VERSION = 1;
export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;

export function passwordFingerprint(passwordHash: string): string {
  return createHash("sha256").update(`pwfp:${passwordHash}`, "utf8").digest("hex").slice(0, 32);
}

export function issuePasswordResetToken(
  subject: { id: number; tokenVersion: number; passwordHash: string },
  nowMs = Date.now()
): string {
  const iat = Math.floor(nowMs / 1000);
  return sealEnvelope(LABEL, {
    v: VERSION,
    sub: subject.id,
    tv: subject.tokenVersion,
    pf: passwordFingerprint(subject.passwordHash),
    n: randomNonce(),
    iat,
    exp: iat + PASSWORD_RESET_TTL_SECONDS,
  });
}

export type ResetTokenClaims = { userId: number; tokenVersion: number; fingerprint: string };

/** Signature, version and expiry only. The binding is checked against the row by the caller. */
export function readPasswordResetToken(raw: unknown, nowMs = Date.now()): ResetTokenClaims | null {
  const p = openEnvelope(LABEL, raw);
  if (!p || p.v !== VERSION) return null;
  if (!Number.isInteger(p.sub) || !Number.isInteger(p.tv) || typeof p.pf !== "string") return null;
  if (!Number.isInteger(p.exp) || Math.floor(nowMs / 1000) >= (p.exp as number)) return null;
  return { userId: p.sub as number, tokenVersion: p.tv as number, fingerprint: p.pf };
}

// ---------------------------------------------------------------------------
// Delivery port
// ---------------------------------------------------------------------------

export interface PasswordResetSender {
  /** False means "no provider": the flow mints nothing and accepts no token. */
  readonly configured: boolean;
  send(message: { to: string; resetUrl: string; expiresInMinutes: number }): Promise<void>;
}

/** The production adapter until the owner selects a provider. Fails closed. */
export const disabledPasswordResetSender: PasswordResetSender = {
  configured: false,
  async send() {
    throw new Error("password reset delivery is not configured");
  },
};

/**
 * Provider selection. Only "disabled" exists today; a real adapter is added
 * here (and only here) once the owner chooses a provider and its credentials
 * are provisioned. An unknown value is treated as disabled, never guessed.
 */
export function resolvePasswordResetSender(): PasswordResetSender {
  const provider = process.env.PASSWORD_RESET_EMAIL_PROVIDER?.trim().toLowerCase();
  if (provider && provider !== "disabled") {
    console.error(
      JSON.stringify({ event: "password_reset_provider_unknown", provider: provider.slice(0, 32) })
    );
  }
  return disabledPasswordResetSender;
}

export function buildResetUrl(token: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_BASE_URL?.trim();
  if (!base) return null;
  try {
    const url = new URL("/reset-password", base);
    url.hash = `token=${encodeURIComponent(token)}`;
    return url.toString();
  } catch {
    return null;
  }
}
