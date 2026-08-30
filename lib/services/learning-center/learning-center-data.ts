/**
 * Learning Center v1 — data access (READ-ONLY).
 *
 * Reads existing Ledger + FinancialRecord rows via Prisma and feeds the pure
 * aggregation layer. Uses only `findMany`/`findFirst`/`$queryRaw` SELECTs — no
 * writes, no schema/migration changes, no engine interaction.
 */

// D2/P7-W4D: learning-center is a cross-tenant platform-admin analytics
// surface. Under FORCE RLS its unscoped reads would silently return zero on
// the tenant client, so ALL reads run on the sanctioned admin client
// (read-only via p7adm_read policies; the admin role has no write grants).
import { getPrismaAdmin } from "@/lib/prisma-admin";

// Lazy per-call accessor: getPrismaAdmin throws loudly when
// ADMIN_DATABASE_URL is missing — that must happen at request time, never
// at import/build time.
function adminDb() {
  return getPrismaAdmin();
}
import {
  buildDecisionEvolution,
  buildOverview,
} from "./learning-center-metrics";
import type {
  DecisionEvolution,
  EvidenceRow,
  FinancialRecordRow,
  LearningCenterOverview,
  ReviewEventRow,
  SliceDecisionRow,
  SnapshotRow,
  TimeWindow,
  TimeWindowKey,
} from "./learning-center.types";

const DAY_MS = 86_400_000;

export function resolveWindow(
  key: TimeWindowKey,
  fromIso?: string | null,
  toIso?: string | null
): TimeWindow {
  const now = Date.now();
  if (key === "24h") return { key, fromIso: new Date(now - DAY_MS).toISOString(), toIso: null };
  if (key === "7d") return { key, fromIso: new Date(now - 7 * DAY_MS).toISOString(), toIso: null };
  if (key === "30d") return { key, fromIso: new Date(now - 30 * DAY_MS).toISOString(), toIso: null };
  if (key === "custom") return { key, fromIso: fromIso ?? null, toIso: toIso ?? null };
  return { key: "all", fromIso: null, toIso: null };
}

export async function getLearningCenterOverview(
  window: TimeWindow
): Promise<LearningCenterOverview> {
  const [snapshotsRaw, decisionsRaw, reviewsRaw, evidenceRaw] = await Promise.all([
    adminDb().extractionSnapshot.findMany({
      select: {
        id: true,
        documentId: true,
        geometryAvailable: true,
        occurredAt: true,
        liveEngineVersion: true,
      },
    }),
    adminDb().sliceDecision.findMany({
      select: {
        fieldKey: true,
        layer: true,
        stage: true,
        producedBy: true,
        engineValue: true,
        legacyValue: true,
        resolutionState: true,
        basis: true,
        confidenceLabel: true,
        documentId: true,
        extractionSnapshotId: true,
        occurredAt: true,
        sliceEngineVersion: true,
      },
    }),
    adminDb().reviewEvent.findMany({
      select: { documentId: true, occurredAt: true, verdicts: true },
    }),
    adminDb().$queryRaw<
      Array<{ extractionSnapshotId: number; hasGeometry: boolean; hasReasoning: boolean }>
    >`
      SELECT "extractionSnapshotId",
             ("ocrGeometry" IS NOT NULL) AS "hasGeometry",
             ("reasoningBlob" IS NOT NULL) AS "hasReasoning"
      FROM "ExtractionEvidence"
    `,
  ]);

  const liveVersionBySnapshot = new Map<number, string | null>(
    snapshotsRaw.map((s) => [s.id, s.liveEngineVersion])
  );

  const snapshots: SnapshotRow[] = snapshotsRaw.map((s) => ({
    id: s.id,
    documentId: s.documentId,
    geometryAvailable: s.geometryAvailable,
    occurredAt: s.occurredAt.toISOString(),
  }));

  const decisions: SliceDecisionRow[] = decisionsRaw.map((d) => ({
    fieldKey: d.fieldKey,
    layer: d.layer,
    stage: d.stage,
    producedBy: d.producedBy,
    engineValue: d.engineValue,
    legacyValue: d.legacyValue,
    resolutionState: d.resolutionState,
    basis: d.basis,
    confidenceLabel: d.confidenceLabel,
    documentId: d.documentId,
    extractionSnapshotId: d.extractionSnapshotId,
    occurredAt: d.occurredAt.toISOString(),
    sliceEngineVersion: d.sliceEngineVersion,
    liveEngineVersion: liveVersionBySnapshot.get(d.extractionSnapshotId) ?? null,
  }));

  const reviewEvents: ReviewEventRow[] = reviewsRaw.map((r) => ({
    documentId: r.documentId,
    occurredAt: r.occurredAt.toISOString(),
    verdicts: r.verdicts,
  }));

  const evidence: EvidenceRow[] = evidenceRaw.map((e) => ({
    extractionSnapshotId: e.extractionSnapshotId,
    hasGeometry: Boolean(e.hasGeometry),
    hasReasoning: Boolean(e.hasReasoning),
  }));

  return buildOverview({ snapshots, decisions, reviewEvents, evidence }, window);
}

