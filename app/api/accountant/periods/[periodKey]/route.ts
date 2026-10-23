import { AccountantError, accountantRoute, json } from "@/lib/accountant/http";
import { getPeriodView } from "@/lib/accountant/view.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ periodKey: string }> };

/** GET — one period of this business: status, readiness, the current package, sends and the recipient. */
export async function GET(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    const view = await getPeriodView(actor.businessId, (await params).periodKey);
    if (!view) throw new AccountantError(404, "NOT_FOUND");
    return json({ period: view });
  });
}
