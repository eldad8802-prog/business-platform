/**
 * The issuer-declaration link (#1081; migration 20261126090000_auth_issuer_declaration_link).
 *
 * Before a business's first issuance its owner confirms an issuer declaration. Billing (the declaration screen,
 * API and record) asks for a link here; the owner opens it while signed in; billing spends it in the SAME tenant
 * transaction that records the declaration.
 *
 *   requestIssuerDeclarationLink   — the auth plane: issue a link bound to (account, its business, the
 *                                    declaration digest) and record its email, in one transaction. 30 minutes,
 *                                    3 per account and hour, a new one closes the earlier open ones (all in the
 *                                    database). The email shows the legal name and legal form only.
 *   checkIssuerDeclarationLink     — the auth plane: the status of a link the caller holds. Changes nothing.
 *   consumeIssuerDeclarationLink   — billing's tenant transaction (app_runtime): spend it, only for the signed-in
 *                                    account, only inside the link's business, only for the same digest. Called
 *                                    with billing's own `tx`, so a failure after it rolls the spend back.
 *
 * The digest (statementSha256) is billing's: sha256 of the canonical declaration, computed server-side from the
 * current database state both when asking and when confirming. This module only stores and compares it.
 */

import type { Prisma } from "@prisma/client";

import { isDerivedSecret, mintEmailToken, parseLinkToken } from "@/lib/auth/email-link";
import { enqueueIssuerDeclarationEmail } from "@/lib/email/transactional/store";
import type { IssuerDeclarationLegalForm } from "@/lib/email/transactional/templates/issuer-declaration";
import { authDb } from "@/lib/prisma-auth";

type SqlClient = Pick<Prisma.TransactionClient, "$queryRaw">;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isStatementSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export type IssuerDeclarationLinkRequest = {
  userId: number;
  businessId: number;
  statementSha256: string;
  /** Shown in the email (the only business details it carries). */
  legalName: string;
  legalForm: IssuerDeclarationLegalForm;
  now: Date;
};

/**
 * SENT          — a link was issued and its email recorded (deliver it after the response: emailId);
 * NOT_ISSUED    — the database issued nothing: not the account's business, a business in deletion, or the
 *                 hourly ceiling. The caller answers the same for all of them.
 */
export type IssuerDeclarationLinkResult =
  | { status: "SENT"; emailId: number; businessId: number; expiresAt: Date }
  | { status: "NOT_ISSUED" };

export async function requestIssuerDeclarationLink(input: IssuerDeclarationLinkRequest): Promise<IssuerDeclarationLinkResult> {
  if (!Number.isInteger(input.userId) || !Number.isInteger(input.businessId) || !isStatementSha256(input.statementSha256)) {
    return { status: "NOT_ISSUED" };
  }
  return authDb().$transaction(async (tx) => {
    const { tokenId, tokenHash } = mintEmailToken("ISSUER_DECLARATION");
    const rows = await tx.$queryRaw<{ token_id: string; business_id: number; email: string; expires_at: Date }[]>`
      SELECT token_id, business_id, email, expires_at
        FROM public.auth_issuer_declaration_issue(${input.userId}::int, ${input.businessId}::int, ${input.statementSha256},
                                                  ${tokenId}::uuid, ${tokenHash})`;
    if (rows.length !== 1) return { status: "NOT_ISSUED" as const };
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { name: true } });
    const emailId = await enqueueIssuerDeclarationEmail(tx, {
      tokenId,
      userId: input.userId,
      businessId: Number(rows[0].business_id),
      toEmail: rows[0].email,
      name: user?.name ?? null,
      legalName: input.legalName,
      legalForm: input.legalForm,
      now: input.now,
    });
    return { status: "SENT" as const, emailId, businessId: Number(rows[0].business_id), expiresAt: rows[0].expires_at };
  });
}

/** Parses the link token and refuses one this server never derived for this purpose — before the database. */
function readToken(raw: unknown): { tokenId: string; secret: string } | null {
  const token = parseLinkToken(raw);
  return token && isDerivedSecret(token.tokenId, token.secret, "ISSUER_DECLARATION") ? token : null;
}

export type IssuerDeclarationLinkStatus = "VALID" | "USED" | "SUPERSEDED" | "EXPIRED" | "INVALID";

/** The status of a link the caller holds, for the confirmation page. Changes nothing. */
export async function checkIssuerDeclarationLink(raw: unknown): Promise<IssuerDeclarationLinkStatus> {
  const token = readToken(raw);
  if (!token) return "INVALID";
  const rows = await authDb().$queryRaw<{ s: IssuerDeclarationLinkStatus }[]>`
    SELECT public.auth_email_token_check(${token.tokenId}::uuid, ${token.secret}, 'ISSUER_DECLARATION') AS s`;
  return rows[0]?.s ?? "INVALID";
}

export const ISSUER_DECLARATION_CONSUME_STATUSES = ["CONFIRMED", "USED", "SUPERSEDED", "EXPIRED", "BINDING_MISMATCH", "INVALID"] as const;
export type IssuerDeclarationConsumeStatus = (typeof ISSUER_DECLARATION_CONSUME_STATUSES)[number];

/**
 * Spend the link inside billing's tenant transaction (`tx` carries app.current_business_id). CONFIRMED means
 * billing records the declaration in this same `tx`; anything else means it records nothing. BINDING_MISMATCH:
 * the declaration changed since the link was sent — the link stays unspent and a new one is needed.
 */
export async function consumeIssuerDeclarationLink(
  tx: SqlClient,
  input: { token: unknown; userId: number; statementSha256: string }
): Promise<IssuerDeclarationConsumeStatus> {
  const token = readToken(input.token);
  if (!token || !Number.isInteger(input.userId) || !isStatementSha256(input.statementSha256)) return "INVALID";
  const rows = await tx.$queryRaw<{ s: string }[]>`
    SELECT public.auth_issuer_declaration_consume(${token.tokenId}::uuid, ${token.secret}, ${input.userId}::int,
                                                  ${input.statementSha256}) AS s`;
  const s = rows[0]?.s;
  return (ISSUER_DECLARATION_CONSUME_STATUSES as readonly string[]).includes(s ?? "") ? (s as IssuerDeclarationConsumeStatus) : "INVALID";
}
