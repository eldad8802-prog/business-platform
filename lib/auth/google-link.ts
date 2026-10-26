/**
 * "Continue with Google", milestone 3 — linking Google to an EXISTING account, after proof of ownership.
 *
 * A Google identity whose address belongs to an existing, unlinked account reaches this module holding a
 * LINK ticket (lib/auth/oauth-ticket.ts) and nothing else: no session, no link. The account is linked only
 * when its owner proves they own it:
 *   PASSWORD — the account's password, compared by the route under the SAME attempt limits login uses;
 *   EMAIL    — a single-use link emailed to the account's address (LINK_GOOGLE), bound to THAT ticket.
 * Never by matching addresses alone. The client never names an account, a business or an identity: the
 * account is the one that holds the ticket's provider-verified address, resolved on the server (and again,
 * under a row lock, by the database).
 *
 * ONE transaction (completeGoogleLink):
 *   spend the LINK ticket → (EMAIL: spend the emailed link bound to it) → link the identity
 *   → the session (as password login issues it) → the GOOGLE_LINKED security notice
 * so a failure anywhere leaves nothing: no identity, no session, no notice; the ticket and the emailed link
 * stay open. A second attempt — sequential or concurrent — finds the ticket spent. No WELCOME: this is not
 * a new account.
 *
 * Every rule lives in the SECURITY DEFINER functions of migration 20261102090000_oauth_identity_link,
 * reached here as the auth plane (app_auth), which holds nothing on the tables. Platform administrators and
 * businesses in deletion are refused there (and never get a LINK ticket in the first place).
 */

import type { Prisma } from "@prisma/client";

import { isDerivedSecret, mintEmailToken, parseLinkToken } from "@/lib/auth/email-link";
import { isTicketSecret } from "@/lib/auth/oauth-ticket";
import { issueRefreshSession } from "@/lib/auth/refresh-session";
import { enqueueAccountLinkEmail, enqueueGoogleNoticeEmail } from "@/lib/email/transactional/store";
import { authDb, isAuthPlaneActive } from "@/lib/prisma-auth";

type SqlClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

/** The account a LINK ticket names: the one holding the ticket's address, exactly as the database matches it. */
export type LinkAccount = { id: number; businessId: number; password: string | null };

export async function findLinkAccount(email: string): Promise<LinkAccount | null> {
  return authDb().user.findUnique({ where: { email }, select: { id: true, businessId: true, password: true } });
}

/** The signed-in owner's address and password hash, for re-authentication before an unlink. */
export async function readAccountCredentials(userId: number): Promise<{ email: string; password: string | null } | null> {
  return authDb().user.findUnique({ where: { id: userId }, select: { email: true, password: true } });
}

export type RequestedLinkEmail = { emailId: number; businessId: number };

/**
 * Email the single-use proof link to the account the held LINK ticket names, and record the email — in one
 * transaction. Null when the database issued nothing (no open LINK ticket, the ceilings, an account that may
 * not be linked); the caller answers the same either way.
 */
export async function requestLinkEmail(ticketSecret: unknown, now: Date): Promise<RequestedLinkEmail | null> {
  if (!isTicketSecret(ticketSecret)) return null;
  return authDb().$transaction(async (tx) => {
    const { tokenId, tokenHash } = mintEmailToken("LINK_GOOGLE");
    const rows = await tx.$queryRaw<{ user_id: number; business_id: number; email: string; name: string | null }[]>`
      SELECT user_id, business_id, email, name
        FROM public.auth_oauth_link_email_issue(${ticketSecret}::text, ${tokenId}::uuid, ${tokenHash})`;
    if (rows.length !== 1) return null;
    const businessId = Number(rows[0].business_id);
    const emailId = await enqueueAccountLinkEmail(tx, {
      kind: "LINK_GOOGLE",
      tokenId,
      userId: Number(rows[0].user_id),
      businessId,
      toEmail: rows[0].email,
      name: rows[0].name,
      now,
      locale: "he",
    });
    return { emailId, businessId };
  });
}

export const LINK_EMAIL_STATUSES = ["VALID", "OTHER_BROWSER", "USED", "EXPIRED", "SUPERSEDED", "TICKET_ENDED", "INVALID"] as const;
export type LinkEmailStatus = (typeof LINK_EMAIL_STATUSES)[number];

function readLinkToken(raw: unknown): { tokenId: string; secret: string } | null {
  const token = parseLinkToken(raw);
  return token && isDerivedSecret(token.tokenId, token.secret, "LINK_GOOGLE") ? token : null;
}

/** The status of an emailed link, for the browser holding (or not) the ticket it is bound to. Changes nothing. */
export async function checkLinkEmail(raw: unknown, ticketSecret: unknown, client: SqlClient = authDb()): Promise<LinkEmailStatus> {
  const token = readLinkToken(raw);
  if (!token) return "INVALID";
  const held = isTicketSecret(ticketSecret) ? ticketSecret : null;
  const rows = await client.$queryRaw<{ s: string }[]>`
    SELECT public.auth_oauth_link_email_check(${token.tokenId}::uuid, ${token.secret}::text, ${held}::text) AS s`;
  const s = rows[0]?.s ?? "INVALID";
  return (LINK_EMAIL_STATUSES as readonly string[]).includes(s) ? (s as LinkEmailStatus) : "INVALID";
}

/** Why a link did not happen. TICKET: no open LINK ticket; EMAIL_LINK: the emailed link is not usable here; ACCOUNT: the database refused the account. */
export class GoogleLinkRefusedError extends Error {
  constructor(readonly reason: "TICKET" | "EMAIL_LINK" | "ACCOUNT") {
    super(`google_link_refused:${reason.toLowerCase()}`);
    this.name = "GoogleLinkRefusedError";
  }
}

