import { AccountantError, accountantRoute, positiveId } from "@/lib/accountant/http";
import { packageDownloadName, servePackageObject } from "@/lib/accountant/package-download";
import { appendEvent } from "@/lib/accountant/store";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ packageId: string }> };

/**
 * GET — the owner downloads a stored package version of their own business (RLS + an explicit
 * businessId filter). The response is a five-minute signed URL, never a public one.
 */
export async function GET(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    const id = positiveId((await params).packageId);
    const now = new Date();
    const pkg = await tenantTx(actor.businessId, async (tx) => {
      const row = await tx.accountantPackage.findFirst({
        where: { id, businessId: actor.businessId, status: { in: ["READY", "SUPERSEDED"] } },
        select: { id: true, periodId: true, version: true, storageKey: true },
      });
      if (!row || !row.storageKey) return null;
      const period = await tx.accountantPeriod.findFirst({
        where: { id: row.periodId, businessId: actor.businessId },
        select: { periodKey: true },
      });
      await appendEvent(tx, {
        businessId: actor.businessId,
        periodId: row.periodId,
        packageId: row.id,
        eventType: "PACKAGE_DOWNLOADED_BY_OWNER",
        actor: { type: "OWNER_USER", userId: actor.userId },
        occurredAt: now,
        payload: { version: row.version },
        idempotencyKey: `owner-dl:${row.id}:${now.getTime()}`,
      });
      return { ...row, storageKey: row.storageKey, periodKey: period?.periodKey ?? "period" };
    });
    if (!pkg) throw new AccountantError(404, "NOT_FOUND");

    // The same sensor the ad-hoc pack records — the export-cadence learning keeps its evidence.
    await recordSensor({
      businessId: actor.businessId,
      sensor: "DATA_EXPORTED",
      entityId: actor.businessId,
      actor: { type: "OWNER_USER", userId: actor.userId },
      source: "OWNER_UI",
      payload: { kind: "ACCOUNTANT_PACK", format: "ZIP" },
    });

    return servePackageObject(pkg.storageKey, packageDownloadName(pkg.periodKey, pkg.version));
  });
}
