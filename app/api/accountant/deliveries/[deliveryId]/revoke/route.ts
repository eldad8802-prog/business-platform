import { revokeLink } from "@/lib/accountant/delivery.service";
import { accountantRoute, json, positiveId } from "@/lib/accountant/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ deliveryId: string }> };

/** POST — the owner revokes the accountant's link (D3). Permanent; a new send makes a new link. */
export async function POST(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    await revokeLink(actor.businessId, actor.userId, positiveId((await params).deliveryId), new Date());
    return json({ ok: true });
  });
}
