import { getAgenda } from "@/lib/services/tasks/agenda.service";
import { json, tasksRoute } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — the agenda (spec 13). Read-only (8.6, T-C6). `?scope=personal`: the task centre's personal list — only the
 * owner's own tasks and series, a year ahead (owner decision 2026-10-21); without it, the full shared agenda.
 */
export async function GET(req: Request) {
  const personal = new URL(req.url).searchParams.get("scope") === "personal";
  return tasksRoute(req, async ({ actor }) => json(await getAgenda(actor.businessId, new Date(), { personal })));
}
