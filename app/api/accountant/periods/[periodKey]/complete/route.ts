import { completeManually } from "@/lib/accountant/delivery.service";
import { AccountantError, accountantRoute, json, jsonBody } from "@/lib/accountant/http";
import { syncPeriodNotice } from "@/lib/accountant/notify";
import { isPeriodKey } from "@/lib/accountant/period";
import { getPeriodView } from "@/lib/accountant/view.service";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ periodKey: string }> };

/** POST — "I sent it myself" for a package version. Owner-reported, labelled as such. Body: { packageId, confirm: true } */
export async function POST(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    const periodKey = (await params).periodKey;
    if (!isPeriodKey(periodKey)) throw new AccountantError(404, "NOT_FOUND");
    const body = await jsonBody(req);
    if (body.confirm !== true) throw new AccountantError(400, "CONFIRMATION_REQUIRED");
    const packageId = Number(body.packageId);
    if (!Number.isInteger(packageId) || packageId < 1) throw new AccountantError(400, "INVALID_PACKAGE");
    const now = new Date();
    await completeManually(actor.businessId, actor.userId, periodKey, packageId, now);
    const period = await tenantTx(actor.businessId, (tx) =>
      tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId: actor.businessId, periodKey } } })
    );
    if (period) await syncPeriodNotice(period, now);
    return json({ period: await getPeriodView(actor.businessId, periodKey) });
  });
}
