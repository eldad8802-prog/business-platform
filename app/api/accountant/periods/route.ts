import { accountantRoute, json } from "@/lib/accountant/http";
import { listRecentPeriods } from "@/lib/accountant/view.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — the last twelve closed months and the status of each (the period picker). */
export async function GET(req: Request) {
  return accountantRoute(req, async (actor) => json({ periods: await listRecentPeriods(actor.businessId) }));
}
