/**
 * Customer WhatsApp usage METERING and the QUOTA HOOK (G1, appointments completion program; owner requirement 7).
 * SERVER-ONLY.
 *
 * What is counted: LOGICAL customer messages — one per NotificationDelivery row that was handed to the provider
 * (recipientKind CUSTOMER, providerMessageId set), in the business's calendar month (Asia/Jerusalem), by the moment
 * it was handed over (completedAt). Never attempts (a retry updates the same row, it never adds one — the database
 * allows ONE customer delivery per notification), never status updates (delivered / read change a column, not the
 * count), never a message that was not sent (expired, cancelled, failed). Simulated sends (`sim:` ids) are counted
 * apart, so a simulation period never reads as real usage. No meter table: a COUNT over the partial index
 * "NotificationDelivery_customer_sent_idx" (businessId, completedAt).
 *
 * Quota: customerMessageQuota() is the ONE place a numeric monthly quota will come from. It returns null (= no numeric
 * quota) until the owner sets the numbers — no number is invented here. The WhatsApp lane asks it before each send.
 */
import type { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { localDayKey, wallClockToInstant } from "@/lib/notifications/notification-time";

type Tx = Prisma.TransactionClient;

export const METERING_TIME_ZONE = "Asia/Jerusalem";

export type MonthlyUsage = {
  /** YYYY-MM in Asia/Jerusalem. */
  period: string;
  from: Date;
  to: Date;
  /** Real messages handed to Meta. */
  sent: number;
  /** Simulated sends (WHATSAPP_PLATFORM_SEND_MODE ≠ live). */
  simulated: number;
  operational: number;
  verification: number;
};

/** [from, to) of the calendar month `at` falls in, in Asia/Jerusalem. */
export function meteringMonth(at: Date): { period: string; from: Date; to: Date } {
  const day = localDayKey(at, METERING_TIME_ZONE); // YYYY-MM-DD
  const [y, m] = day.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return {
    period: `${y}-${String(m).padStart(2, "0")}`,
    from: wallClockToInstant(`${y}-${String(m).padStart(2, "0")}-01`, 0, METERING_TIME_ZONE),
    to: wallClockToInstant(next, 0, METERING_TIME_ZONE),
  };
}

export async function monthlyCustomerMessageUsageInTx(tx: Tx, businessId: number, at: Date): Promise<MonthlyUsage> {
  const month = meteringMonth(at);
  const base = {
    businessId, recipientKind: "CUSTOMER", providerMessageId: { not: null }, completedAt: { gte: month.from, lt: month.to },
  } satisfies Prisma.NotificationDeliveryWhereInput;
  const simulated = await tx.notificationDelivery.count({ where: { ...base, providerMessageId: { startsWith: "sim:" } } });
  const all = await tx.notificationDelivery.count({ where: base });
  const verificationAll = await tx.notificationDelivery.count({ where: { ...base, messageClass: "VERIFICATION" } });
  const verificationSim = await tx.notificationDelivery.count({ where: { ...base, messageClass: "VERIFICATION", providerMessageId: { startsWith: "sim:" } } });
  const sent = all - simulated;
  const verification = verificationAll - verificationSim;
  return { ...month, sent, simulated, operational: sent - verification, verification };
}

export function monthlyCustomerMessageUsage(businessId: number, at: Date = new Date()): Promise<MonthlyUsage> {
  return tenantTx(businessId, (tx) => monthlyCustomerMessageUsageInTx(tx, businessId, at));
}

/** The monthly numeric quota of a business: null = none set (owner decision pending). Never invent a number here. */
export async function customerMessageQuota(businessId: number): Promise<number | null> {
  void businessId;
  return null;
}

/** May one more message be sent this month? With no quota (null), always. */
export function withinQuota(usedThisMonth: number, quota: number | null): boolean {
  return quota === null || usedThisMonth < quota;
}
