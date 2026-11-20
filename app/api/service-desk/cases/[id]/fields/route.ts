import { json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { getCaseFields, setCaseFields } from "@/lib/services/service-desk/case-extras.service";

type Ctx = { params: Promise<{ id: string }> };

/** GET — the item location and the estimated date (A7). */
export async function GET(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await getCaseFields(principal.businessId, positiveId((await context.params).id))));
}

/** PUT { itemLocationNote, estimatedReadyOn } — both optional, no alerts. */
export async function PUT(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const b = await jsonBody(req);
    return json(await setCaseFields(principal, id, { itemLocationNote: b.itemLocationNote, estimatedReadyOn: b.estimatedReadyOn }));
  });
}
