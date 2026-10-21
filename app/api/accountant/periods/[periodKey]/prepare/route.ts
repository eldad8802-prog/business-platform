import { AccountantError, accountantRoute, json } from "@/lib/accountant/http";
import { isPeriodKey } from "@/lib/accountant/period";
import { preparePeriod } from "@/lib/accountant/prepare.service";
import { getPeriodView } from "@/lib/accountant/view.service";
import { syncPeriodNotice } from "@/lib/accountant/notify";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A real month reads dozens of originals from storage.
export const maxDuration = 60;

type Params = { params: Promise<{ periodKey: string }> };

/**
 * POST — the owner asks for the package of a closed month now (also for months before activation,
 * D7: historical periods stay available on demand). Renders missing final invoice PDFs first, with
 * the owner as the actor, then evaluates and builds a new version only if the content changed.
 */
export async function POST(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    const periodKey = (await params).periodKey;
    if (!isPeriodKey(periodKey)) throw new AccountantError(404, "NOT_FOUND");
    const result = await preparePeriod({
      businessId: actor.businessId,
      periodKey,
      trigger: "OWNER",
      actor: { type: "OWNER_USER", userId: actor.userId },
    });
    if (result.outcome === "not_closed") throw new AccountantError(409, "PERIOD_NOT_CLOSED");
    if (result.outcome === "invalid_period") throw new AccountantError(404, "NOT_FOUND");
    if (result.outcome === "busy") throw new AccountantError(409, "PREPARATION_IN_PROGRESS");
    // The notification centre follows what the owner now sees (it never throws).
    const row = await tenantTx(actor.businessId, (tx) =>
      tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId: actor.businessId, periodKey } } })
    );
    if (row) await syncPeriodNotice(row, new Date());
    return json({ outcome: result.outcome, period: await getPeriodView(actor.businessId, periodKey) });
  });
}
