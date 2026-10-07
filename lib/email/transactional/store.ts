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

import { EMAIL_KINDS, welcomeDedupeKey, type EmailKind } from "./registry";
import { firstNameOf, type WelcomePayload } from "./templates/welcome";

type SqlClient = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

export type EnqueueInput = {
  kind: EmailKind;
  dedupeKey: string;
  userId: number | null;
  businessId: number;
  toEmail: string;
  payload: Record<string, unknown>;
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

/** The WELCOME a new account owes its owner. Only signup calls this. */
export function enqueueWelcomeEmail(
  tx: SqlClient,
  input: { userId: number; businessId: number; toEmail: string; name: string | null; now: Date }
): Promise<number> {
  const payload: WelcomePayload = { firstName: firstNameOf(input.name) };
  return enqueueTransactionalEmail(tx, {
    kind: "WELCOME",
    dedupeKey: welcomeDedupeKey(input.userId),
    userId: input.userId,
    businessId: input.businessId,
    toEmail: input.toEmail,
    payload,
    now: input.now,
  });
}
