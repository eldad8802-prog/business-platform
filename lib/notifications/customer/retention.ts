/**
 * Retention of customers' phone numbers on WhatsApp deliveries (owner requirement 4, G1). SERVER-ONLY.
 *
 * Documented retention: 30 DAYS after the message was created and is no longer owed. Run by the existing
 * notification worker cron (/api/notifications/worker) every pass. notification_customer_phone_purge() (SECURITY
 * DEFINER, migration 20261230090000) nulls recipientPhone on such rows — never one younger than 24 hours, whatever
 * the cut-off passed — and returns a COUNT only; the row, its status and provider id stay (metering, audit).
 * Account deletion clears the phone earlier, in place (erasure registry).
 */
import { prisma } from "@/lib/prisma";

export const CUSTOMER_PHONE_RETENTION_DAYS = 30;
const LIMIT = 1000;

export async function purgeCustomerPhones(now: Date = new Date()): Promise<number> {
  const cut = new Date(now.getTime() - CUSTOMER_PHONE_RETENTION_DAYS * 86_400_000);
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT public.notification_customer_phone_purge(${cut.toISOString().replace("T", " ").replace("Z", "")}::timestamp(3), ${LIMIT}::int) AS "n"`;
  return Number(rows[0]?.n ?? 0);
}
