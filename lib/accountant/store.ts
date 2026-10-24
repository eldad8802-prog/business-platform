/**
 * Persistence of the monthly accountant workflow. Every statement runs in a tenant transaction
 * (`app.current_business_id`) against FORCE-RLS tables; nothing here takes a business id from a
 * request body — callers pass the server-derived one.
 *
 * Timestamps are always supplied by the application (one `now` per step), never by a database
 * default: these are `timestamp(3)` columns and the session TimeZone is not set.
 */

import { Prisma } from "@prisma/client";
import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";
import type { Readiness } from "./package-scope";
import type { PeriodStatus } from "./workflow-status";

export type WorkflowEventType =
  | "PERIOD_EVALUATED"
  | "PACKAGE_BUILT"
  | "PACKAGE_BUILD_FAILED"
  | "PACKAGE_SUPERSEDED"
  | "PACKAGE_DOWNLOADED_BY_OWNER"
  | "ISSUED_PDFS_PREPARED"
  | "NOTIFIED"
  | "REMINDED"
  | "CHANGED_AFTER_SEND"
  | "RECIPIENT_SET"
  | "RECIPIENT_CHANGED"
  | "DELIVERY_APPROVED"
  | "DELIVERY_CANCELED"
  | "DELIVERY_SENDING"
  | "DELIVERY_RETRY_SCHEDULED"
  | "DELIVERY_ACCEPTED"
  | "DELIVERY_DELIVERED"
  | "DELIVERY_BOUNCED"
  | "DELIVERY_FAILED"
  | "LINK_DOWNLOADED"
  | "LINK_REFUSED"
  | "LINK_REVOKED"
  | "PERIOD_COMPLETED"
  | "PERIOD_COMPLETED_MANUALLY";

export type WorkflowActor =
  | { type: "OWNER_USER"; userId: number }
  | { type: "SYSTEM" }
  | { type: "RECIPIENT" }
  | { type: "PROVIDER" };

/** A payload is closed: numbers, booleans, null and short tokens. The database refuses anything else. */
export type EventPayload = Record<string, number | boolean | null | string | number[]>;

export async function appendEvent(
  tx: TenantTxClient,
  ev: {
    businessId: number;
    periodId?: number | null;
    packageId?: number | null;
    deliveryId?: number | null;
    eventType: WorkflowEventType;
    actor: WorkflowActor;
    occurredAt: Date;
    payload?: EventPayload;
    idempotencyKey: string;
  }
): Promise<void> {
  // ON CONFLICT DO NOTHING inside the caller's transaction: a retried step never aborts it.
  await tx.$executeRaw`
    INSERT INTO "AccountantWorkflowEvent"
      ("businessId", "periodId", "packageId", "deliveryId", "eventType", "actor", "actorUserId", "occurredAt", "payload", "idempotencyKey")
    VALUES (
      ${ev.businessId}, ${ev.periodId ?? null}, ${ev.packageId ?? null}, ${ev.deliveryId ?? null},
      ${ev.eventType}, ${ev.actor.type}, ${ev.actor.type === "OWNER_USER" ? ev.actor.userId : null},
      ${ev.occurredAt}, ${JSON.stringify(ev.payload ?? {})}::jsonb, ${ev.idempotencyKey}
    )
    ON CONFLICT ("businessId", "idempotencyKey") DO NOTHING`;
}

/** Readiness as stored on the period: counts, ids and tokens only (the database enforces it). */
export function readinessForStorage(r: Readiness): Prisma.InputJsonValue {
  return {
    status: r.status,
    counts: r.counts,
    blockers: r.blockers.map((b) => ({
      kind: b.kind,
      count: b.count,
      ids: "documentIds" in b ? b.documentIds.slice(0, 200) : b.billingDocumentIds.slice(0, 200),
    })),
    warnings: r.warnings.map((w) =>
      w.kind === "DATE_FROM_UPLOAD_TIME"
        ? { kind: w.kind, count: w.count, ids: w.recordIds.slice(0, 200) }
        : { kind: w.kind, count: w.count, ids: w.pairs.slice(0, 100).map((p) => p.recordId) }
    ),
    issuedTotals: r.issuedTotals.map((t) => ({
      documentType: t.documentType,
      currency: t.currency,
      count: t.count,
      totalAmount: t.totalAmount,
      vatAmount: t.vatAmount,
    })),
  };
}