export async function getDecisionEvolution(
  documentId: number
): Promise<DecisionEvolution> {
  const [snapshotRaw, decisionsRaw, reviewRaw, financialRaw] = await Promise.all([
    adminDb().extractionSnapshot.findFirst({
      where: { documentId },
      orderBy: { id: "desc" },
      select: { id: true, documentId: true, geometryAvailable: true, occurredAt: true },
    }),
    adminDb().sliceDecision.findMany({
      where: { documentId },
      select: {
        fieldKey: true,
        layer: true,
        stage: true,
        producedBy: true,
        engineValue: true,
        legacyValue: true,
        resolutionState: true,
        basis: true,
        confidenceLabel: true,
        documentId: true,
        extractionSnapshotId: true,
        occurredAt: true,
        sliceEngineVersion: true,
      },
    }),
    adminDb().reviewEvent.findFirst({
      where: { documentId },
      orderBy: { occurredAt: "desc" },
      select: { documentId: true, occurredAt: true, verdicts: true },
    }),
    adminDb().financialRecord.findFirst({
      where: { documentId },
      select: { documentId: true, amount: true, vendorName: true, category: true, direction: true },
    }),
  ]);

  const snapshot: SnapshotRow | null = snapshotRaw
    ? {
        id: snapshotRaw.id,
        documentId: snapshotRaw.documentId,
        geometryAvailable: snapshotRaw.geometryAvailable,
        occurredAt: snapshotRaw.occurredAt.toISOString(),
      }
    : null;

  const decisions: SliceDecisionRow[] = decisionsRaw.map((d) => ({
    fieldKey: d.fieldKey,
    layer: d.layer,
    stage: d.stage,
    producedBy: d.producedBy,
    engineValue: d.engineValue,
    legacyValue: d.legacyValue,
    resolutionState: d.resolutionState,
    basis: d.basis,
    confidenceLabel: d.confidenceLabel,
    documentId: d.documentId,
    extractionSnapshotId: d.extractionSnapshotId,
    occurredAt: d.occurredAt.toISOString(),
    sliceEngineVersion: d.sliceEngineVersion,
    liveEngineVersion: null,
  }));

  const review: ReviewEventRow | null = reviewRaw
    ? {
        documentId: reviewRaw.documentId,
        occurredAt: reviewRaw.occurredAt.toISOString(),
        verdicts: reviewRaw.verdicts,
      }
    : null;

  const financialRecord: FinancialRecordRow | null = financialRaw
    ? {
        documentId: financialRaw.documentId,
        amount: financialRaw.amount,
        vendorName: financialRaw.vendorName,
        category: financialRaw.category,
        direction: financialRaw.direction,
      }
    : null;

  return buildDecisionEvolution({ documentId, snapshot, decisions, review, financialRecord });
}
