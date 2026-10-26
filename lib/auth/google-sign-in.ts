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
 *   3. NOT linked, unknown address → the public-signup gate (or the closed-beta list) decides; when it lets
 *      the address through, a single-use SIGNUP ticket — and nothing else. No User, no Business, no session:
 *      the account exists only once the person completes signup (createAccountFromGoogle).
 *
 * Login is never gated by signup (case 1 works with signup closed), exactly like password login.
 */

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

/** The account that already holds this address (folded, then as typed — the way login looks it up). */
async function accountHolding(email: string) {
  const folded = normalizeEmail(email);
  const hit = await authDb().user.findUnique({ where: { email: folded }, select: HOLDER_SELECT });
  if (hit || email === folded) return hit;
  return authDb().user.findUnique({ where: { email }, select: HOLDER_SELECT });
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

  const holder = await accountHolding(identity.email);
  if (holder) {
    const refusal = googleSignInRefusal(holder);
    if (refusal) return { kind: "refused", reason: refusal };
    // The database links only the account holding EXACTLY the ticket's address, and one Google identity per
    // account: anything else signs in the existing way.
    if (holder.email !== identity.email || (await readGoogleLinkStatus(holder.id))?.linked !== false) return { kind: "existing_account" };
    const link = await issueLinkTicket(identity);
    return link ? { kind: "link_ticket", secret: link.secret } : { kind: "ticket_unavailable" };
  }
  if (!signupAllowedFor(identity.email)) return { kind: "signup_closed" };

  const ticket = await issueSignupTicket(identity);
  return ticket ? { kind: "ticket", secret: ticket.secret } : { kind: "ticket_unavailable" };
}
