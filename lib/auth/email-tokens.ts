/**
 * Email verification and password reset — the server side of the account-link flows.
 *
 * Every read and write of AuthEmailToken goes through the four SECURITY DEFINER functions of migration
 * 20261017090000_auth_email_tokens, as the auth plane (app_auth). This module holds no rule the
 * database does not also enforce: single use, expiry, supersede, the per-hour ceiling, a business in
 * deletion, an address that changed since the link was sent — all are decided in the database, under
 * a row lock, atomically with their effect. What lives here is only:
 *   - minting the token (id + sha256 of the derived secret — lib/auth/email-link.ts);
 *   - recording the email that carries it, in the SAME transaction that issued it;
 *   - parsing what a page posts, hashing a new password (bcrypt, the signup cost), and mapping the
 *     database's answer to a status.
 *
 * Nothing here says whether an address has an account: the reset request answers the same either way
 * (the route does the work after the response), and a check / consume answers only about the link the
 * caller already holds.
 */

import bcrypt from "bcrypt";
import type { Prisma } from "@prisma/client";

import type { EmailTokenStatus } from "@/lib/auth/auth-messages";
import { isDerivedSecret, mintEmailToken, parseLinkToken, type EmailTokenPurpose } from "@/lib/auth/email-link";
import { MIN_PASSWORD_LENGTH, normalizeEmail } from "@/lib/auth/signup-identity";
import { enqueueAccountLinkEmail } from "@/lib/email/transactional/store";
import { authDb } from "@/lib/prisma-auth";

type SqlClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

/** The signup cost (lib/auth/signup.ts BCRYPT_ROUNDS) — login verifies against it. */
const BCRYPT_ROUNDS = 10;
/** bcrypt reads at most 72 bytes; anything far beyond that is not a password a person typed. */
export const MAX_PASSWORD_LENGTH = 128;

export type IssuedLink = { emailId: number; businessId: number; tokenId: string };

/**
 * Issue a link for a user and record the email that carries it — both inside `tx`. Returns null when
 * the database issued nothing (unknown user, business in deletion, already verified, hourly ceiling).
 */
export async function issueAccountLink(
  tx: SqlClient,
  input: { userId: number; purpose: EmailTokenPurpose; name: string | null; now: Date }
): Promise<IssuedLink | null> {
  const { tokenId, tokenHash } = mintEmailToken(input.purpose);
  const rows = await tx.$queryRaw<{ business_id: number; email: string }[]>`
    SELECT business_id, email
      FROM public.auth_email_token_issue(${input.userId}::int, ${input.purpose}, ${tokenId}::uuid, ${tokenHash})`;
  if (rows.length !== 1) return null;
  const businessId = Number(rows[0].business_id);
  const emailId = await enqueueAccountLinkEmail(tx, {
    kind: input.purpose,
    tokenId,
    userId: input.userId,
    businessId,
    toEmail: rows[0].email,
    name: input.name,
    now: input.now,
  });
  return { emailId, businessId, tokenId };
}

const RESET_USER_SELECT = { id: true, name: true } as const;

/**
 * "Forgot password": finds the account the way login does (folded address first, the address as typed
 * second) and issues a reset link. Null when there is no account or nothing was issued — the caller
 * must answer the same either way.
 */
export async function requestPasswordReset(rawEmail: string, now: Date): Promise<IssuedLink | null> {
  const email = rawEmail.trim();
  const folded = normalizeEmail(email);
  let user = await authDb().user.findUnique({ where: { email: folded }, select: RESET_USER_SELECT });
  if (!user && email !== folded) {
    user = await authDb().user.findUnique({ where: { email }, select: RESET_USER_SELECT });
  }
  if (!user) return null;
  const found = user;
  return authDb().$transaction((tx) =>
    issueAccountLink(tx, { userId: found.id, purpose: "PASSWORD_RESET", name: found.name, now })
  );
}

export type VerificationRequest =
  | { status: "SENT"; link: IssuedLink }
  | { status: "ALREADY_VERIFIED" }
  | { status: "NOT_ISSUED" };

