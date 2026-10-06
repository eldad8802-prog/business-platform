/**
 * Activation status for the owner, per connection — "is it working?" answered from what Dubiz
 * actually received, never from a guess.
 *
 *   lastTestAt      the provider's own test reached Dubiz (Google "Send test data"): the URL and key
 *                   are right. A test is never a lead and never a customer; it is only counted here.
 *   lastDeliveryAt  the latest REAL delivery (a lead, an order, a call)
 *   deliveries30d   real deliveries in the last 30 days
 *
 * Read from the intake receipts' non-personal metadata (`isTest`), inside the business's tenant
 * transaction. Counts and times only.
 */
import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import type { ConnectionView } from "./connection.service";

export type ConnectionActivity = { lastTestAt: string | null; lastDeliveryAt: string | null; deliveries30d: number };

/** The provider-side reference a connection's receipts carry (the Page / instance id; else the endpoint id). */
export function receiptRefOf(c: Pick<ConnectionView, "sourceKey" | "publicId" | "externalResourceId">): string {
  return (c.sourceKey === "meta.lead_ads" || c.sourceKey === "commerce.wix") && c.externalResourceId ? c.externalResourceId : c.publicId;
}

export async function connectionActivity(
  businessId: number,
  connections: Array<Pick<ConnectionView, "id" | "sourceKey" | "publicId" | "externalResourceId">>,
  now = new Date()
): Promise<Map<number, ConnectionActivity>> {
  const out = new Map<number, ConnectionActivity>();
  if (connections.length === 0) return out;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const refs = [...new Set(connections.map(receiptRefOf))];
  const rows = await withTenantTransaction((tx) =>
    tx.$queryRaw<Array<{ source: string; ref: string; lastTest: Date | null; lastReal: Date | null; real30: number }>>`
      SELECT e."sourceKey" AS "source", e."providerAccountRef" AS "ref",
             max(e."receivedAt") FILTER (WHERE e."metadata" ->> 'isTest' = 'true') AS "lastTest",
             max(e."receivedAt") FILTER (WHERE coalesce(e."metadata" ->> 'isTest', 'false') <> 'true') AS "lastReal",
             (count(*) FILTER (WHERE coalesce(e."metadata" ->> 'isTest', 'false') <> 'true' AND e."receivedAt" >= ${since}))::int AS "real30"
        FROM "IntakeEvent" e
       WHERE e."businessId" = ${businessId} AND e."providerAccountRef" IN (${Prisma.join(refs)})
       GROUP BY e."sourceKey", e."providerAccountRef"`
  );
  for (const c of connections) {
    const r = rows.find((x) => x.source === c.sourceKey && x.ref === receiptRefOf(c));
    out.set(c.id, {
      lastTestAt: r?.lastTest ? r.lastTest.toISOString() : null,
      lastDeliveryAt: r?.lastReal ? r.lastReal.toISOString() : null,
      deliveries30d: r?.real30 ?? 0,
    });
  }
  return out;
}