export type StoredReadiness = {
  status: "READY" | "NEEDS_ATTENTION";
  counts: Readiness["counts"];
  blockers: { kind: Readiness["blockers"][number]["kind"]; count: number; ids: number[] }[];
  warnings: { kind: Readiness["warnings"][number]["kind"]; count: number; ids: number[] }[];
  issuedTotals: Readiness["issuedTotals"];
};

export function parseStoredReadiness(value: unknown): StoredReadiness | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<StoredReadiness>;
  if (v.status !== "READY" && v.status !== "NEEDS_ATTENTION") return null;
  return {
    status: v.status,
    counts: v.counts ?? { scannedExpense: 0, scannedIncome: 0, issued: 0, pending: 0 },
    blockers: Array.isArray(v.blockers) ? v.blockers : [],
    warnings: Array.isArray(v.warnings) ? v.warnings : [],
    // A total stored before the currency was recorded is ILS (every issued document was, until then).
    issuedTotals: Array.isArray(v.issuedTotals) ? v.issuedTotals.map((t) => ({ ...t, currency: t.currency || "ILS" })) : [],
  };
}

export function openItemsOfStored(r: StoredReadiness | null): number {
  return (r?.blockers ?? []).reduce((n, b) => n + (Number(b.count) || 0), 0);
}

// ── Periods ─────────────────────────────────────────────────────────────────────────────────────

export type PeriodRow = Prisma.AccountantPeriodGetPayload<Record<string, never>>;
export type PackageRow = Prisma.AccountantPackageGetPayload<Record<string, never>>;
export type DeliveryRow = Prisma.AccountantDeliveryGetPayload<Record<string, never>>;