export type LinkProof = { kind: "PASSWORD"; userId: number } | { kind: "EMAIL"; token: unknown };

export type CompleteLinkInput = {
  ticketSecret: unknown;
  proof: LinkProof;
  now: Date;
  userAgent: string | null;
  /**
   * Lab only (.agl/app-battery-m3.ts): runs inside the transaction after every write, so a fault there proves
   * the whole link rolls back. Production never passes it.
   */
  beforeCommit?: () => Promise<void>;
};

export type CompletedLink = {
  userId: number;
  businessId: number;
  identityId: number;
  session: { sessionId: string; credential: string; absoluteExpiresAt: Date };
  noticeEmailId: number;
};

const IDENTITY_REFUSED = /not spent in this transaction|not an account this ticket may link|no proof of ownership|UserIdentity_|unique constraint|23505|22023/i;

export async function completeGoogleLink(input: CompleteLinkInput): Promise<CompletedLink> {
  if (!isAuthPlaneActive()) {
    // The ticket and identity functions are the auth plane's alone.
    throw new Error("google_link_requires_auth_plane");
  }
  if (!isTicketSecret(input.ticketSecret)) throw new GoogleLinkRefusedError("TICKET");
  const ticketSecret = input.ticketSecret;
  const emailToken = input.proof.kind === "EMAIL" ? readLinkToken(input.proof.token) : null;
  if (input.proof.kind === "EMAIL" && !emailToken) throw new GoogleLinkRefusedError("EMAIL_LINK");

  return authDb().$transaction(async (tx) => {
    const spent = await tx.$queryRaw<{ ticket_id: string; email: string; email_verified: boolean }[]>`
      SELECT ticket_id, email, email_verified FROM public.auth_oauth_ticket_consume(${ticketSecret}, 'LINK')`;
    if (spent.length !== 1 || spent[0].email_verified !== true) throw new GoogleLinkRefusedError("TICKET");
    const ticketId = spent[0].ticket_id;

    let userId: number;
    if (input.proof.kind === "EMAIL") {
      const used = await tx.$queryRaw<{ u: number | null }[]>`
        SELECT public.auth_oauth_link_email_consume(${emailToken!.tokenId}::uuid, ${emailToken!.secret}::text, ${ticketId}::uuid) AS u`;
      if (used[0]?.u === null || used[0]?.u === undefined) throw new GoogleLinkRefusedError("EMAIL_LINK");
      userId = Number(used[0].u);
    } else {
      userId = input.proof.userId;
    }

    let identityId: number;
    try {
      const linked = await tx.$queryRaw<{ identity_id: number }[]>`
        SELECT identity_id FROM public.auth_oauth_identity_link(${ticketId}::uuid, ${userId}::int, ${input.proof.kind})`;
      identityId = Number(linked[0].identity_id);
    } catch (error) {
      if (error instanceof Error && IDENTITY_REFUSED.test(error.message)) throw new GoogleLinkRefusedError("ACCOUNT");
      throw error;
    }

    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, tokenVersion: true, businessId: true },
    });
    const session = await issueRefreshSession(tx, { userId: user.id, tokenVersion: user.tokenVersion, now: input.now, userAgent: input.userAgent });
    // Explicit select: the auth plane may write the stamp but not read most of User back (as in login).
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: input.now, loginCount: { increment: 1 } }, select: { id: true } });
    const noticeEmailId = await enqueueGoogleNoticeEmail(tx, {
      kind: "GOOGLE_LINKED",
      identityId,
      userId: user.id,
      businessId: user.businessId,
      toEmail: user.email,
      name: user.name,
      googleEmail: spent[0].email,
      now: input.now,
    });

    if (input.beforeCommit) await input.beforeCommit();

    return { userId: user.id, businessId: user.businessId, identityId, session, noticeEmailId };
  });
}

export type GoogleLinkStatus = { linked: boolean; emailAtLink: string | null; linkedAt: Date | null; lastUsedAt: Date | null; hasPassword: boolean };

/** The signed-in owner's own Google link, for the security settings. Null when the user is gone. */
export async function readGoogleLinkStatus(userId: number): Promise<GoogleLinkStatus | null> {
  const rows = await authDb().$queryRaw<{ linked: boolean; email_at_link: string | null; linked_at: Date | null; last_used_at: Date | null; has_password: boolean }[]>`
    SELECT linked, email_at_link, linked_at, last_used_at, has_password FROM public.auth_oauth_identity_status(${userId}::int)`;
  if (rows.length !== 1) return null;
  const r = rows[0];
  return { linked: r.linked, emailAtLink: r.email_at_link, linkedAt: r.linked_at, lastUsedAt: r.last_used_at, hasPassword: r.has_password };
}

/**
 * Remove the owner's Google link and record the GOOGLE_UNLINKED notice — one transaction. The route has
 * re-authenticated the owner (password, under the login attempt limits) first. Null when nothing was removed:
 * no link, or no password (the account could not sign in without Google — the database refuses).
 */
export async function unlinkGoogle(userId: number, now: Date): Promise<{ identityId: number; noticeEmailId: number } | null> {
  return authDb().$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ identity_id: number; business_id: number; email_at_link: string }[]>`
      SELECT identity_id, business_id, email_at_link FROM public.auth_oauth_identity_unlink(${userId}::int)`;
    if (rows.length !== 1) return null;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true } });
    const identityId = Number(rows[0].identity_id);
    const noticeEmailId = await enqueueGoogleNoticeEmail(tx, {
      kind: "GOOGLE_UNLINKED",
      identityId,
      userId,
      businessId: Number(rows[0].business_id),
      toEmail: user.email,
      name: user.name,
      googleEmail: rows[0].email_at_link,
      now,
    });
    return { identityId, noticeEmailId };
  });
}
