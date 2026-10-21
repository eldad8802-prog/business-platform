import { cancelDelivery } from "@/lib/accountant/delivery.service";
import { accountantRoute, json, positiveId } from "@/lib/accountant/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ deliveryId: string }> };

/** POST — withdraw an approval that has not started sending (a retry waiting for its next attempt). */
export async function POST(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    await cancelDelivery(actor.businessId, actor.userId, positiveId((await params).deliveryId), new Date());
    return json({ ok: true });
  });
}