/** "Send the verification link again" for a signed-in owner. */
export async function requestEmailVerification(userId: number, now: Date): Promise<VerificationRequest> {
  const user = await authDb().user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, emailVerifiedAt: true },
  });
  if (!user) return { status: "NOT_ISSUED" };
  if (user.emailVerifiedAt) return { status: "ALREADY_VERIFIED" };
  const link = await authDb().$transaction((tx) =>
    issueAccountLink(tx, { userId: user.id, purpose: "EMAIL_VERIFY", name: user.name, now })
  );
  return link ? { status: "SENT", link } : { status: "NOT_ISSUED" };
}

/** Parses the posted token and rejects one this server never derived — before the database is asked. */
function readToken(raw: unknown, purpose: EmailTokenPurpose): { tokenId: string; secret: string } | null {
  const token = parseLinkToken(raw);
  if (!token) return null;
  return isDerivedSecret(token.tokenId, token.secret, purpose) ? token : null;
}

/** The status of a link the caller holds. Changes nothing. */
export async function checkAccountLink(raw: unknown, purpose: EmailTokenPurpose): Promise<EmailTokenStatus> {
  const token = readToken(raw, purpose);
  if (!token) return "INVALID";
  const rows = await authDb().$queryRaw<{ s: EmailTokenStatus }[]>`
    SELECT public.auth_email_token_check(${token.tokenId}::uuid, ${token.secret}, ${purpose}) AS s`;
  return rows[0]?.s ?? "INVALID";
}

export type VerifyOutcome =
  | { status: "VERIFIED"; userId: number; businessId: number }
  | { status: Exclude<EmailTokenStatus, "VALID"> };

export async function consumeEmailVerification(raw: unknown): Promise<VerifyOutcome> {
  const token = readToken(raw, "EMAIL_VERIFY");
  if (!token) return { status: "INVALID" };
  const rows = await authDb().$queryRaw<{ status: string; user_id: number | null; business_id: number | null }[]>`
    SELECT status, user_id, business_id FROM public.auth_email_verify_consume(${token.tokenId}::uuid, ${token.secret})`;
  const row = rows[0];
  if (row?.status === "VERIFIED" && row.user_id !== null && row.business_id !== null) {
    return { status: "VERIFIED", userId: Number(row.user_id), businessId: Number(row.business_id) };
  }
  return { status: asProblem(row?.status) };
}

export type ResetOutcome =
  | { status: "RESET"; userId: number }
  | { status: "WEAK_PASSWORD" }
  | { status: Exclude<EmailTokenStatus, "VALID"> };

/**
 * Spend a reset link: the new password is hashed here and handed to the database, which sets it, bumps
 * tokenVersion, revokes every refresh session and closes the user's other reset links — or does
 * nothing at all.
 */
export async function consumePasswordReset(raw: unknown, newPassword: unknown): Promise<ResetOutcome> {
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
    return { status: "WEAK_PASSWORD" };
  }
  const token = readToken(raw, "PASSWORD_RESET");
  if (!token) return { status: "INVALID" };
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const rows = await authDb().$queryRaw<{ status: string; user_id: number | null }[]>`
    SELECT status, user_id FROM public.auth_password_reset_consume(${token.tokenId}::uuid, ${token.secret}, ${hash})`;
  const row = rows[0];
  if (row?.status === "RESET" && row.user_id !== null) return { status: "RESET", userId: Number(row.user_id) };
  return { status: asProblem(row?.status) };
}

function asProblem(status: string | undefined): Exclude<EmailTokenStatus, "VALID"> {
  return status === "EXPIRED" || status === "USED" || status === "SUPERSEDED" ? status : "INVALID";
}

/** Whether a signed-in owner's address is verified; null when the user is gone. */
export async function readEmailVerified(userId: number): Promise<boolean | null> {
  const user = await authDb().user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  return user ? user.emailVerifiedAt !== null : null;
}
