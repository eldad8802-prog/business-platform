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
 * UNCERTAIN attempts (whatsapp-worker.ts, owner item 6): a send whose outcome is unknown (timeout, 5xx, a worker that
 * overran its lease) has no provider id on its row. Meta echoes the attempt's biz_opaque_callback_data
 * ("dz1:b<business>:d<delivery>:<token>") in the status webhook, so a status whose id is unknown but whose callback
 * names a row still marked with THAT token (inflight / uncertain / unresolved — a fresh 128-bit token per attempt,
 * checked inside the business's tenant transaction under RLS, on a payload signed by Meta) records the message as SENT
 * with Meta's id — once (providerMessageId is write-once). Never a resend.
 *
 * It NEVER creates anything — no Conversation, no Message, no IntakeEvent, no Customer: a customer message's receipt
 * must not pollute any business's Inbox. Unknown ids (another platform's, a deleted business's) are ignored.
 * A database error propagates: the webhook answers 500 and Meta redelivers.
 */
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { fence } from "./whatsapp-worker";

const PROVIDER_ID = /^[A-Za-z0-9_.:=+/-]{1,200}$/;
const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

export type PlatformStatus = {
  wamid: string | null;
  status: string | null;
  timestamp: string | null;
  /** biz_opaque_callback_data echoed by Meta (our attempt fence), if any. */
  callbackData?: string | null;
};

export type PlatformStatusReport = { received: number; applied: number; resolved: number; unknown: number; invalid: number };

/** Meta's timestamp (epoch seconds, a string) → an instant; absent / absurd → now. */
export function statusInstant(timestamp: string | null, now: Date): Date {
  if (!timestamp || !/^[0-9]{9,11}$/.test(timestamp)) return now;
  const t = new Date(Number(timestamp) * 1000);
  // Never in the future and never before the platform existed.
  return t.getTime() > now.getTime() || t.getTime() < Date.UTC(2020, 0, 1) ? now : t;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/**
 * The statuses of the PLATFORM number from a (signature-verified) webhook body — read here rather than through the
 * shared parser, so the per-business path stays byte-identical. Bounded: at most 500 statuses.
 */
export function platformStatusesFromBody(body: unknown, platformId: string): PlatformStatus[] {
  const out: PlatformStatus[] = [];
  const entries = (body as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const changes = (e as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      const ch = c as { field?: unknown; value?: { metadata?: { phone_number_id?: unknown }; statuses?: unknown } };
      const value = ch?.value;
      if (ch?.field !== "messages" || !value || str(value.metadata?.phone_number_id, 64) !== platformId) continue;
      if (!Array.isArray(value.statuses)) continue;
      for (const s of value.statuses) {
        if (out.length >= 500) return out;
        const r = s as Record<string, unknown>;
        out.push({
          wamid: str(r.id, 200),
          status: str(r.status, 20)?.toLowerCase() ?? null,
          timestamp: str(r.timestamp, 20),
          callbackData: str(r.biz_opaque_callback_data, 512),
        });
      }
    }
  }
  return out;
}

export async function applyPlatformStatuses(statuses: readonly PlatformStatus[], now: Date = new Date()): Promise<PlatformStatusReport> {
  const report: PlatformStatusReport = { received: statuses.length, applied: 0, resolved: 0, unknown: 0, invalid: 0 };
  for (const s of statuses) {
    const wamid = s.wamid ?? "";
    const status = s.status ?? "";
    if (!PROVIDER_ID.test(wamid) || !STATUSES.has(status)) {
      report.invalid += 1;
      continue;
    }
    const at = statusInstant(s.timestamp, now);
    const rows = await prisma.$queryRaw<{ businessId: number; deliveryId: number }[]>`
      SELECT "businessId", "deliveryId" FROM public.notification_delivery_by_provider_message(${wamid})`;
    const hit = rows[0];
    if (hit) {
      const businessId = Number(hit.businessId);
      const deliveryId = Number(hit.deliveryId);
      const n = await tenantTx(businessId, (tx) =>
        tx.notificationDelivery.updateMany({
          where: { id: deliveryId, businessId, recipientKind: "CUSTOMER", providerMessageId: wamid },
          data: { providerStatus: status, providerUpdatedAt: at },
        }),
      );
      report.applied += n.count;
      continue;
    }
    // Unknown id: an uncertain attempt of ours, named by its echoed fence?
    const cb = fence.parseCallback(s.callbackData);
    if (!cb) {
      report.unknown += 1;
      continue;
    }
    const n = await tenantTx(cb.businessId, (tx) =>
      tx.notificationDelivery.updateMany({
        where: {
          id: cb.deliveryId, businessId: cb.businessId, recipientKind: "CUSTOMER", providerMessageId: null,
          status: { in: ["PENDING", "FAILED"] },
          OR: [{ error: fence.inflight(cb.token) }, { error: fence.uncertain(cb.token) }, { error: fence.unresolved(cb.token) }],
        },
        data: { status: "SENT", providerMessageId: wamid, providerStatus: status, providerUpdatedAt: at, error: null, completedAt: now, leaseUntil: null },
      }),
    );
    if (n.count === 1) report.resolved += 1;
    else report.unknown += 1;
  }
  return report;
}
