import { after } from "next/server";

import { attemptDelivery, approveDelivery } from "@/lib/accountant/delivery.service";
import { accountantRoute, json, jsonBody } from "@/lib/accountant/http";
import { syncPeriodNotice } from "@/lib/accountant/notify";
import { getPeriodView } from "@/lib/accountant/view.service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { runTenantJob } from "@/lib/tenant/job";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ periodKey: string }> };

/**
 * POST — the owner approves sending THIS package version to THIS recipient (Option B).
 *
 * Body: { packageId, packageSha256, recipientVersion, recipientEmail, acknowledgeIncomplete }
 * Header: Idempotency-Key.
 *
 * The approval is refused unless every value matches the current state exactly (see approveDelivery).
 * The first send attempt runs right after the response; the sweep retries on its schedule.
 */
export async function POST(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    const decision = await checkRateLimit({ bucket: "ACCOUNTANT_SEND", user: actor.userId, business: actor.businessId });
    if (!decision.allowed) return buildRateLimitResponse(decision);

    const periodKey = (await params).periodKey;
    const body = await jsonBody(req);
    const now = new Date();
    const approved = await approveDelivery({
      businessId: actor.businessId,
      userId: actor.userId,
      periodKey,
      packageId: body.packageId,
      packageSha256: body.packageSha256,
      recipientVersion: body.recipientVersion,
      recipientEmail: body.recipientEmail,
      acknowledgeIncomplete: body.acknowledgeIncomplete,
      idempotencyKey: req.headers.get("idempotency-key"),
      now,
    });

    after(() =>
      runTenantJob({ businessId: actor.businessId }, async () => {
        await attemptDelivery(actor.businessId, approved.deliveryId, new Date());
        const period = await tenantTx(actor.businessId, (tx) =>
          tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId: actor.businessId, periodKey } } })
        );
        if (period) await syncPeriodNotice(period, new Date());
      }).catch((e) =>
        console.error("[accountant] first send attempt failed", { deliveryId: approved.deliveryId, error: e instanceof Error ? e.name : "unknown" })
      )
    );

    return json({ deliveryId: approved.deliveryId, created: approved.created, period: await getPeriodView(actor.businessId, periodKey) }, approved.created ? 201 : 200);
  });
}
