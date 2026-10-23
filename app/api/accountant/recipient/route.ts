import { after } from "next/server";

import { accountantRoute, json, jsonBody } from "@/lib/accountant/http";
import { preparePeriod } from "@/lib/accountant/prepare.service";
import { setRecipient } from "@/lib/accountant/recipient.service";
import { runTenantJob } from "@/lib/tenant/job";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — the accountant recipient of this business (or null). */
export async function GET(req: Request) {
  return accountantRoute(req, async (actor) => {
    const r = await tenantTx(actor.businessId, (tx) =>
      tx.accountantRecipient.findUnique({ where: { businessId: actor.businessId } })
    );
    return json({
      recipient: r ? { name: r.name, email: r.email, version: r.version, updatedAt: r.updatedAt.toISOString() } : null,
    });
  });
}

/**
 * PUT — set or change the recipient (D4). Body: { name, email, expectedVersion: number | null,
 * confirm: true }. A change voids every approval that has not started sending.
 */
export async function PUT(req: Request) {
  return accountantRoute(req, async (actor) => {
    const body = await jsonBody(req);
    const now = new Date();
    const result = await setRecipient({
      businessId: actor.businessId,
      userId: actor.userId,
      name: body.name,
      email: body.email,
      expectedVersion: body.expectedVersion ?? null,
      confirm: body.confirm,
      now,
    });
    if (result.canceledApprovals > 0) {
      // The months whose approval was voided show their real status again (no rebuild: same content).
      after(() =>
        runTenantJob({ businessId: actor.businessId }, async () => {
          const periods = await tenantTx(actor.businessId, (tx) =>
            tx.accountantPeriod.findMany({
              where: { businessId: actor.businessId, status: "SENDING" },
              select: { periodKey: true },
            })
          );
          for (const p of periods) {
            await preparePeriod({
              businessId: actor.businessId,
              periodKey: p.periodKey,
              trigger: "OWNER",
              actor: { type: "OWNER_USER", userId: actor.userId },
            }).catch(() => undefined);
          }
        })
      );
    }
    return json({ recipient: { name: result.name, email: result.email, version: result.version }, canceledApprovals: result.canceledApprovals });
  });
}
