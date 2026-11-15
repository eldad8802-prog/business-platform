import { json, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { listLoans } from "@/lib/services/service-desk/loans.service";

/** GET ?state=OUT|RETURNED|CLOSED|ALL&overdue=true&limit= — the business's loans (default: everything still at customers). */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ principal }) => {
    const u = new URL(req.url);
    return json(await listLoans(principal.businessId, { state: u.searchParams.get("state"), overdue: u.searchParams.get("overdue"), limit: u.searchParams.get("limit") }));
  });
}
