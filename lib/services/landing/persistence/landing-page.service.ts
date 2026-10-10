import { Prisma } from "@prisma/client";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import type { LandingBlueprint } from "../composer/blueprint-assembly";
import { composeLandingPreviewForBusiness } from "../composer/landing-blueprint.service";
import type { ComposerModel } from "../composer/landing-composer";
import { getLandingBusinessContext, type LandingBusinessContext } from "../landing-business-context";
import { RENDERER_VERSION, RendererError, type RenderModel } from "../renderer/render-model";
import {
  checkSnapshotIntegrity,
  computeCurrentReadiness,
  idempotencyKey,
  renderSavedVersion,
  snapshotFingerprint,
  snapshotReadiness,
  type CurrentReadiness,
  type LandingVersionAuthority,
  type LandingVersionStatus,
  type SavedVersionRow,
  type SnapshotIntegrity,
} from "./landing-version-model";

/**
 * P3-E · The owner's landing page: save, approve, roll back, retire — and read.
 *
 * AUTHORITY. Every write is an act of the authenticated owner: the business and the actor come from the
 * session (callers pass the session's businessId / userId; nothing else is accepted). The client supplies
 * at most a strategy id (save), a version id (approve / rollback / retire) and an idempotency key
 * (rollback). It never supplies a blueprint, a status, an authority, a pointer, a version number or an
 * approver: the blueprint is the canonical P3-C output recomputed (or reused) on the server, and the
 * database refuses everything else (column grants, policies, guard triggers, deferred pointer checks).
 * AI, jobs, the renderer and the strategy engine have no path here.
 *
 * ATOMICITY. Each act is ONE tenant transaction holding the page row lock (SELECT … FOR UPDATE): the
 * counter, the superseded row, the new / approved row, the pointers and the audit events commit
 * together, and two concurrent acts serialize — exactly one current approved pointer survives.
 *
 * SAFE LOGS. Codes, ids, version numbers and statuses only — never blueprint copy, refs, facts,
 * asset keys, composer context or model output.
 */

type Tx = Prisma.TransactionClient;

export type LandingPersistenceCode =
  | "VERSION_NOT_FOUND"
  | "NOT_CURRENT_DRAFT"
  | "ROLLBACK_SOURCE_NOT_APPROVED"
  | "ALREADY_CURRENT"
  | "SNAPSHOT_INVALID"
  | "COMPOSER_UNAVAILABLE"
  | "COMPOSITION_NOT_SAVEABLE"
  | "RENDER_REFUSED"
  | "CONFLICT";

const STATUS_BY_CODE: Record<LandingPersistenceCode, number> = {
  VERSION_NOT_FOUND: 404,
  NOT_CURRENT_DRAFT: 409,
  ROLLBACK_SOURCE_NOT_APPROVED: 409,
  ALREADY_CURRENT: 409,
  SNAPSHOT_INVALID: 422,
  COMPOSER_UNAVAILABLE: 503,
  COMPOSITION_NOT_SAVEABLE: 422,
  RENDER_REFUSED: 422,
  CONFLICT: 409,
};

export class LandingPersistenceError extends Error {
  readonly status: number;
  constructor(readonly code: LandingPersistenceCode, readonly detail: string[] = []) {
    super(`Landing persistence refused: ${code}`);
    this.name = "LandingPersistenceError";
    this.status = STATUS_BY_CODE[code];
  }
}

export type LandingVersionSummary = {
  id: number;
  versionNumber: number;
  status: LandingVersionStatus;
  authority: LandingVersionAuthority;
  strategyId: string;
  strategyType: string;
  createdAt: string;
  approvedAt: string | null;
  supersededAt: string | null;
  retiredAt: string | null;
  rollbackSourceVersionNumber: number | null;
  isCurrentDraft: boolean;
  isCurrentApproved: boolean;
};

const SUMMARY_SELECT = {
  id: true, versionNumber: true, status: true, authority: true, strategyId: true, strategyType: true,
  createdAt: true, approvedAt: true, supersededAt: true, retiredAt: true, rollbackSourceVersionId: true,
} as const;

