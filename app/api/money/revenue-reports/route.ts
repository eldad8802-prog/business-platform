import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import { json, reportRoute } from "@/lib/revenue-sources/uploads/http";
import { listUploadedSettlements, listUploadedZReports } from "@/lib/revenue-sources/uploads/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — סגירות קופה ודוחות סליקה: what was recorded from uploaded Z reports and settlement reports in the session's
 * business. READ-ONLY. Only the kinds whose feature is ON for the business are listed (a kind that is OFF is
 * `null`); 404 when both are OFF. These are REPORTS — evidence of the register's day and of the acquirer's credit —
 * never income records: nothing here is a FinancialRecord, a document or a bank line.
 */
export async function GET(req: Request) {
  return reportRoute(req, ["z", "settlement"], async (actor, enabled) => {
    const [z, settlement] = await Promise.all([
      enabled.includes("z") ? listUploadedZReports(actor.businessId) : Promise.resolve(null),
      enabled.includes("settlement") ? listUploadedSettlements(actor.businessId) : Promise.resolve(null),
    ]);
    return json({ enabled, maxBytes: IMPORT_MAX_FILE_BYTES, z, settlement });
  });
}
