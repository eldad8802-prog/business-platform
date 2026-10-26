/**
 * "Continue with Google" — what a verified Google identity leads to. Called by the callback route only.
 *
 *   1. LINKED subject (UserIdentity, matched on `sub` only) → that account, if google-sign-in-policy allows it
 *      (not a platform admin, business not in deletion) → a session exactly as password login issues one.
 *   2. NOT linked, but the address belongs to an existing account → never a session and never an automatic
 *      link. A platform administrator or a business in deletion is refused outright (google-sign-in-policy);
 *      an account already linked to ANOTHER Google identity is sent to its existing sign-in; otherwise a
 *      single-use LINK ticket — and nothing else. The account is linked only after its owner proves ownership
 *      (password or emailed link — lib/auth/google-link.ts, milestone 3).
 *      Addresses are compared WITHOUT letter case (an older account may hold capital letters): such an account,
 *      or two accounts that differ only in case, stop here — never a guess, never a second account.
 *   3. NOT linked, unknown address → the public-signup gate (or the closed-beta list) decides; when it lets
 *      the address through, a single-use SIGNUP ticket — and nothing else. No User, no Business, no session:
 *      the account exists only once the person completes signup (createAccountFromGoogle).
 *
 * Login is never gated by signup (case 1 works with signup closed), exactly like password login.
 */

import type { UserRole } from "@prisma/client";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

import { verifyGoogleIdToken, type GoogleIdentity, type GoogleIdTokenFailure } from "@/lib/auth/google-id-token";
import type { GoogleLoginConfig } from "@/lib/auth/google-oauth";
import { googleSignInRefusal, type GoogleSignInRefusal } from "@/lib/auth/google-sign-in-policy";
import { readGoogleLinkStatus } from "@/lib/auth/google-link";
import { issueLinkTicket, issueSignupTicket, resolveGoogleIdentity } from "@/lib/auth/oauth-ticket";
import { issueRefreshSession } from "@/lib/auth/refresh-session";
import { readSignupAllowlist } from "@/lib/auth/signup-allowlist";
import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";
import { normalizeEmail } from "@/lib/auth/signup-identity";
import { authDb } from "@/lib/prisma-auth";

export type CallbackOutcome =
  | { kind: "session"; userId: number; businessId: number; credential: string; absoluteExpiresAt: Date }
  | { kind: "refused"; reason: GoogleSignInRefusal }
  | { kind: "existing_account" }
  | { kind: "signup_closed" }
  | { kind: "ticket"; secret: string }
  | { kind: "link_ticket"; secret: string }
  | { kind: "ticket_unavailable" }
  | { kind: "invalid_token"; reason: GoogleIdTokenFailure };

const keysByUrl = new Map<string, JWTVerifyGetKey>();
/** Google's JWKS by default; the lab's stand-in only when google-oauth.ts allowed its URL. */
export function keysFor(config: GoogleLoginConfig): JWTVerifyGetKey | undefined {
  if (!config.jwksUrl) return undefined;
  let k = keysByUrl.get(config.jwksUrl);
  if (!k) {
    k = createRemoteJWKSet(new URL(config.jwksUrl));
    keysByUrl.set(config.jwksUrl, k);
  }
  return k;
}

/** Is a new account allowed for this (provider-verified) address right now? The same gate signup uses. */
export function signupAllowedFor(email: string): boolean {
  if (isPublicSignupEnabled()) return true;
  const list = readSignupAllowlist();
  return list.configured && list.has(email);
}

const HOLDER_SELECT = { id: true, email: true, role: true, business: { select: { deletionRequestedAt: true, deletedAt: true } } } as const;

/**
 * Who already holds this address, compared WITHOUT letter case — through lower("email"), the case-folded unique
 * index of 20261011090200 (so at most one account in Production). An exact, index-backed comparison: never a
 * LIKE / ILIKE pattern, so "_" and "%" in an address match only themselves.
 *   none  — the address is free;
 *   one   — that account (the caller still requires it to hold the folded address EXACTLY before any ticket);
 *   ambiguous — more than one account (impossible while the index holds): the caller stops, nothing issued.
 */
