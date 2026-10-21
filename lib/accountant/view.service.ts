/**
 * What the owner sees of one period — read-only, tenant-scoped. Shared by the period API and the
 * attention / notification surfaces so they never disagree about a status.
 */

import { readTransactionalEmailConfig } from "@/lib/email/transactional/config";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { deliveryEnabled } from "./delivery.service";
import { addPeriods, isPeriodClosed, isPeriodKey, monthNameHe, periodLabelHe, previousPeriodKey, type PeriodKey } from "./period";
import { openItemsOfStored, parseStoredManifest, parseStoredReadiness, type StoredReadiness } from "./store";
import { isCompleted, periodStatusLabelHe, type DeliveryStatus, type PeriodStatus } from "./workflow-status";

export type PackageView = {
  id: number;
  version: number;
  status: "READY" | "SUPERSEDED";
  /** The approval names this exact object. */
  sha256: string;
  sizeBytes: number;
  readyAt: string;
  openItemCount: number;
  recordCount: number;
  issuedCount: number;
  pendingCount: number;
  missingFiles: number;
};

export type DeliveryView = {
  id: number;
  status: DeliveryStatus;
  packageId: number;
  packageVersion: number;
  recipientName: string | null;
  recipientEmail: string | null;
  approvedAt: string;
  incompleteAcknowledged: boolean;
  openItemCount: number;
  acceptedAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  linkExpiresAt: string;
  linkRevokedAt: string | null;
  downloadCount: number;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
};

export type RecipientView = { name: string; email: string; version: number; updatedAt: string };

export type PeriodView = {
  periodKey: PeriodKey;
  label: string;
  monthName: string;
  closed: boolean;
  prepared: boolean;
  status: PeriodStatus | null;
  statusLabel: string | null;
  changedSinceSent: boolean;
  evaluatedAt: string | null;
  readiness: StoredReadiness | null;
  openItems: number;
  currentPackage: PackageView | null;
  deliveries: DeliveryView[];
  recipient: RecipientView | null;
  completedManually: boolean;
  /** Whether Dubiz may send from here at all (ACCOUNTANT_DELIVERY_ENABLED + a configured email provider). */
  sendingAvailable: boolean;
};

function sendingAvailable(): boolean {
  const cfg = readTransactionalEmailConfig();
  return deliveryEnabled() && cfg.enabled === true && "ok" in cfg && cfg.ok === true;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function getPeriodView(businessId: number, periodKey: PeriodKey, now = new Date()): Promise<PeriodView | null> {
  if (!isPeriodKey(periodKey)) return null;
  return tenantTx(businessId, async (tx) => {
    const period = await tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId, periodKey } } });
    const recipient = await tx.accountantRecipient.findUnique({ where: { businessId } });
    const recipientView: RecipientView | null = recipient
      ? { name: recipient.name, email: recipient.email, version: recipient.version, updatedAt: recipient.updatedAt.toISOString() }
      : null;
    const closed = isPeriodClosed(periodKey, now);
    if (!period) {
      return {
        periodKey,
        label: periodLabelHe(periodKey),
        monthName: monthNameHe(periodKey),
        closed,
        prepared: false,
        status: null,
        statusLabel: null,
        changedSinceSent: false,
        evaluatedAt: null,
        readiness: null,
        openItems: 0,
        currentPackage: null,
        deliveries: [],
        recipient: recipientView,
        completedManually: false,
        sendingAvailable: sendingAvailable(),
      };
    }
    const pkg = period.latestPackageId
      ? await tx.accountantPackage.findFirst({ where: { id: period.latestPackageId, businessId } })
      : null;
    const deliveries = await tx.accountantDelivery.findMany({
      where: { businessId, periodId: period.id },
      orderBy: { id: "desc" },
      take: 10,
    });
    const readiness = parseStoredReadiness(period.readiness);
    const manifest = pkg ? parseStoredManifest(pkg.manifest) : null;
    const status = period.status as PeriodStatus;
    return {
      periodKey,
      label: periodLabelHe(periodKey),
      monthName: monthNameHe(periodKey),
      closed,
      prepared: true,
      status,
      statusLabel: periodStatusLabelHe(status, period.changedSinceSent),
      changedSinceSent: period.changedSinceSent && isCompleted(status),
      evaluatedAt: iso(period.evaluatedAt),
      readiness,
      openItems: openItemsOfStored(readiness),
      currentPackage:
        pkg && (pkg.status === "READY" || pkg.status === "SUPERSEDED") && pkg.readyAt
          ? {
              id: pkg.id,
              version: pkg.version,
              status: pkg.status,
              sha256: pkg.sha256 ?? "",
              sizeBytes: pkg.sizeBytes ?? 0,
              readyAt: pkg.readyAt.toISOString(),
              openItemCount: pkg.openItemCount,
              recordCount: manifest?.recordCount ?? 0,
              issuedCount: manifest?.issuedCount ?? 0,
              pendingCount: manifest?.pendingCount ?? 0,
              missingFiles: manifest?.missingFiles ?? 0,
            }
          : null,
      deliveries: deliveries.map((d) => ({
        id: d.id,
        status: d.status as DeliveryStatus,
        packageId: d.packageId,
        packageVersion: d.packageVersion,
        recipientName: d.recipientName,
        recipientEmail: d.recipientEmail,
        approvedAt: d.approvedAt.toISOString(),
        incompleteAcknowledged: d.incompleteAcknowledged,
        openItemCount: d.openItemCount,
        acceptedAt: iso(d.acceptedAt),
        deliveredAt: iso(d.deliveredAt),
        failedAt: iso(d.failedAt),
        failureCode: d.failureCode,
        linkExpiresAt: d.linkExpiresAt.toISOString(),
        linkRevokedAt: iso(d.linkRevokedAt),
        downloadCount: d.downloadCount,
        firstDownloadedAt: iso(d.firstDownloadedAt),
        lastDownloadedAt: iso(d.lastDownloadedAt),
      })),
      recipient: recipientView,
      completedManually: period.completionKind === "MANUAL",
      sendingAvailable: sendingAvailable(),
    };
  });
}

/** The periods the screen offers: the last twelve closed months, newest first, with their status. */
export async function listRecentPeriods(
  businessId: number,
  now = new Date(),
  count = 12
): Promise<{ periodKey: PeriodKey; label: string; status: PeriodStatus | null; statusLabel: string | null }[]> {
  const keys: PeriodKey[] = Array.from({ length: count }, (_, i) => addPeriods(previousPeriodKey(now), -i));
  const rows = await tenantTx(businessId, (tx) =>
    tx.accountantPeriod.findMany({
      where: { businessId, periodKey: { in: keys } },
      select: { periodKey: true, status: true, changedSinceSent: true },
    })
  );
  const byKey = new Map(rows.map((r) => [r.periodKey, r]));
  return keys.map((key) => {
    const r = byKey.get(key);
    const status = (r?.status ?? null) as PeriodStatus | null;
    return {
      periodKey: key,
      label: periodLabelHe(key),
      status,
      statusLabel: status ? periodStatusLabelHe(status, r!.changedSinceSent) : null,
    };
  });
}
