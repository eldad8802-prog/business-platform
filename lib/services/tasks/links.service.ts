/**
 * Daily Tasks — "קשור ל…": the entity picker of the create form (Daily Tasks spec 5.1, 9). SERVER-ONLY, read-only.
 *
 * Searches this business's customers and suppliers by name. Leads are not offered: an open lead's follow-up
 * lives on the lead itself (3.3, LINK_LEAD_OPEN), so a task beside it would be a second follow-up engine. The
 * link is still checked by the service and by the composite foreign keys when the task is saved.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

export type LinkOption = { kind: "customer" | "supplier"; id: number; label: string };

export async function searchLinks(businessId: number, q: string): Promise<LinkOption[]> {
  const term = q.trim().slice(0, 60);
  if (term.length < 2) return [];
  const name = { contains: term, mode: "insensitive" as const };
  return tenantTx(businessId, async (tx) => {
    const customers = await tx.customer.findMany({ where: { businessId, name }, select: { id: true, name: true }, take: 5, orderBy: { id: "desc" } });
    const suppliers = await tx.supplier.findMany({ where: { businessId, name }, select: { id: true, name: true }, take: 5, orderBy: { id: "desc" } });
    return [
      ...customers.map((c) => ({ kind: "customer" as const, id: c.id, label: c.name })),
      ...suppliers.map((s) => ({ kind: "supplier" as const, id: s.id, label: s.name })),
    ];
  });
}
