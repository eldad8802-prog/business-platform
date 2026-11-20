import { json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { listCaseTasks, setTaskLink } from "@/lib/services/service-desk/case-extras.service";

type Ctx = { params: Promise<{ id: string }> };

/** GET — tasks linked to this case and open tasks that may be linked (decision 7). available=false until A7 is applied. */
export async function GET(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "read", async ({ principal }) => json(await listCaseTasks(principal.businessId, positiveId((await context.params).id))));
}

/** PUT { taskId, link } — link an open task of this business to the case, or remove the link. */
export async function PUT(req: Request, context: Ctx) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const b = await jsonBody(req);
    return json(await setTaskLink(principal, id, { taskId: b.taskId, link: b.link }));
  });
}
