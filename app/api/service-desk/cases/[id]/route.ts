import { json, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getCase } from "@/lib/services/service-desk/service-case.service";

/** GET — the case card. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getCase(principal.businessId, positiveId((await context.params).id))));
}
