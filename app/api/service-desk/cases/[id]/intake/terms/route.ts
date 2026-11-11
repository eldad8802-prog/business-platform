import { ServiceDeskError } from "@/lib/services/service-desk/service-desk-errors";
import { serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/**
 * POST — the former terms presentation of the intake (1.3b-A).
 * Owner decision 2026-11-11: no customer signature and no legal-terms step in the service desk. The route stays (same
 * edge: 401 / 404 / READ_ONLY) but answers ACTION_NOT_IN_SCOPE and writes nothing; earlier records stay readable.
 */
export async function POST(req: Request) {
  return serviceDeskRoute(req, "write", async () => {
    throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { capability: "intake_terms", reason: "no_customer_signature_policy" });
  });
}
