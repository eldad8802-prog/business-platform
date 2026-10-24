/**
 * Prepares one accounting period of one business: evaluate → (re)build the package when the content
 * changed → persist the outcome. Safe to run any number of times and concurrently:
 *
 *   • one evaluation per period at a time (a lease on the period row; a crashed holder's lease expires);
 *   • one build per period at a time (a partial unique index on BUILDING packages);
 *   • the same content never produces a second version (fingerprint comparison);
 *   • a package is built from a snapshot of facts and sealed with its sha256 — a later change of the
 *     data makes a NEW version, it never alters one that exists (database trigger);
 *   • a send that is waiting or done is never touched here.
 *
 * Must run inside the business's tenant context (a request with its session, or `runTenantJob`).
 */

import { getStorageService } from "@/lib/storage";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { buildAccountantPackage, type BuiltAccountantPackage } from "@/lib/reports/accountant-export-zip";
import { getFiscalBillingPdfForDelivery } from "@/lib/services/billing/signed-pdf-delivery.wiring";
import { evaluateReadiness, openItemCount, type PeriodFacts, type Readiness } from "./package-scope";
import { loadPeriodFacts } from "./period-facts";
import { isPeriodClosed, isPeriodKey, periodRange, type PeriodKey } from "./period";
import {
  appendEvent,
  claimPeriodLease,
  createBuildingPackage,
  ensurePeriod,
  failAbandonedBuilds,
  finishEvaluation,
  latestLiveDelivery,
  listPackages,
  parseStoredManifest,
  readinessForStorage,
  releaseLease,
  sentFingerprint,
  type PackageRow,
  type WorkflowActor,
} from "./store";
import { derivePeriodStatus, isCompleted, SUCCESSFUL_DELIVERY, type DeliveryStatus, type PeriodStatus } from "./workflow-status";

/** Longer than a build can take inside a 60 s function, so a live build is never re-claimed. */
export const PERIOD_LEASE_MS = 3 * 60 * 1000;
export const BUILD_LEASE_MS = 3 * 60 * 1000;

export type PrepareTrigger = "SCHEDULE" | "CHANGE" | "OWNER";

export type PrepareOutcome =
  | { outcome: "not_closed" | "invalid_period" | "busy" }
  | {
      outcome: "evaluated" | "built" | "build_failed";
      periodId: number;
      status: PeriodStatus;
      previousStatus: PeriodStatus;
      changedSinceSent: boolean;
      openItems: number;
      packageId: number | null;
      packageVersion: number | null;
    };

export type PrepareDeps = {
  now: () => Date;
  loadFacts: (businessId: number, key: PeriodKey) => Promise<PeriodFacts>;
  build: (args: { businessId: number; periodLabel: string; facts: PeriodFacts; generatedAt: Date }) => Promise<BuiltAccountantPackage>;
  putPackage: (businessId: number, key: string, body: Buffer) => Promise<void>;
  /** Owner-triggered only: renders / signs missing final PDFs through the billing service (owner = actor). */
  prepareIssuedPdfs: (businessId: number, actorUserId: number, billingDocumentIds: number[]) => Promise<number>;
};

export function packageStorageKey(businessId: number, periodKey: PeriodKey, version: number, sha256: string): string {
  return `biz/${businessId}/exports/accountant/${periodKey}/v${version}-${sha256.slice(0, 16)}.zip`;
}

export const defaultPrepareDeps: PrepareDeps = {
  now: () => new Date(),
  loadFacts: (businessId, key) => loadPeriodFacts(businessId, periodRange(key)),
  build: (args) => buildAccountantPackage(args),
  putPackage: async (businessId, key, body) => {
    await getStorageService().putObject({
      key,
      body,
      contentType: "application/zip",
      metadata: { businessId, domain: "exports", visibility: "private" },
    });
  },
  prepareIssuedPdfs: async (businessId, actorUserId, ids) => {
    let prepared = 0;
    for (const billingDocumentId of ids) {
      try {
        // The billing service enforces the authority delivery gate itself and records the render.
        await getFiscalBillingPdfForDelivery({ businessId, actorUserId, billingDocumentId });
        prepared += 1;
      } catch {
        // Still unavailable (e.g. the allocation number is missing): it stays an open item.
      }
    }
    return prepared;
  },
};

function readyPackageFor(packages: PackageRow[], fingerprint: string): PackageRow | null {
  return packages.find((p) => p.status === "READY" && p.contentFingerprint === fingerprint) ?? null;
}