type SummaryRow = Prisma.LandingPageVersionGetPayload<{ select: typeof SUMMARY_SELECT }>;
type PageRow = { id: number; currentDraftVersionId: number | null; currentApprovedVersionId: number | null; lastVersionNumber: number };

function toSummary(r: SummaryRow, page: Pick<PageRow, "currentDraftVersionId" | "currentApprovedVersionId"> | null, numbers: Map<number, number>): LandingVersionSummary {
  return {
    id: r.id,
    versionNumber: r.versionNumber,
    status: r.status,
    authority: r.authority,
    strategyId: r.strategyId,
    strategyType: r.strategyType,
    createdAt: r.createdAt.toISOString(),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    supersededAt: r.supersededAt?.toISOString() ?? null,
    retiredAt: r.retiredAt?.toISOString() ?? null,
    rollbackSourceVersionNumber: r.rollbackSourceVersionId ? numbers.get(r.rollbackSourceVersionId) ?? null : null,
    isCurrentDraft: page?.currentDraftVersionId === r.id,
    isCurrentApproved: page?.currentApprovedVersionId === r.id,
  };
}

const log = (event: string, fields: Record<string, string | number | boolean | null>) =>
  console.info(`[landing-persistence] ${event} ${Object.entries(fields).map(([k, v]) => `${k}=${v ?? "-"}`).join(" ")}`);

/* ───────────────────────────── page lock ───────────────────────────── */

