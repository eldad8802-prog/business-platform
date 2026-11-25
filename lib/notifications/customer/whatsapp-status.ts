/**
 * Delivery statuses of CUSTOMER messages sent from the central Dubiz number (G14, appointments completion program).
 * SERVER-ONLY. Called by the WhatsApp webhook (app/api/integrations/whatsapp/webhook) for statuses whose
 * phone_number_id is the PLATFORM's — a branch of its own, before the per-business resolver, which it never reaches.
 *
 * For each status: notification_delivery_by_provider_message(wamid) (SECURITY DEFINER: an exact match on the unique
 * provider id, well-formed ids only, live businesses only → the business and the delivery id, nothing else), then ONE
 * UPDATE in that business's tenant transaction. The database guard (NotificationDelivery_customer_guard) keeps the
 * status monotonic — sent → delivered → read, failed only from nothing or sent — and IGNORES an older, equal or
 * contradicting status (the statement succeeds, the row keeps what it has). So a repeated webhook, a redelivery or
 * statuses arriving out of order change nothing twice: idempotent and monotonic by construction.
 *
 * It NEVER creates anything — no Conversation, no Message, no IntakeEvent, no Customer: a customer message's receipt
 * must not pollute any business's Inbox. Unknown ids (another platform's, a deleted business's) are ignored.
 * A database error propagates: the webhook answers 500 and Meta redelivers.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import type { WhatsAppWebhookStatusSummary } from "@/lib/services/integrations/whatsapp/types";

const PROVIDER_ID = /^[A-Za-z0-9_.:=+/-]{1,200}$/;
const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

export type PlatformStatusReport = { received: number; applied: number; unknown: number; invalid: number };

/** Meta's timestamp (epoch seconds, a string) → an instant; absent / absurd → now. */
export function statusInstant(timestamp: string | null, now: Date): Date {
  if (!timestamp || !/^[0-9]{9,11}$/.test(timestamp)) return now;
  const t = new Date(Number(timestamp) * 1000);
  // Never in the future and never before the platform existed.
  return t.getTime() > now.getTime() || t.getTime() < Date.UTC(2020, 0, 1) ? now : t;
}

export async function applyPlatformStatuses(statuses: readonly WhatsAppWebhookStatusSummary[], now: Date = new Date()): Promise<PlatformStatusReport> {
  const report: PlatformStatusReport = { received: statuses.length, applied: 0, unknown: 0, invalid: 0 };
  for (const s of statuses) {
    const wamid = s.wamid ?? "";
    const status = s.status ?? "";
    if (!PROVIDER_ID.test(wamid) || !STATUSES.has(status)) {
      report.invalid += 1;
      continue;
    }
    const rows = await prisma.$queryRaw<{ businessId: number; deliveryId: number }[]>`
      SELECT "businessId", "deliveryId" FROM public.notification_delivery_by_provider_message(${wamid})`;
    const hit = rows[0];
    if (!hit) {
      report.unknown += 1;
      continue;
    }
    const businessId = Number(hit.businessId);
    const deliveryId = Number(hit.deliveryId);
    const at = statusInstant(s.timestamp, now);
    const n = await tenantTx(businessId, (tx) =>
      tx.notificationDelivery.updateMany({
        where: { id: deliveryId, businessId, recipientKind: "CUSTOMER", providerMessageId: wamid },
        data: { providerStatus: status, providerUpdatedAt: at },
      }),
    );
    report.applied += n.count;
  }
  return report;
}