function latestAttemptFailedFor(packages: PackageRow[], fingerprint: string): boolean {
  const newest = packages.find((p) => p.contentFingerprint === fingerprint);
  return newest?.status === "FAILED";
}

/** Issued documents whose final PDF an owner action could still produce (not blocked by the authority gate). */
function ownerPreparablePdfs(facts: PeriodFacts): number[] {
  return facts.issued
    .filter((d) => !d.pdf.available && d.pdf.reason !== "AUTHORITY_NOT_DELIVERABLE")
    .map((d) => d.id);
}

export async function preparePeriod(
  args: {
    businessId: number;
    periodKey: PeriodKey;
    trigger: PrepareTrigger;
    actor: WorkflowActor;
  },
  deps: PrepareDeps = defaultPrepareDeps
): Promise<PrepareOutcome> {
  const { businessId, periodKey, trigger, actor } = args;
  if (!isPeriodKey(periodKey)) return { outcome: "invalid_period" };
  const now = deps.now();
  if (!isPeriodClosed(periodKey, now)) return { outcome: "not_closed" };

  const period = await ensurePeriod(businessId, periodKey, now);
  const claimedAt = await claimPeriodLease(businessId, period.id, now, PERIOD_LEASE_MS);
  if (!claimedAt) return { outcome: "busy" };

  try {
    await failAbandonedBuilds(businessId, period.id, now);

    let facts = await deps.loadFacts(businessId, periodKey);

    // An owner asking for the package may resolve what only an owner action can: rendering final PDFs.
    if (trigger === "OWNER" && actor.type === "OWNER_USER") {
      const ids = ownerPreparablePdfs(facts);
      if (ids.length > 0) {
        const prepared = await deps.prepareIssuedPdfs(businessId, actor.userId, ids);
        if (prepared > 0) {
          facts = await deps.loadFacts(businessId, periodKey);
          await tenantTx(businessId, (tx) =>
            appendEvent(tx, {
              businessId,
              periodId: period.id,
              eventType: "ISSUED_PDFS_PREPARED",
              actor,
              occurredAt: now,
              payload: { prepared },
              idempotencyKey: `pdfs:${period.id}:${now.getTime()}`,
            })
          );
        }
      }
    }

    const evaluated = evaluateReadiness(facts);
    const fingerprint = evaluated.fingerprint;

    const { packages, delivery, sentFp } = await tenantTx(businessId, async (tx) => {
      const pkgs = await listPackages(tx, businessId, period.id);
      const d = await latestLiveDelivery(tx, businessId, period.id);
      const sentPackageId =
        d && SUCCESSFUL_DELIVERY.has(d.status as DeliveryStatus) ? d.packageId : period.completedPackageId ?? null;
      const fp = await sentFingerprint(tx, businessId, period, sentPackageId);
      return { packages: pkgs, delivery: d, sentFp: fp };
    });

    const previousStatus = period.status as PeriodStatus;
    let current = readyPackageFor(packages, fingerprint);
    let built: BuiltAccountantPackage | null = null;
    let buildFailed = false;
    let failureCode: string | null = null;

    if (!current) {
      const slot = await createBuildingPackage(businessId, period.id, fingerprint, now, BUILD_LEASE_MS,
        actor.type === "OWNER_USER" ? actor.userId : null);
      if (!slot) {
        await releaseLease(businessId, period.id, deps.now());
        return { outcome: "busy" };
      }
      try {
        built = await deps.build({ businessId, periodLabel: periodKey, facts, generatedAt: now });
        const key = packageStorageKey(businessId, periodKey, slot.version, built.sha256);
        await deps.putPackage(businessId, key, built.buffer);
        const sealedAt = deps.now();
        current = await tenantTx(businessId, async (tx) => {
          const sealed = await tx.accountantPackage.update({
            where: { id: slot.id },
            data: {
              status: "READY",
              storageKey: key,
              sha256: built!.sha256,
              sizeBytes: built!.buffer.byteLength,
              manifest: {
                fingerprint: built!.manifest.fingerprint,
                recordCount: built!.manifest.recordCount,
                issuedCount: built!.manifest.issuedCount,
                pendingCount: built!.manifest.pendingCount,
                approvedFiles: built!.manifest.approvedFiles,
                issuedFiles: built!.manifest.issuedFiles,
                missingFiles: built!.manifest.missingFiles,
                missingOriginalDocumentIds: built!.manifest.missingOriginalDocumentIds.slice(0, 500),
                missingIssuedDocumentIds: built!.manifest.missingIssuedDocumentIds.slice(0, 500),
              },
              openItemCount: openItemCount(built!.readiness),
              leaseUntil: null,
              readyAt: sealedAt,
            },
          });
          const superseded = await tx.accountantPackage.updateMany({
            where: { businessId, periodId: period.id, status: "READY", id: { not: slot.id } },
            data: { status: "SUPERSEDED", supersededAt: sealedAt },
          });
          await appendEvent(tx, {
            businessId,
            periodId: period.id,
            packageId: slot.id,
            eventType: "PACKAGE_BUILT",
            actor,
            occurredAt: sealedAt,
            payload: {
              version: slot.version,
              sizeBytes: built!.buffer.byteLength,
              openItems: openItemCount(built!.readiness),
              superseded: superseded.count,
              trigger,
            },
            idempotencyKey: `pkg-built:${slot.id}`,
          });
          return sealed;
        });
      } catch (e) {
        buildFailed = true;
        failureCode = "build_failed";
        console.error("[accountant] package build failed", { businessId, periodKey, packageId: slot.id, error: e instanceof Error ? e.name : "unknown" });
        await tenantTx(businessId, async (tx) => {
          await tx.accountantPackage.updateMany({
            where: { id: slot.id, businessId, status: "BUILDING" },
            data: { status: "FAILED", failureCode: "build_failed", leaseUntil: null },
          });
          await appendEvent(tx, {
            businessId,
            periodId: period.id,
            packageId: slot.id,
            eventType: "PACKAGE_BUILD_FAILED",
            actor,
            occurredAt: now,
            payload: { version: slot.version, trigger },
            idempotencyKey: `pkg-failed:${slot.id}`,
          });
        });
      }
    }

    // Readiness with what storage actually held (missing originals / issued PDFs become open items).
    let readiness: Readiness = built?.readiness ?? evaluated;
    if (!built && current) {
      const manifest = parseStoredManifest(current.manifest);
      if (manifest && manifest.missingOriginalDocumentIds.length > 0) {
        readiness = evaluateReadiness(facts, manifest.missingOriginalDocumentIds);
      }
    }

    const changedSinceSent = sentFp !== null && sentFp !== fingerprint;
    const status = derivePeriodStatus({
      readiness: readiness.status,
      currentBuildFailed: buildFailed || (!current && latestAttemptFailedFor(packages, fingerprint)),
      currentPackageReady: current !== null,
      latestDelivery: delivery ? { status: delivery.status as DeliveryStatus } : null,
      completedManually: period.completionKind === "MANUAL",
    });

    const finishedAt = deps.now();
    await tenantTx(businessId, async (tx) => {
      await finishEvaluation(tx, businessId, period.id, claimedAt, finishedAt, {
        status,
        readiness: readinessForStorage(readiness),
        contentFingerprint: fingerprint,
        latestPackageId: current?.id ?? period.latestPackageId ?? null,
        changedSinceSent,
        failureCode,
      });
      await appendEvent(tx, {
        businessId,
        periodId: period.id,
        packageId: current?.id ?? null,
        eventType: "PERIOD_EVALUATED",
        actor,
        occurredAt: finishedAt,
        payload: { status, openItems: openItemCount(readiness), trigger, changedSinceSent },
        idempotencyKey: `eval:${period.id}:${finishedAt.getTime()}`,
      });
      if (changedSinceSent && !period.changedSinceSent && isCompleted(status)) {
        await appendEvent(tx, {
          businessId,
          periodId: period.id,
          packageId: current?.id ?? null,
          eventType: "CHANGED_AFTER_SEND",
          actor,
          occurredAt: finishedAt,
          payload: {},
          idempotencyKey: `changed:${period.id}:${fingerprint.slice(0, 32)}`,
        });
      }
    });

    return {
      // A failure wins: `built` holds the ZIP as soon as it was rendered, before it was stored and sealed.
      outcome: buildFailed ? "build_failed" : built ? "built" : "evaluated",
      periodId: period.id,
      status,
      previousStatus,
      changedSinceSent,
      openItems: openItemCount(readiness),
      packageId: current?.id ?? null,
      packageVersion: current?.version ?? null,
    };
  } catch (e) {
    await releaseLease(businessId, period.id, deps.now()).catch(() => undefined);
    throw e;
  }
}
