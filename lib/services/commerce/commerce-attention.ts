/**
 * M7-B / M7-C — the Secretary's EXCEPTIONS from stores and phone systems (docs/business-intake-m7-decision-v1.md §10).
 *
 * Orders are business-as-usual: there is NO attention item per order. Only what the owner should act on surfaces:
 *
 *   reversals    a cancel or a refund (applied, in the window) on an order of a KNOWN customer who has an OPEN
 *                lead — the deal being worked may have just changed
 *   connections  a store or phone connection the owner must fix (status ERROR + its code: keys revoked in the
 *                store, the Wix app uninstalled, the store's webhooks could not be set up)
 *
 * Read-time, tenant-scoped, nothing stored, nothing sent, nothing changed; no amount, name or number is shown —
 * a reversal is its kind, its time and the lead it concerns.
 */

import { Prisma } from "@prisma/client";
import { OPEN_LEAD_STATUSES } from "@/lib/services/crm/lead-core";

type Tx = Prisma.TransactionClient;

export const COMMERCE_BRIEFING_DAYS = 7;
const TOP = 5;
const STORE_AND_PHONE_SOURCES = ["commerce.woocommerce", "commerce.wix", "telephony.cloudtalk", "telephony.voicenter"];

export type CommerceBriefing = {
  /** Cancels / refunds on orders of customers with an open lead (strongest = latest first). */
  reversals: { total: number; items: Array<{ leadId: number; kind: "cancelled" | "refunded"; at: string }> };
  /** Store / phone connections waiting for the owner. */
  connections: Array<{ id: number; sourceKey: string; code: string | null }>;
  windowDays: number;
};

export function emptyCommerceBriefing(): CommerceBriefing {
  return { reversals: { total: 0, items: [] }, connections: [], windowDays: COMMERCE_BRIEFING_DAYS };
}

export async function loadCommerceBriefing(tx: Tx, businessId: number, now: Date): Promise<CommerceBriefing> {
  const since = new Date(now.getTime() - COMMERCE_BRIEFING_DAYS * 86_400_000);
  const open = [...OPEN_LEAD_STATUSES];
  // One item per lead: its latest reversal in the window.
  const rows = await tx.$queryRaw<Array<{ leadId: number; kind: string; at: Date }>>`
    SELECT DISTINCT ON (l."id") l."id" AS "leadId", ev."kind", ev."providerUpdatedAt" AS "at"
      FROM "CommerceOrderEvent" ev
      JOIN "CommerceOrder" o ON o."id" = ev."orderId" AND o."businessId" = ev."businessId"
      JOIN "Lead" l ON l."businessId" = o."businessId" AND l."customerId" = o."customerId"
     WHERE ev."businessId" = ${businessId} AND ev."applied" = true AND ev."kind" IN ('cancelled', 'refunded')
       AND ev."providerUpdatedAt" >= ${since} AND o."customerId" IS NOT NULL
       AND l."status"::text IN (${Prisma.join(open)})
     ORDER BY l."id", ev."providerUpdatedAt" DESC`;
  const sorted = rows.sort((a, b) => b.at.getTime() - a.at.getTime());
  const connections = await tx.acquisitionConnection.findMany({
    where: { businessId, sourceKey: { in: STORE_AND_PHONE_SOURCES }, status: "ERROR" },
    select: { id: true, sourceKey: true, lastErrorCode: true },
    orderBy: { id: "asc" },
  });
  return {
    reversals: {
      total: sorted.length,
      items: sorted.slice(0, TOP).map((r) => ({ leadId: r.leadId, kind: r.kind === "cancelled" ? "cancelled" : "refunded", at: r.at.toISOString() })),
    },
    connections: connections.map((c) => ({ id: c.id, sourceKey: c.sourceKey, code: c.lastErrorCode })),
    windowDays: COMMERCE_BRIEFING_DAYS,
  };
}
