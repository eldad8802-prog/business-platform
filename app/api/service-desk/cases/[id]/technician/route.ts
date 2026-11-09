import { json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { assignTechnician } from "@/lib/services/service-desk/service-case.service";

/** PUT { staffMemberId: number | null, from: number | null } — assign an existing technician, or none (the owner). */
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const b = await jsonBody(req);
    return json(await assignTechnician(principal, id, { staffMemberId: b.staffMemberId, from: b.from }));
  });
}
