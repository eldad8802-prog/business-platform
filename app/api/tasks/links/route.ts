import { searchLinks } from "@/lib/services/tasks/links.service";
import { json, tasksRoute } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?q= — customers and suppliers of this business, for "קשר ל…". Read-only. */
export async function GET(req: Request) {
  return tasksRoute(req, async ({ actor }) => json({ options: await searchLinks(actor.businessId, new URL(req.url).searchParams.get("q") ?? "") }));
}
