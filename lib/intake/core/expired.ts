/**
 * Leads L1.5-b · A1 — what an EXPIRED intake receipt is, in one place.
 *
 * A held receipt that waited past its expiry (a later PR decides when; nothing expires yet) is settled terminally:
 * status FAILED, no next attempt, lastErrorCode "expired:<hold reason>", payload KEPT. It is NOT a dead letter:
 *
 *   - it is not a processing failure, so it never turns the sweep red, never counts as "could not be taken in" for
 *     the owner, and never raises the failure notification;
 *   - it is not part of the open backlog (it is archived), so the capacity read never scans it;
 *   - its payload is never purged by the dead-letter retention: deleting it is a separate, explicitly approved
 *     retention / privacy decision and a separate mechanism (none exists).
 *
 * Every dead-letter predicate in the store excludes it through the fragments below (pinned by l15b-expired.test.ts).
 */
import { Prisma } from "@prisma/client";

export const EXPIRED_PREFIX = "expired:";

export function isExpiredCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.startsWith(EXPIRED_PREFIX);
}

/** Prisma `where` fragment: the receipt is NOT an expired one (a null code is not expired). */
export const NOT_EXPIRED_WHERE = {
  OR: [{ lastErrorCode: null }, { NOT: { lastErrorCode: { startsWith: EXPIRED_PREFIX } } }],
} satisfies Prisma.IntakeEventWhereInput;

/** Raw-SQL fragment over an "IntakeEvent" alias: the receipt is NOT an expired one. */
export function notExpiredSql(alias: string): Prisma.Sql {
  const col = Prisma.raw(`${alias}."lastErrorCode"`);
  return Prisma.sql`(${col} IS NULL OR ${col} NOT LIKE ${EXPIRED_PREFIX + "%"})`;
}