async function lockPage(tx: Tx, businessId: number, create: { userId: number } | null): Promise<PageRow | null> {
  if (create) {
    await tx.$executeRaw`INSERT INTO "LandingPage" ("businessId", "createdByUserId", "updatedAt")
      VALUES (${businessId}, ${create.userId}, now()) ON CONFLICT ("businessId") DO NOTHING`;
  }
  const rows = await tx.$queryRaw<PageRow[]>`SELECT "id", "currentDraftVersionId", "currentApprovedVersionId", "lastVersionNumber"
    FROM "LandingPage" WHERE "businessId" = ${businessId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** The next version number (DB-safe: the counter moves under the page row lock; a unique index backs it). */
async function nextVersionNumber(tx: Tx, pageId: number): Promise<number> {
  const [r] = await tx.$queryRaw<Array<{ n: number }>>`UPDATE "LandingPage" SET "lastVersionNumber" = "lastVersionNumber" + 1, "updatedAt" = now()
    WHERE "id" = ${pageId} RETURNING "lastVersionNumber" AS n`;
  return r.n;
}

/** Pre-allocated id: the replaced row names its successor before the successor is inserted (deferred FK). */
async function nextVersionId(tx: Tx): Promise<number> {
  const [r] = await tx.$queryRaw<Array<{ id: number }>>`SELECT nextval(pg_get_serial_sequence('"LandingPageVersion"', 'id'))::int AS id`;
  return r.id;
}

async function supersede(tx: Tx, businessId: number, userId: number, versionId: number, byId: number, byNumber: number, now: Date) {
  const prev = await tx.landingPageVersion.update({
    where: { id: versionId, businessId },
    data: { status: "SUPERSEDED", supersededAt: now, supersededByVersionId: byId },
    select: { versionNumber: true, authority: true },
  });
  await recordSensor({
    businessId, sensor: "LANDING_VERSION_SUPERSEDED", entityId: versionId,
    actor: { type: "OWNER_USER", userId }, source: "OWNER_UI",
    payload: { versionNumber: prev.versionNumber, previousStatus: prev.authority === "OWNER_APPROVED" ? "APPROVED" : "DRAFT", supersededByVersionNumber: byNumber },
    idempotencyKey: `landing-version:${versionId}:superseded`,
  }, { tx });
}

/* ───────────────────────────── save ───────────────────────────── */

export type SaveLandingResult = { version: LandingVersionSummary; deduplicated: boolean };

/**
 * Save the canonical P3-C composition of one of the business's CURRENT strategies as a new DRAFT.
 * The blueprint is never accepted from the client: it is recomputed (or reused from the P3-C
 * single-flight / reuse window) server-side, must be COMPOSED + valid, and must render.
 */
export async function saveLandingVersion(
  input: { businessId: number; userId: number; strategyId: unknown },
  deps: { model: ComposerModel | null; now?: Date },
): Promise<SaveLandingResult> {
  const { result, renderError } = await composeLandingPreviewForBusiness(input.businessId, input.strategyId, deps);
  if (result.compositionStatus === "UNAVAILABLE") throw new LandingPersistenceError("COMPOSER_UNAVAILABLE");
  if (result.compositionStatus !== "COMPOSED" || !result.blueprintValid || !result.blueprint) {
    throw new LandingPersistenceError("COMPOSITION_NOT_SAVEABLE", [result.compositionStatus]);
  }
  if (renderError) throw new LandingPersistenceError("RENDER_REFUSED", [renderError]);
  const bp = result.blueprint;
  if (bp.businessId !== input.businessId) throw new LandingPersistenceError("COMPOSITION_NOT_SAVEABLE", ["BUSINESS_MISMATCH"]);
  return persistDraft(input.businessId, input.userId, bp, deps.now ?? new Date());
}

/** Exported for the database tests: persist an ALREADY-VALIDATED server blueprint. Never a route input. */
export async function persistDraft(businessId: number, userId: number, bp: LandingBlueprint, now: Date): Promise<SaveLandingResult> {
  const fingerprint = snapshotFingerprint(bp);
  return tenantTx(businessId, async (tx) => {
    const page = (await lockPage(tx, businessId, { userId }))!;
    // Deduplicate: the same composition is already the current draft (or the current approved version).
    for (const currentId of [page.currentDraftVersionId, page.currentApprovedVersionId]) {
      if (!currentId) continue;
      const cur = await tx.landingPageVersion.findFirst({ where: { id: currentId, businessId }, select: { ...SUMMARY_SELECT, sourceFingerprint: true } });
      if (cur && cur.sourceFingerprint === fingerprint && cur.strategyId === bp.strategyId) {
        log("SAVE_DEDUPLICATED", { business: businessId, version: cur.versionNumber, status: cur.status });
        return { version: toSummary(cur, page, new Map()), deduplicated: true };
      }
    }
    // Durable idempotency: one version per (business, strategy, blueprint, page state).
    const key = idempotencyKey({ businessId, operation: "SAVE_DRAFT", strategyId: bp.strategyId, fingerprint, scope: `draft:${page.currentDraftVersionId ?? 0}|approved:${page.currentApprovedVersionId ?? 0}` });
    const existing = await tx.landingPageVersion.findFirst({ where: { businessId, idempotencyKey: key }, select: SUMMARY_SELECT });
    if (existing) return { version: toSummary(existing, page, new Map()), deduplicated: true };

    const versionNumber = await nextVersionNumber(tx, page.id);
    const id = await nextVersionId(tx);
    if (page.currentDraftVersionId) await supersede(tx, businessId, userId, page.currentDraftVersionId, id, versionNumber, now);
    const created = await tx.landingPageVersion.create({
      data: {
        id, businessId, landingPageId: page.id, versionNumber, status: "DRAFT", authority: "OWNER_SAVED",
        strategyId: bp.strategyId, strategyType: bp.strategyType, strategyEngineVersion: bp.strategyEngineVersion,
        composerVersion: bp.composerVersion, promptVersion: bp.promptVersion, composerContextVersion: bp.composerContextVersion,
        blueprintVersion: bp.version, rendererVersion: RENDERER_VERSION,
        blueprintSnapshot: bp as unknown as Prisma.InputJsonValue, sourceFingerprint: fingerprint, idempotencyKey: key,
        supersedesVersionId: page.currentDraftVersionId, createdByUserId: userId,
      },
      select: SUMMARY_SELECT,
    });
    await tx.landingPage.update({ where: { id: page.id }, data: { currentDraftVersionId: id } });
    await recordSensor({
      businessId, sensor: "LANDING_VERSION_CREATED", entityId: id,
      actor: { type: "OWNER_USER", userId }, source: "OWNER_UI",
      payload: { versionNumber, strategyType: bp.strategyType, status: "DRAFT" },
      idempotencyKey: `landing-version:${id}:created`,
    }, { tx });
    log("SAVED", { business: businessId, version: versionNumber, strategyType: bp.strategyType });
    return { version: toSummary(created, { ...page, currentDraftVersionId: id }, new Map()), deduplicated: false };
  });
}

/* ───────────────────────────── approve ───────────────────────────── */

export type ApproveLandingResult = { version: LandingVersionSummary; alreadyApproved: boolean; currentReadiness: CurrentReadiness };

const ROW_SELECT = {
  ...SUMMARY_SELECT, businessId: true, blueprintVersion: true, rendererVersion: true, blueprintSnapshot: true, sourceFingerprint: true,
  strategyEngineVersion: true, composerVersion: true, promptVersion: true, composerContextVersion: true,
} as const;

function asSaved(r: Prisma.LandingPageVersionGetPayload<{ select: typeof ROW_SELECT }>): SavedVersionRow {
  return { ...r, blueprintSnapshot: r.blueprintSnapshot as unknown };
}

/**
 * Approve the CURRENT draft as the owner's chosen version. Approval ≠ publication, and it is allowed while
 * the page is not publish-ready: the missing items are returned for the owner to see. Approving the
 * version that is already the current approved one is a no-op.
 */
export async function approveLandingVersion(input: { businessId: number; userId: number; versionId: number }, now = new Date()): Promise<ApproveLandingResult> {
  const { businessId, userId, versionId } = input;
  // Current readiness is read first, outside the page lock (deterministic, no AI; informational only).
  const pre = await tenantTx(businessId, async (tx) => {
    const v = await tx.landingPageVersion.findFirst({ where: { id: versionId, businessId }, select: ROW_SELECT });
    if (!v) return null;
    const integrity = checkSnapshotIntegrity(asSaved(v));
    const readiness = integrity.ok ? computeCurrentReadiness(v.blueprintSnapshot as unknown as LandingBlueprint, await getLandingBusinessContext(businessId, tx, now), v.rendererVersion) : null;
    return { integrity, readiness };
  });
  if (!pre) throw new LandingPersistenceError("VERSION_NOT_FOUND");
  if (!pre.integrity.ok || !pre.readiness) throw new LandingPersistenceError("SNAPSHOT_INVALID", pre.integrity.problems);
  const readiness = pre.readiness;

  return tenantTx(businessId, async (tx) => {
    const page = await lockPage(tx, businessId, null);
    const v = page && (await tx.landingPageVersion.findFirst({ where: { id: versionId, businessId }, select: ROW_SELECT }));
    if (!page || !v) throw new LandingPersistenceError("VERSION_NOT_FOUND");
    if (v.status === "APPROVED" && page.currentApprovedVersionId === v.id) {
      return { version: toSummary(v, page, new Map()), alreadyApproved: true, currentReadiness: readiness };
    }
    if (v.status !== "DRAFT" || page.currentDraftVersionId !== v.id) throw new LandingPersistenceError("NOT_CURRENT_DRAFT");
    const integrity = checkSnapshotIntegrity(asSaved(v));
    if (!integrity.ok) throw new LandingPersistenceError("SNAPSHOT_INVALID", integrity.problems);

    if (page.currentApprovedVersionId) await supersede(tx, businessId, userId, page.currentApprovedVersionId, v.id, v.versionNumber, now);
    const approved = await tx.landingPageVersion.update({
      where: { id: v.id, businessId },
      data: { status: "APPROVED", authority: "OWNER_APPROVED", approvedAt: now, approvedByUserId: userId },
      select: SUMMARY_SELECT,
    });
    await tx.landingPage.update({ where: { id: page.id }, data: { currentDraftVersionId: null, currentApprovedVersionId: v.id } });
    await recordSensor({
      businessId, sensor: "LANDING_VERSION_APPROVED", entityId: v.id,
      actor: { type: "OWNER_USER", userId }, source: "OWNER_UI",
      payload: { versionNumber: v.versionNumber, strategyType: v.strategyType, publishReady: readiness.publishReady, blockerCount: readiness.blockers.length + readiness.fromSnapshot.length },
      idempotencyKey: `landing-version:${v.id}:approved`,
    }, { tx });
    log("APPROVED", { business: businessId, version: v.versionNumber, publishReady: readiness.publishReady });
    return { version: toSummary(approved, { currentDraftVersionId: null, currentApprovedVersionId: v.id }, new Map()), alreadyApproved: false, currentReadiness: readiness };
  });
}

/* ───────────────────────────── rollback ───────────────────────────── */

export type RollbackLandingResult = { version: LandingVersionSummary; deduplicated: boolean };

export const ROLLBACK_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Restore an earlier APPROVED version: a NEW version is created from the source snapshot (copied
 * verbatim, rollbackSourceVersionId set) and becomes APPROVED in the same transaction; the previously
 * approved version becomes SUPERSEDED. Nothing old is reactivated. The current draft is untouched.
 * `clientKey` (the owner action's Idempotency-Key) makes a double submit ONE version.
 */
export async function rollbackLandingVersion(input: { businessId: number; userId: number; sourceVersionId: number; clientKey: string }, now = new Date()): Promise<RollbackLandingResult> {
  const { businessId, userId, sourceVersionId, clientKey } = input;
  if (!ROLLBACK_KEY_PATTERN.test(clientKey)) throw new LandingPersistenceError("CONFLICT", ["IDEMPOTENCY_KEY_INVALID"]);
  return tenantTx(businessId, async (tx) => {
    const page = await lockPage(tx, businessId, null);
    const src = page && (await tx.landingPageVersion.findFirst({ where: { id: sourceVersionId, businessId }, select: ROW_SELECT }));
    if (!page || !src) throw new LandingPersistenceError("VERSION_NOT_FOUND");
    const key = idempotencyKey({ businessId, operation: "ROLLBACK", strategyId: src.strategyId, fingerprint: src.sourceFingerprint, scope: `source:${src.id}|client:${clientKey}` });
    const existing = await tx.landingPageVersion.findFirst({ where: { businessId, idempotencyKey: key }, select: SUMMARY_SELECT });
    if (existing) return { version: toSummary(existing, page, new Map([[src.id, src.versionNumber]])), deduplicated: true };
    if (src.authority !== "OWNER_APPROVED") throw new LandingPersistenceError("ROLLBACK_SOURCE_NOT_APPROVED");
    if (page.currentApprovedVersionId === src.id) throw new LandingPersistenceError("ALREADY_CURRENT");
    const integrity = checkSnapshotIntegrity(asSaved(src));
    if (!integrity.ok) throw new LandingPersistenceError("SNAPSHOT_INVALID", integrity.problems);

    const versionNumber = await nextVersionNumber(tx, page.id);
    const id = await nextVersionId(tx);
    if (page.currentApprovedVersionId) await supersede(tx, businessId, userId, page.currentApprovedVersionId, id, versionNumber, now);
    const created = await tx.landingPageVersion.create({
      data: {
        id, businessId, landingPageId: page.id, versionNumber, status: "APPROVED", authority: "OWNER_APPROVED",
        strategyId: src.strategyId, strategyType: src.strategyType, strategyEngineVersion: src.strategyEngineVersion,
        composerVersion: src.composerVersion, promptVersion: src.promptVersion, composerContextVersion: src.composerContextVersion,
        blueprintVersion: src.blueprintVersion, rendererVersion: src.rendererVersion,
        blueprintSnapshot: src.blueprintSnapshot as Prisma.InputJsonValue, sourceFingerprint: src.sourceFingerprint, idempotencyKey: key,
        supersedesVersionId: page.currentApprovedVersionId, rollbackSourceVersionId: src.id,
        // Created and approved in one act: both times are the same instant.
        createdByUserId: userId, createdAt: now, approvedAt: now, approvedByUserId: userId,
      },
      select: SUMMARY_SELECT,
    });
    await tx.landingPage.update({ where: { id: page.id }, data: { currentApprovedVersionId: id } });
    await recordSensor({
      businessId, sensor: "LANDING_ROLLBACK_CREATED", entityId: id,
      actor: { type: "OWNER_USER", userId }, source: "OWNER_UI",
      payload: { versionNumber, sourceVersionNumber: src.versionNumber, strategyType: src.strategyType },
      idempotencyKey: `landing-version:${id}:rollback-created`,
    }, { tx });
    log("ROLLBACK_CREATED", { business: businessId, version: versionNumber, source: src.versionNumber });
    return { version: toSummary(created, { currentDraftVersionId: page.currentDraftVersionId, currentApprovedVersionId: id }, new Map([[src.id, src.versionNumber]])), deduplicated: false };
  });
}

/* ───────────────────────────── retire ───────────────────────────── */

/** Discard the CURRENT draft (DRAFT → RETIRED). Never a deletion: the row stays as history. */
export async function retireLandingDraft(input: { businessId: number; userId: number; versionId: number }, now = new Date()): Promise<{ version: LandingVersionSummary }> {
  const { businessId, userId, versionId } = input;
  return tenantTx(businessId, async (tx) => {
    const page = await lockPage(tx, businessId, null);
    const v = page && (await tx.landingPageVersion.findFirst({ where: { id: versionId, businessId }, select: SUMMARY_SELECT }));
    if (!page || !v) throw new LandingPersistenceError("VERSION_NOT_FOUND");
    if (v.status !== "DRAFT" || page.currentDraftVersionId !== v.id) throw new LandingPersistenceError("NOT_CURRENT_DRAFT");
    const retired = await tx.landingPageVersion.update({ where: { id: v.id, businessId }, data: { status: "RETIRED", retiredAt: now, retiredByUserId: userId }, select: SUMMARY_SELECT });
    await tx.landingPage.update({ where: { id: page.id }, data: { currentDraftVersionId: null } });
    await recordSensor({
      businessId, sensor: "LANDING_VERSION_RETIRED", entityId: v.id,
      actor: { type: "OWNER_USER", userId }, source: "OWNER_UI",
      payload: { versionNumber: v.versionNumber },
      idempotencyKey: `landing-version:${v.id}:retired`,
    }, { tx });
    log("RETIRED", { business: businessId, version: v.versionNumber });
    return { version: toSummary(retired, { currentDraftVersionId: null, currentApprovedVersionId: page.currentApprovedVersionId }, new Map()) };
  });
}

/* ───────────────────────────── reads (no composer, no model) ───────────────────────────── */

export type LandingOverview = {
  hasPage: boolean;
  currentApproved: (LandingVersionSummary & { currentReadiness: CurrentReadiness | null }) | null;
  currentDraft: (LandingVersionSummary & { currentReadiness: CurrentReadiness | null }) | null;
  versions: LandingVersionSummary[];
};

function readinessOf(row: Prisma.LandingPageVersionGetPayload<{ select: typeof ROW_SELECT }>, landing: LandingBusinessContext): CurrentReadiness | null {
  return checkSnapshotIntegrity(asSaved(row)).ok ? computeCurrentReadiness(row.blueprintSnapshot as unknown as LandingBlueprint, landing, row.rendererVersion) : null;
}

/** The page, its current approved / draft versions (with today's readiness) and the full history. */
export async function getLandingOverview(businessId: number, now = new Date()): Promise<LandingOverview> {
  return tenantTx(businessId, async (tx) => {
    const page = await tx.landingPage.findFirst({ where: { businessId }, select: { currentDraftVersionId: true, currentApprovedVersionId: true } });
    if (!page) return { hasPage: false, currentApproved: null, currentDraft: null, versions: [] };
    const rows = await tx.landingPageVersion.findMany({ where: { businessId }, orderBy: { versionNumber: "desc" }, select: SUMMARY_SELECT });
    const numbers = new Map(rows.map((r) => [r.id, r.versionNumber]));
    const versions = rows.map((r) => toSummary(r, page, numbers));
    const currentIds = [page.currentApprovedVersionId, page.currentDraftVersionId].filter((x): x is number => !!x);
    const full = currentIds.length ? await tx.landingPageVersion.findMany({ where: { businessId, id: { in: currentIds } }, select: ROW_SELECT }) : [];
    const landing = full.length ? await getLandingBusinessContext(businessId, tx, now) : null;
    const withReadiness = (id: number | null) => {
      const summary = versions.find((v) => v.id === id);
      const row = full.find((r) => r.id === id);
      return summary && row && landing ? { ...summary, currentReadiness: readinessOf(row, landing) } : null;
    };
    return { hasPage: true, currentApproved: withReadiness(page.currentApprovedVersionId), currentDraft: withReadiness(page.currentDraftVersionId), versions };
  });
}

export type LandingVersionDetail = {
  version: LandingVersionSummary;
  integrity: SnapshotIntegrity;
  snapshotReadiness: { publishReady: boolean; missingForPublication: string[]; warnings: string[] } | null;
  currentReadiness: CurrentReadiness | null;
  renderModel: RenderModel | null;
  renderError: string | null;
};

/**
 * One saved version for the owner preview: integrity, the readiness recorded in the snapshot, today's
 * readiness, and the deterministic render model (today's approved facts / assets; no model call). An
 * unsupported or damaged snapshot fails closed: no render model, the integrity problems instead.
 */
export async function getLandingVersionDetail(businessId: number, versionId: number, now = new Date()): Promise<LandingVersionDetail> {
  return tenantTx(businessId, async (tx) => {
    const page = await tx.landingPage.findFirst({ where: { businessId }, select: { currentDraftVersionId: true, currentApprovedVersionId: true } });
    const row = await tx.landingPageVersion.findFirst({ where: { id: versionId, businessId }, select: ROW_SELECT });
    if (!row) throw new LandingPersistenceError("VERSION_NOT_FOUND");
    const source = row.rollbackSourceVersionId
      ? await tx.landingPageVersion.findFirst({ where: { id: row.rollbackSourceVersionId, businessId }, select: { id: true, versionNumber: true } })
      : null;
    const version = toSummary(row, page, new Map(source ? [[source.id, source.versionNumber]] : []));
    const integrity = checkSnapshotIntegrity(asSaved(row));
    if (!integrity.ok) {
      console.warn(`[landing-persistence] SNAPSHOT_REFUSED business=${businessId} version=${row.versionNumber} problems=${integrity.problems.join(",")}`);
      return { version, integrity, snapshotReadiness: null, currentReadiness: null, renderModel: null, renderError: "SNAPSHOT_INVALID" };
    }
    const bp = row.blueprintSnapshot as unknown as LandingBlueprint;
    const landing = await getLandingBusinessContext(businessId, tx, now);
    const currentReadiness = computeCurrentReadiness(bp, landing, row.rendererVersion);
    try {
      return { version, integrity, snapshotReadiness: snapshotReadiness(bp), currentReadiness, renderModel: renderSavedVersion(bp, landing), renderError: null };
    } catch (error) {
      if (error instanceof RendererError) {
        console.warn(`[landing-persistence] RENDER_REFUSED business=${businessId} version=${row.versionNumber} code=${error.code}`);
        return { version, integrity, snapshotReadiness: snapshotReadiness(bp), currentReadiness, renderModel: null, renderError: error.code };
      }
      throw error;
    }
  });
}
