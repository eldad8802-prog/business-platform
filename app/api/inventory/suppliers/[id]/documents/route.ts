/**
 * The documents linked to one supplier (flag `document_supplier_linking`) — links to the source records
 * only. Amounts come from the approved FinancialRecord alone; nothing is summed here.
 *
 *   GET ?offset=&limit=   → { rows, total, hasMore, offset, limit }
 */
import { listSupplierDocuments } from "@/lib/services/documents/supplier-link/supplier-link.service";
import { invalid, positiveInt, supplierLinkRoute } from "@/lib/services/documents/supplier-link/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, context: Ctx) {
  const { id } = await context.params;
  return supplierLinkRoute(req, async ({ businessId }) => {
    const supplierId = positiveInt(id) ?? invalid();
    const url = new URL(req.url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) invalid();
    return listSupplierDocuments({ businessId, supplierId, offset, limit });
  });
}
