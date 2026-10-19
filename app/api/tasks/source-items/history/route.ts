import { getItemHistory } from "@/lib/services/tasks/item-history.service";
import { json, tasksRoute } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?sourceKind=&dedupeKey= — the handling history of one business item of this business. Read-only. */
export async function GET(req: Request) {
  return tasksRoute(req, async ({ actor }) => {
    const q = new URL(req.url).searchParams;
    return json({ history: await getItemHistory(actor.businessId, q.get("sourceKind") ?? "", q.get("dedupeKey") ?? "") });
  });
}
