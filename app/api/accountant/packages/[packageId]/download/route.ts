import { AccountantError, accountantRoute, positiveId } from "@/lib/accountant/http";
import { packageDownloadName, servePackageObject } from "@/lib/accountant/package-download";
import { XLSX_CONTENT_TYPE, ensurePackageExcel, packageExcelDownloadName } from "@/lib/accountant/package-reports";
import { appendEvent } from "@/lib/accountant/store";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ packageId: string }> };

const FORMATS = ["zip", "xlsx"] as const;
type DownloadFormat = (typeof FORMATS)[number];

/**
 * GET — the owner downloads a stored package version of their own business (RLS + an explicit
 * businessId filter). The response is a five-minute signed URL, never a public one.
 *
 *   ?format=zip  (default) the sealed package ZIP itself;
 *   ?format=xlsx the report workbook taken out of that ZIP, byte for byte, after its sha256 was checked
 *                (lib/accountant/package-reports.ts) — never rebuilt from live data.
 *
 * The download is recorded (with its format) only once the file to hand out is known to be right.
 */
export async function GET(req: Request, { params }: Params) {
  return accountantRoute(req, async (actor) => {
    const id = positiveId((await params).packageId);
    const requested = new URL(req.url).searchParams.get("format") ?? "zip";
    if (!(FORMATS as readonly string[]).includes(requested)) throw new AccountantError(400, "INVALID_FORMAT");
    const format = requested as DownloadFormat;

    const pkg = await tenantTx(actor.businessId, async (tx) => {
      const row = await tx.accountantPackage.findFirst({
        where: { id, businessId: actor.businessId, status: { in: ["READY", "SUPERSEDED"] } },
        select: { id: true, periodId: true, version: true, storageKey: true, sha256: true },
      });
      if (!row || !row.storageKey || !row.sha256) return null;
      const period = await tx.accountantPeriod.findFirst({
        where: { id: row.periodId, businessId: actor.businessId },
        select: { periodKey: true },
      });
      return { ...row, storageKey: row.storageKey, sha256: row.sha256, periodKey: period?.periodKey ?? "period" };
    });
    if (!pkg) throw new AccountantError(404, "NOT_FOUND");

    const served =
      format === "xlsx"
        ? {
            key: (await ensurePackageExcel({ businessId: actor.businessId, periodKey: pkg.periodKey, version: pkg.version, storageKey: pkg.storageKey, sha256: pkg.sha256 })).key,
            name: packageExcelDownloadName(pkg.periodKey, pkg.version),
            contentType: XLSX_CONTENT_TYPE,
          }
        : { key: pkg.storageKey, name: packageDownloadName(pkg.periodKey, pkg.version), contentType: "application/zip" };

    const now = new Date();
    await tenantTx(actor.businessId, (tx) =>
      appendEvent(tx, {
        businessId: actor.businessId,
        periodId: pkg.periodId,
        packageId: pkg.id,
        eventType: "PACKAGE_DOWNLOADED_BY_OWNER",
        actor: { type: "OWNER_USER", userId: actor.userId },
        occurredAt: now,
        payload: { version: pkg.version, format },
        idempotencyKey: `owner-dl:${pkg.id}:${format}:${now.getTime()}`,
      })
    );

    // The same sensor the ad-hoc pack records — the export-cadence learning keeps its evidence.
    await recordSensor({
      businessId: actor.businessId,
      sensor: "DATA_EXPORTED",
      entityId: actor.businessId,
      actor: { type: "OWNER_USER", userId: actor.userId },
      source: "OWNER_UI",
      payload: { kind: "ACCOUNTANT_PACK", format: format === "xlsx" ? "XLSX" : "ZIP" },
    });

    return servePackageObject(served.key, served.name, served.contentType);
  });
}
