/**
 * Service Desk 1.3b — the intake orphan sweep. NOT SCHEDULED: a library function only (owner, 2026-11-11: prepare it,
 * do not run it). Dry run by default.
 *
 * An intake object (photo, signature, slip) is uploaded BEFORE its command transaction. When that command then fails (a
 * refusal under the lock, a version conflict, a crash) the object stays with no row naming it. Content addressing makes a
 * retry reuse it, but an abandoned one stays until the account erasure removes the business's whole prefix. This sweep
 * removes such objects in a live business, and only those:
 *
 *   - only keys of the exact intake shapes: biz/{b}/service/cases/{c}/intake/{photos|signature|slip}/{sha256}.{ext}
 *     (anything else under the prefix is not this sweep's to judge);
 *   - only objects OLDER than the grace period (default 24 h, never less than 1 h): an upload in flight is minutes old;
 *     an object without a modification time is kept;
 *   - only while holding the case row lock (SELECT … FOR UPDATE) and only when no row names the key — a command writes
 *     its row under that same lock and first re-checks its object (ensureStoredUnderLock), so a swept object is written
 *     again by a late command and a row never names a missing object;
 *   - never in a business being deleted (the erasure job owns it), never a case that no longer exists.
 */
import { getStorageService, type StorageService } from "@/lib/storage";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { serviceBusinessPrefix } from "./storage/service-storage-keys";

export const SWEEP_GRACE_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const SWEEP_GRACE_MIN_MS = 60 * 60 * 1000;

export type SweepKind = "photo" | "signature" | "slip";
export type SweepCandidate = { key: string; caseId: number; kind: SweepKind };
export type SweepReport = {
  businessId: number;
  dryRun: boolean;
  scanned: number;
  ignored: number;
  kept: { key: string; reason: "TOO_YOUNG" | "NO_TIME" | "LINKED" | "CASE_GONE" }[];
  orphans: string[];
  deleted: string[];
  skipped: "BUSINESS_DELETING" | null;
};

const SHAPE = /^cases\/([1-9][0-9]*)\/intake\/(photos|signature|slip)\/[0-9a-f]{64}\.(jpg|png|webp|pdf)$/;

/** Pure: the intake key shape under a business prefix, or null (not this sweep's object). */
export function parseIntakeKey(key: string, businessId: number): SweepCandidate | null {
  const prefix = serviceBusinessPrefix(businessId);
  if (!key.startsWith(prefix) || key.includes("..")) return null;
  const m = SHAPE.exec(key.slice(prefix.length));
  if (!m) return null;
  const kind: SweepKind = m[2] === "photos" ? "photo" : m[2] === "signature" ? "signature" : "slip";
  const ext = m[3];
  if ((kind === "signature" && ext !== "png") || (kind === "slip" && ext !== "pdf") || (kind === "photo" && ext === "pdf")) return null;
  return { key, caseId: Number(m[1]), kind };
}

/** Pure: is the object old enough to be judged? (a missing time keeps it) */
export function oldEnough(lastModified: string | undefined, now: Date, graceMs: number): "OK" | "TOO_YOUNG" | "NO_TIME" {
  if (!lastModified) return "NO_TIME";
  const t = Date.parse(lastModified);
  if (Number.isNaN(t)) return "NO_TIME";
  return now.getTime() - t >= Math.max(graceMs, SWEEP_GRACE_MIN_MS) ? "OK" : "TOO_YOUNG";
}

/** Sweep one business's intake orphans. `dryRun` (default true) reports and deletes nothing. */
export async function sweepIntakeOrphans(
  businessId: number,
  opts: { dryRun?: boolean; graceMs?: number; now?: Date } = {},
  storage: StorageService = getStorageService(),
): Promise<SweepReport> {
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? new Date();
  const graceMs = opts.graceMs ?? SWEEP_GRACE_DEFAULT_MS;
  const report: SweepReport = { businessId, dryRun, scanned: 0, ignored: 0, kept: [], orphans: [], deleted: [], skipped: null };

  const deleting = await tenantTx(businessId, async (tx) => (await tx.$queryRaw<{ d: boolean }[]>`
    SELECT ("deletionRequestedAt" IS NOT NULL OR "deletedAt" IS NOT NULL) AS d FROM "Business" WHERE id = ${businessId}::int`)[0]?.d !== false);
  if (deleting) return { ...report, skipped: "BUSINESS_DELETING" };

  const listed = await storage.listObjects(`${serviceBusinessPrefix(businessId)}cases/`);
  for (const o of listed) {
    report.scanned++;
    const c = parseIntakeKey(o.key, businessId);
    if (!c) { report.ignored++; continue; }
    const age = oldEnough(o.lastModified, now, graceMs);
    if (age !== "OK") { report.kept.push({ key: o.key, reason: age }); continue; }
    // Under the case lock: no row names the key → an orphan; delete it while the lock is held.
    const verdict = await tenantTx(businessId, async (tx) => {
      const kase = (await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM "ServiceCase" WHERE id = ${c.caseId}::int AND "businessId" = ${businessId}::int FOR UPDATE`)[0];
      if (!kase) return "CASE_GONE" as const;
      const linked = (await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT (EXISTS (SELECT 1 FROM "ServiceIntakePhoto" WHERE "businessId" = ${businessId}::int AND "storageKey" = ${c.key})
             OR EXISTS (SELECT 1 FROM "ServiceCaseIntake" WHERE "businessId" = ${businessId}::int AND ("signatureKey" = ${c.key} OR "slipPdfKey" = ${c.key}))) AS ok`)[0]?.ok === true;
      if (linked) return "LINKED" as const;
      if (!dryRun) await storage.deleteObject(c.key);
      return "ORPHAN" as const;
    }, { timeoutMs: 15_000 });
    if (verdict === "ORPHAN") { report.orphans.push(c.key); if (!dryRun) report.deleted.push(c.key); }
    else report.kept.push({ key: c.key, reason: verdict });
  }
  return report;
}
