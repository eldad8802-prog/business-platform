import { getAgenda } from "@/lib/services/tasks/agenda.service";
import { json, tasksRoute } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — the agenda shared by the task centre and the secretary (spec 13). Read-only (8.6, T-C6). */
export async function GET(req: Request) {
  return tasksRoute(req, async ({ actor }) => json(await getAgenda(actor.businessId)));
}
