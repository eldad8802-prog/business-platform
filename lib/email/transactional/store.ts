/**
 * Enqueue — writes the row that says "Dubiz owes this email", inside the CALLER's transaction.
 *
 * It takes the caller's transaction client and opens nothing of its own: the row exists if and
 * only if the act that owes it committed. A rolled-back signup leaves no row; a committed one
 * leaves exactly one, because the dedupe key is unique and the insert is ON CONFLICT DO NOTHING.
 *
 * Raw SQL on purpose: it names exactly the twelve columns the signup plane (app_auth) may insert
 * (migration 20261015090000_transactional_email_foundation) and nothing the ORM might add, and it
 * makes the idempotent insert a single statement. The row's id is read back by its dedupe key.
 */

import { Prisma } from "@prisma/client";

import type { Locale } from "@/lib/i18n/config";

import { EMAIL_KINDS, accountLinkDedupeKey, googleNoticeDedupeKey, welcomeDedupeKey, type EmailKind } from "./registry";
import type { AccountLinkPayload } from "./templates/account-links";
import type { GoogleNoticePayload } from "./templates/google-link";
import { firstNameOf, type WelcomePayload } from "./templates/welcome";

type SqlClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

export type EnqueueInput = {
  kind: EmailKind;
  dedupeKey: string;
  userId: number | null;
  businessId: number;
  toEmail: string;
  payload: Record<string, unknown>;
  /** The interface language the email is written in (TransactionalEmail.locale). Absent → "he". */
  locale?: string;
  now: Date;
};

/** Returns the row id — the new one, or the one an earlier enqueue of the same key wrote. */
export async function enqueueTransactionalEmail(tx: SqlClient, input: EnqueueInput): Promise<number> {
  const expiresAt = new Date(input.now.getTime() + EMAIL_KINDS[input.kind].ttlMs);
  const payload = JSON.stringify(input.payload);
  // TIMESTAMP(3) holds UTC wall-clock time (as every Prisma write does). Converted explicitly so
  // the value never depends on the session's TimeZone setting.
  const at = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  await tx.$executeRaw`
    INSERT INTO "TransactionalEmail"
      ("kind", "dedupeKey", "userId", "businessId", "toEmail", "payload", "locale", "status",
       "nextAttemptAt", "expiresAt", "createdAt", "updatedAt")
    VALUES
      (${input.kind}, ${input.dedupeKey}, ${input.userId}, ${input.businessId}, ${input.toEmail},
       ${payload}::jsonb, ${input.locale ?? "he"}, 'PENDING',
       ${at(input.now)}, ${at(expiresAt)}, ${at(input.now)}, ${at(input.now)})
    ON CONFLICT ("dedupeKey") DO NOTHING`;
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "TransactionalEmail" WHERE "dedupeKey" = ${input.dedupeKey}`;
  if (rows.length !== 1) throw new Error("transactional email: enqueue did not produce a row");
  return rows[0].id;
}

/**
 * The email that carries a freshly issued account link (verification or reset). Called in the SAME
 * transaction that issued the token, so the row exists iff the token does. The payload is the token id
 * and the first name — never the link's secret (it is derived when the email is rendered).
 */
export function enqueueAccountLinkEmail(
  tx: SqlClient,
  input: {
    kind: "EMAIL_VERIFY" | "PASSWORD_RESET" | "LINK_GOOGLE";
    tokenId: string;
    userId: number;
    businessId: number;
    toEmail: string;
    name: string | null;
    now: Date;
    /** The requester's interface language (getServerI18n); absent → Hebrew. */
    locale?: Locale;
  }
): Promise<number> {
  const payload: AccountLinkPayload = { tokenId: input.tokenId, firstName: firstNameOf(input.name) };
  return enqueueTransactionalEmail(tx, {
    kind: input.kind,
    dedupeKey: accountLinkDedupeKey(input.kind, input.tokenId),
    userId: input.userId,
    businessId: input.businessId,
    toEmail: input.toEmail,
    payload,
    locale: input.locale,
    now: input.now,
  });
}

/**
 * The security notice a Google link or unlink owes the account's owner — in the SAME transaction as the act,
 * so it exists iff the act committed; one per identity row (a replay of the act cannot add a second).
 */
export function enqueueGoogleNoticeEmail(
  tx: SqlClient,
  input: {
    kind: "GOOGLE_LINKED" | "GOOGLE_UNLINKED";
    identityId: number;
    userId: number;
    businessId: number;
    toEmail: string;
    name: string | null;
    googleEmail: string;
    now: Date;
  }
): Promise<number> {
  const payload: GoogleNoticePayload = { firstName: firstNameOf(input.name), googleEmail: input.googleEmail };
  return enqueueTransactionalEmail(tx, {
    kind: input.kind,
    dedupeKey: googleNoticeDedupeKey(input.kind, input.identityId),
    userId: input.userId,
    businessId: input.businessId,
    toEmail: input.toEmail,
    payload,
    locale: "he",
    now: input.now,
  });
}

/**
 * The WELCOME a new account owes its owner: recorded by signup, or — for an account opened with email
 * verification — by the verification that confirms its address (lib/auth/email-tokens.ts).
 */
export function enqueueWelcomeEmail(
  tx: SqlClient,
  input: { userId: number; businessId: number; toEmail: string; name: string | null; now: Date; locale?: Locale }
): Promise<number> {
  const payload: WelcomePayload = { firstName: firstNameOf(input.name) };
  return enqueueTransactionalEmail(tx, {
    kind: "WELCOME",
    dedupeKey: welcomeDedupeKey(input.userId),
    userId: input.userId,
    businessId: input.businessId,
    toEmail: input.toEmail,
    payload,
    locale: input.locale,
    now: input.now,
  });
}