type Holder = { id: number; email: string; role: UserRole; business: { deletionRequestedAt: Date | null; deletedAt: Date | null } | null };
async function accountsHolding(email: string): Promise<{ kind: "none" } | { kind: "one"; holder: Holder } | { kind: "ambiguous" }> {
  const folded = normalizeEmail(email);
  const ids = await authDb().$queryRaw<{ id: number }[]>`SELECT "id" FROM "User" WHERE lower("email") = ${folded} LIMIT 2`;
  if (ids.length === 0) return { kind: "none" };
  if (ids.length > 1) return { kind: "ambiguous" };
  const holder = await authDb().user.findUnique({ where: { id: Number(ids[0].id) }, select: HOLDER_SELECT });
  return holder ? { kind: "one", holder } : { kind: "none" };
}

/** A session for a linked account — the same row, credential and login stamp password login writes. */
async function sessionFor(userId: number, now: Date, userAgent: string | null): Promise<CallbackOutcome> {
  const user = await authDb().user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, tokenVersion: true, businessId: true, business: { select: { deletionRequestedAt: true, deletedAt: true } } },
  });
  if (!user) return { kind: "refused", reason: "BUSINESS_UNAVAILABLE" };
  const refusal = googleSignInRefusal(user);
  if (refusal) return { kind: "refused", reason: refusal };
  const session = await issueRefreshSession(authDb(), { userId: user.id, tokenVersion: user.tokenVersion, now, userAgent });
  // Explicit select: the auth plane may write the stamp but not read most of User back (as in login).
  await authDb().user.update({
    where: { id: user.id },
    data: { lastLoginAt: now, loginCount: { increment: 1 } },
    select: { id: true },
  });
  return { kind: "session", userId: user.id, businessId: user.businessId, credential: session.credential, absoluteExpiresAt: session.absoluteExpiresAt };
}

export type CallbackDeps = {
  verify: typeof verifyGoogleIdToken;
};

/** Decide what a callback's ID token leads to. Nothing is written for any outcome but "session", "ticket" and "link_ticket". */
export async function resolveGoogleCallback(
  input: { idToken: string; nonce: string; config: GoogleLoginConfig; now: Date; userAgent: string | null },
  deps: CallbackDeps = { verify: verifyGoogleIdToken }
): Promise<CallbackOutcome> {
  const verified = await deps.verify(input.idToken, { clientId: input.config.clientId, nonce: input.nonce, now: input.now }, keysFor(input.config));
  if (!verified.ok) return { kind: "invalid_token", reason: verified.reason };
  const identity: GoogleIdentity = verified.identity;

  const linked = await resolveGoogleIdentity(identity.subject);
  if (linked) return sessionFor(linked.userId, input.now, input.userAgent);

  const held = await accountsHolding(identity.email);
  // Two accounts that differ only in letter case: never guess which one — no ticket of any kind.
  if (held.kind === "ambiguous") return { kind: "existing_account" };
  if (held.kind === "one") {
    const holder = held.holder;
    const refusal = googleSignInRefusal(holder);
    if (refusal) return { kind: "refused", reason: refusal };
    // The database links only the account holding EXACTLY the ticket's (folded) address, and one Google identity
    // per account. An older account whose address holds capital letters, or one linked to another Google
    // identity, signs in the existing way — and is never offered a SIGNUP either (no second account).
    if (holder.email !== identity.email || (await readGoogleLinkStatus(holder.id))?.linked !== false) return { kind: "existing_account" };
    const link = await issueLinkTicket(identity);
    return link ? { kind: "link_ticket", secret: link.secret } : { kind: "ticket_unavailable" };
  }
  if (!signupAllowedFor(identity.email)) return { kind: "signup_closed" };

  const ticket = await issueSignupTicket(identity);
  return ticket ? { kind: "ticket", secret: ticket.secret } : { kind: "ticket_unavailable" };
}
