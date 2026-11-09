import { json, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { listCaseEvents } from "@/lib/services/service-desk/service-case.service";

/** GET — the case's journal, oldest first. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json({ events: await listCaseEvents(principal.businessId, positiveId((await context.params).id)) }));
}