/** Creates the period row on first sight (status PREPARING). Idempotent under concurrency. */
export async function ensurePeriod(businessId: number, periodKey: string, now: Date): Promise<PeriodRow> {
  return tenantTx(businessId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "AccountantPeriod" ("businessId", "periodKey", "status", "createdAt", "updatedAt")
      VALUES (${businessId}, ${periodKey}, 'PREPARING', ${now}, ${now})
      ON CONFLICT ("businessId", "periodKey") DO NOTHING`;
    return tx.accountantPeriod.findUniqueOrThrow({ where: { businessId_periodKey: { businessId, periodKey } } });
  });
}

export async function findPeriod(businessId: number, periodKey: string): Promise<PeriodRow | null> {
  return tenantTx(businessId, (tx) =>
    tx.accountantPeriod.findUnique({ where: { businessId_periodKey: { businessId, periodKey } } })
  );
}

/**
 * Claims the evaluation lease of a period: exactly one caller wins while the lease is live. A crashed
 * holder's lease simply expires. Returns the claim instant, or null when someone else holds it.
 */
export async function claimPeriodLease(
  businessId: number,
  periodId: number,
  now: Date,
  leaseMs: number
): Promise<Date | null> {
  const until = new Date(now.getTime() + leaseMs);
  const n = await tenantTx(businessId, (tx) =>
    tx.accountantPeriod.updateMany({
      where: { id: periodId, businessId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { leaseUntil: until, attempts: { increment: 1 }, updatedAt: now },
    })
  );
  return n.count === 1 ? now : null;
}

/** Marks a CLOSED period of the business as needing re-evaluation (late approval, a new issue…). */
export async function markPeriodDirty(businessId: number, periodKey: string, now: Date): Promise<boolean> {
  const n = await tenantTx(businessId, (tx) =>
    tx.accountantPeriod.updateMany({ where: { businessId, periodKey }, data: { dirtyAt: now, updatedAt: now } })
  );
  return n.count > 0;
}

export async function listPackages(tx: TenantTxClient, businessId: number, periodId: number): Promise<PackageRow[]> {
  return tx.accountantPackage.findMany({ where: { businessId, periodId }, orderBy: { version: "desc" } });
}

/** The newest delivery that was not canceled. */
export async function latestLiveDelivery(
  tx: TenantTxClient,
  businessId: number,
  periodId: number
): Promise<DeliveryRow | null> {
  return tx.accountantDelivery.findFirst({
    where: { businessId, periodId, status: { not: "CANCELED" } },
    orderBy: { id: "desc" },
  });
}

/** Fingerprint of what was last sent (or marked as sent) for the period, if anything. */
export async function sentFingerprint(
  tx: TenantTxClient,
  businessId: number,
  period: Pick<PeriodRow, "id" | "completionKind" | "contentFingerprint">,
  sentPackageId: number | null
): Promise<string | null> {
  if (sentPackageId === null) return null;
  const pkg = await tx.accountantPackage.findFirst({
    where: { id: sentPackageId, businessId, periodId: period.id },
    select: { contentFingerprint: true },
  });
  return pkg?.contentFingerprint ?? null;
}

/** Inserts the next BUILDING version, or returns null when a build for the period is already in flight. */
export async function createBuildingPackage(
  businessId: number,
  periodId: number,
  fingerprint: string,
  now: Date,
  leaseMs: number,
  builtByUserId: number | null
): Promise<{ id: number; version: number } | null> {
  try {
    return await tenantTx(businessId, async (tx) => {
      const last = await tx.accountantPackage.findFirst({
        where: { businessId, periodId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const created = await tx.accountantPackage.create({
        data: {
          businessId,
          periodId,
          version: (last?.version ?? 0) + 1,
          contentFingerprint: fingerprint,
          status: "BUILDING",
          builtByUserId,
          leaseUntil: new Date(now.getTime() + leaseMs),
          createdAt: now,
        },
        select: { id: true, version: true },
      });
      return created;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
    throw e;
  }
}

/** A BUILDING row whose lease expired belongs to a crashed build: it is closed as FAILED. */
export async function failAbandonedBuilds(businessId: number, periodId: number, now: Date): Promise<number> {
  const n = await tenantTx(businessId, (tx) =>
    tx.accountantPackage.updateMany({
      where: { businessId, periodId, status: "BUILDING", leaseUntil: { lt: now } },
      data: { status: "FAILED", failureCode: "build_abandoned" },
    })
  );
  return n.count;
}

export type StoredManifest = {
  fingerprint: string;
  recordCount: number;
  issuedCount: number;
  pendingCount: number;
  approvedFiles: number;
  issuedFiles: number;
  missingFiles: number;
  missingOriginalDocumentIds: number[];
  missingIssuedDocumentIds: number[];
};

export function parseStoredManifest(value: unknown): StoredManifest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<StoredManifest>;
  if (typeof v.fingerprint !== "string") return null;
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n)) : []);
  return {
    fingerprint: v.fingerprint,
    recordCount: Number(v.recordCount) || 0,
    issuedCount: Number(v.issuedCount) || 0,
    pendingCount: Number(v.pendingCount) || 0,
    approvedFiles: Number(v.approvedFiles) || 0,
    issuedFiles: Number(v.issuedFiles) || 0,
    missingFiles: Number(v.missingFiles) || 0,
    missingOriginalDocumentIds: ids(v.missingOriginalDocumentIds),
    missingIssuedDocumentIds: ids(v.missingIssuedDocumentIds),
  };
}

export type PeriodUpdate = {
  status: PeriodStatus;
  readiness: Prisma.InputJsonValue;
  contentFingerprint: string;
  latestPackageId?: number | null;
  changedSinceSent: boolean;
  failureCode: string | null;
};

/**
 * Ends an evaluation: writes the outcome, releases the lease, and clears `dirtyAt` only if nothing
 * marked the period dirty after the claim (a concurrent late approval is never lost).
 */
export async function finishEvaluation(
  tx: TenantTxClient,
  businessId: number,
  periodId: number,
  claimedAt: Date,
  now: Date,
  update: PeriodUpdate
): Promise<void> {
  await tx.accountantPeriod.update({
    where: { id: periodId },
    data: {
      status: update.status,
      readiness: update.readiness,
      contentFingerprint: update.contentFingerprint,
      ...(update.latestPackageId !== undefined ? { latestPackageId: update.latestPackageId } : {}),
      changedSinceSent: update.changedSinceSent,
      failureCode: update.failureCode,
      evaluatedAt: now,
      leaseUntil: null,
      updatedAt: now,
    },
  });
  await tx.accountantPeriod.updateMany({
    where: { id: periodId, businessId, dirtyAt: { lte: claimedAt } },
    data: { dirtyAt: null },
  });
}

export async function releaseLease(businessId: number, periodId: number, now: Date): Promise<void> {
  await tenantTx(businessId, (tx) =>
    tx.accountantPeriod.updateMany({ where: { id: periodId, businessId }, data: { leaseUntil: null, updatedAt: now } })
  );
}
