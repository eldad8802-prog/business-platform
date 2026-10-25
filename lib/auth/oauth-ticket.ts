/**
 * OAuth signup tickets and identities — the server side of "Continue with Google" between Google and the
 * completed Dubiz signup.
 *
 * A verified Google identity is NOT an account. For a person with no linked account the callback issues a
 * SIGNUP TICKET and nothing else: no User, no Business, no AuthSession, no access token. The ticket is a
 * random secret in an httpOnly cookie; the database keeps only sha256(secret). The account is created only
 * when the person completes the existing signup (business name, terms), and the ticket is spent inside
 * that very transaction:
 *
 *   spendSignupTicket(tx, secret) → Business → User (no password) → attachGoogleIdentity(tx, …) → session
 *
 * Every rule lives in the SECURITY DEFINER functions of migration 20261030090000_oauth_identity_foundation,
 * reached here as the auth plane (app_auth), which holds nothing on either table:
 *   - single use: spending is one conditional UPDATE under the row lock, so a second spend — sequential or
 *     concurrent — gets no row; a rolled-back transaction leaves the ticket open for one spender;
 *   - attach accepts only the transaction that spent the ticket, and only the account it just created;
 *   - expiry (30 minutes), supersede, the hourly ceiling, a subject already linked;
 *   - cancel (migration 20261101090000_oauth_ticket_cancel): the same one conditional UPDATE under the row
 *     lock, so a cancel and a completion of one ticket cannot both win, and a copy of the secret is dead
 *     once the cancel commits.
 * This module adds only the secret (mint + hash), the shapes, and the mapping of the answers.
 *
 * Reached from the "Continue with Google" routes only, which answer 404 while AUTH_GOOGLE_LOGIN_ENABLED is off.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";

import type { GoogleIdentity } from "@/lib/auth/google-id-token";
import { authDb, isAuthPlaneActive } from "@/lib/prisma-auth";

type SqlClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

export const OAUTH_PROVIDER_GOOGLE = "google";
export type OAuthTicketPurpose = "SIGNUP" | "LINK";

/** 32 random bytes, base64url: 43 characters, no padding. */
const TICKET_SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function mintTicketSecret(): { secret: string; secretHash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, secretHash: hashTicketSecret(secret) };
}

/** Exactly what the database computes: encode(sha256(convert_to(secret, 'UTF8')), 'hex'). */
export function hashTicketSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A cookie value that cannot be a ticket never reaches the database. */
export function isTicketSecret(value: unknown): value is string {
  return typeof value === "string" && TICKET_SECRET_SHAPE.test(value);
}

export type IssuedTicket = { secret: string; ticketId: string; expiresAt: Date };

/**
 * Issue a SIGNUP ticket for a verified Google identity. Null when the database issued nothing: the address
 * is not provider-verified, the subject is already linked (it signs in instead), or the hourly ceiling
 * was reached. The caller answers the same "start again" in every such case.
 */
export async function issueSignupTicket(
  identity: GoogleIdentity,
  client: SqlClient = authDb()
): Promise<IssuedTicket | null> {
  const { secret, secretHash } = mintTicketSecret();
  const rows = await client.$queryRaw<{ ticket_id: string; expires_at: Date }[]>`
    SELECT ticket_id, expires_at
      FROM public.auth_oauth_ticket_issue('SIGNUP', ${OAUTH_PROVIDER_GOOGLE}::text, ${identity.subject}::text,
                                          ${identity.email}::text, ${identity.name}::text, true, ${secretHash}::text)`;
  if (rows.length !== 1) return null;
  return { secret, ticketId: rows[0].ticket_id, expiresAt: rows[0].expires_at };
}

export type TicketView = { email: string; name: string | null; expiresAt: Date };

/** What the completion form may show for the ticket this browser holds; null when it is not open. */
export async function readSignupTicket(secret: unknown, client: SqlClient = authDb()): Promise<TicketView | null> {
  if (!isTicketSecret(secret)) return null;
  const rows = await client.$queryRaw<{ email: string; name: string | null; expires_at: Date }[]>`
    SELECT email, name, expires_at FROM public.auth_oauth_ticket_read(${secret}, 'SIGNUP')`;
  if (rows.length !== 1) return null;
  return { email: rows[0].email, name: rows[0].name, expiresAt: rows[0].expires_at };
}

export type SpentTicket = { ticketId: string; subject: string; email: string; name: string | null };

/** Thrown inside the signup transaction when the ticket cannot be spent: the transaction must end there. */
export class SignupTicketRefusedError extends Error {
  constructor() {
    super("signup_ticket_refused");
    this.name = "SignupTicketRefusedError";
  }
}

/**
 * Spend the ticket — the FIRST statement of the signup transaction `tx`. Throws SignupTicketRefusedError
 * when the ticket is unknown, spent, superseded, expired or its subject was linked meanwhile, so the
 * transaction aborts before a Business or User exists. Only a provider-verified ticket is ever spendable
 * for SIGNUP (the database never issues another).
 */
export async function spendSignupTicket(tx: SqlClient, secret: unknown): Promise<SpentTicket> {
  if (!isTicketSecret(secret)) throw new SignupTicketRefusedError();
  const rows = await tx.$queryRaw<
    { ticket_id: string; provider_subject: string; email: string; name: string | null; email_verified: boolean }[]
  >`SELECT ticket_id, provider_subject, email, name, email_verified FROM public.auth_oauth_ticket_consume(${secret}, 'SIGNUP')`;
  if (rows.length !== 1 || rows[0].email_verified !== true) throw new SignupTicketRefusedError();
  return { ticketId: rows[0].ticket_id, subject: rows[0].provider_subject, email: rows[0].email, name: rows[0].name };
}

/**
 * What cancelling the ticket a browser holds found. Only CANCELLED changed anything; every other answer left
 * every row as it was (COMPLETED in particular never touches the account the completion created).
 */
export const TICKET_CANCEL_OUTCOMES = ["CANCELLED", "ALREADY_CANCELLED", "COMPLETED", "SUPERSEDED", "EXPIRED", "NOT_FOUND"] as const;
export type TicketCancelOutcome = (typeof TICKET_CANCEL_OUTCOMES)[number];

/**
 * End the SIGNUP ticket on the server, so no copy of its secret can complete a signup. A value that cannot be
 * a ticket never reaches the database (NOT_FOUND). Throws on a database failure: the caller must then NOT
 * report the ticket as cancelled.
 */
export async function cancelSignupTicket(secret: unknown, client: SqlClient = authDb()): Promise<TicketCancelOutcome> {
  if (!isTicketSecret(secret)) return "NOT_FOUND";
  const rows = await client.$queryRaw<{ outcome: string }[]>`
    SELECT public.auth_oauth_ticket_cancel(${secret}::text, 'SIGNUP') AS outcome`;
  const outcome = rows[0]?.outcome;
  if (!(TICKET_CANCEL_OUTCOMES as readonly string[]).includes(outcome ?? "")) throw new Error("oauth_ticket_cancel_unexpected_answer");
  return outcome as TicketCancelOutcome;
}

export type AttachedIdentity = { identityId: number; emailVerifiedAt: Date | null };

/**
 * Link the spent ticket's Google subject to the user `tx` just created (same address, no password). The
 * database refuses — and the transaction then fails whole — for any other transaction or account.
 */
export async function attachGoogleIdentity(tx: SqlClient, ticketId: string, userId: number): Promise<AttachedIdentity> {
  const rows = await tx.$queryRaw<{ identity_id: number; email_verified_at: Date | null }[]>`
    SELECT identity_id, email_verified_at FROM public.auth_oauth_identity_attach(${ticketId}::uuid, ${userId}::int)`;
  return { identityId: Number(rows[0].identity_id), emailVerifiedAt: rows[0].email_verified_at };
}

export type ResolvedIdentity = { userId: number; businessId: number };

/** The account a verified Google subject is linked to (matched on `sub` only, never the address). */
export async function resolveGoogleIdentity(subject: string, client: SqlClient = authDb()): Promise<ResolvedIdentity | null> {
  const rows = await client.$queryRaw<{ user_id: number; business_id: number }[]>`
    SELECT user_id, business_id FROM public.auth_oauth_identity_resolve(${OAUTH_PROVIDER_GOOGLE}, ${subject})`;
  if (rows.length !== 1) return null;
  return { userId: Number(rows[0].user_id), businessId: Number(rows[0].business_id) };
}

/** The sweep: removes expired tickets; returns how many. */
export async function purgeExpiredTickets(client: SqlClient = authDb()): Promise<number> {
  const rows = await client.$queryRaw<{ n: number }[]>`SELECT public.auth_oauth_ticket_purge() AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** The scheduled sweep's entry: only the auth plane may run the purge; without it, nothing is attempted. */
export async function purgeExpiredTicketsOnAuthPlane(): Promise<{ purged: number } | { skipped: "auth_plane_inactive" }> {
  if (!isAuthPlaneActive()) return { skipped: "auth_plane_inactive" };
  return { purged: await purgeExpiredTickets() };
}
