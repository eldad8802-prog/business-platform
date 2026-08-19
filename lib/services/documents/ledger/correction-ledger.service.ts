/**
 * Document Memory & Learning — Phase 1A: Correction Ledger Foundation.
 *
 * WRITE-ONLY, APPEND-ONLY sink of historical correction facts. This module is
 * NOT a learning system: it computes no priors, performs no re-ranking, builds
 * no candidate landscape, runs no shadow representation, and is never read back
 * into any extraction decision. It only records what already happened.
 *
 * Hard guarantees (do NOT break):
 *   • Every recorder swallows all errors — a ledger failure can NEVER fail an
 *     upload or an approve. Callers `await` these but they never throw.
 *   • Append-only: only `create` is used; rows are never updated or deleted.
 *   • Raw scope is stored verbatim — NO entity resolution, NO vendor
 *     normalization, NO guessing. null / unknown are truthful values.
 *   • OCR text is never duplicated — only a hash is stored.
 */

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { UnifiedDocumentIntelligenceResult } from "../unified-extraction-engine.service";
import type { OcrGeometryResult } from "../google-vision-ocr.service";
import { buildRepresentationFromOcr } from "../representation/document-representation";
import { groupTokensGeometrically } from "../representation/document-grouping";
import { deriveMoneyAmounts } from "../representation/document-money-amount";
import { findAmountRelationsFromMoneyAmounts } from "../representation/document-amount-relations";
import { deriveAmountRoles } from "../representation/document-amount-roles";
import { readAmount } from "../representation/document-amount-readout";

/** Provenance — bump on any change to the live extraction decision logic. */
export const LIVE_ENGINE_VERSION = "unified-extraction-engine@1.0.0";
export const OCR_ENGINE = "google-vision";
export const OCR_VERSION = "textDetection-v1";
/** Provenance — bump on any change to the structural (slice) reasoning. */
export const SLICE_ENGINE_VERSION = "amount-slice@1.0.0";

type JsonSafe = unknown;

/** Date → ISO, strips undefined, never throws. */
function jsonSafe(value: unknown): JsonSafe {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function hashOcrText(ocrText: string | null | undefined): string | null {
  if (!ocrText) return null;
  try {
    return "sha256:" + createHash("sha256").update(ocrText).digest("hex");
  } catch {
    return null;
  }
}

/** Content hash of the deterministic geometry input — the replay key. */
function hashGeometry(geometry: OcrGeometryResult | null): string | null {
  if (!geometry) return null;
  try {
    const payload = JSON.stringify({
      text: geometry.text,
      tokens: geometry.tokens,
    });
    return "sha256:" + createHash("sha256").update(payload).digest("hex");
  } catch {
    return null;
  }
}

/** Truthful string encoding for a ledger value. null/empty stay null. */
function asLedgerString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Coarse provenance for a legacy-engine field decision. */
function legacyProvenance(reason?: string | null): Prisma.InputJsonValue {
  return reason ? { source: "legacy-unified", reason } : { source: "legacy-unified" };
}

/**
 * Amount Slice — SHADOW ONLY. Runs the structural representation pipeline on the
 * geometric OCR result for evidence. It NEVER publishes a value and is NEVER read
 * back into any extraction decision. Swallows all errors.
 */
type AmountSliceTrace = {
  value: number | null;
  resolutionState: string;
  basis: string | null;
  provenance: unknown;
  strength: unknown;
  readout: unknown;
};

function runAmountSliceShadow(
  geometry: OcrGeometryResult
): { trace: AmountSliceTrace; reasoningBlob: unknown } | null {
  try {
    const rep = buildRepresentationFromOcr(geometry);
    const grouping = groupTokensGeometrically(rep);
    const moneyAmounts = deriveMoneyAmounts(rep);
    const relation = findAmountRelationsFromMoneyAmounts(moneyAmounts, grouping);
    const roles = deriveAmountRoles(relation, grouping);
    const readout = readAmount(roles, moneyAmounts);

    return {
      trace: {
        value: readout.value,
        resolutionState: readout.resolutionState,
        basis: readout.basis,
        provenance: readout.provenance,
        strength: readout.strength,
        readout,
      },
      reasoningBlob: { moneyAmounts, grouping, relation, roles, readout },
    };
  } catch (err) {
    console.error("[correction-ledger] amount slice (shadow) failed:", err);
    return null;
  }
}

/**
 * Build the six per-field decision rows (general contract), each tagged with the
 * boundary discriminator. `amount` is produced by the structural slice when
 * geometry yielded a trace (Shadow only); all other fields are recorded verbatim
 * from the legacy engine. fieldKeys are stage-suffixed so the key agrees with the
 * stage. `category.classified` is ALWAYS written — even when the value is the
 * "general" fallback — because that is itself a key metric for future category
 * work.
 *
 * Boundary note: `direction.interpreted` and `category.classified` are business
 * interpretation. Even though the legacy engine still produces them inside the
 * Documents code path, the ledger tags them `layer: "business"` (the target
 * architecture) with `producedBy: "legacy"` (the actual, pre-boundary producer).
 */
function buildSliceDecisionRows(input: {
  snapshotId: number;
  documentId: number;
  businessId: number;
  extracted: UnifiedDocumentIntelligenceResult;
  amountSlice: AmountSliceTrace | null;
}): Prisma.SliceDecisionCreateManyInput[] {
  const { snapshotId, documentId, businessId, extracted: e, amountSlice } = input;
  const base = {
    extractionSnapshotId: snapshotId,
    documentId,
    businessId,
  };

  const legacyRow = (
    fieldKey: string,
    layer: string,
    stage: string,
    engineValue: unknown,
    confidenceLabel: unknown,
    reason?: string | null
  ): Prisma.SliceDecisionCreateManyInput => ({
    ...base,
    fieldKey,
    layer,
    stage,
    engineValue: asLedgerString(engineValue),
    legacyValue: asLedgerString(engineValue),
    confidenceLabel: asLedgerString(confidenceLabel),
    provenance: legacyProvenance(reason),
    producedBy: "legacy",
  });

  const amountRow: Prisma.SliceDecisionCreateManyInput = amountSlice
    ? {
        ...base,
        fieldKey: "amount.extracted",
        layer: "documents",
        stage: "extraction",
        engineValue: asLedgerString(amountSlice.value),
        legacyValue: asLedgerString(e.amount),
        resolutionState: amountSlice.resolutionState,
        basis: amountSlice.basis,
        confidenceLabel: asLedgerString(e.amountConfidence),
        provenance: jsonSafe(amountSlice.provenance) as Prisma.InputJsonValue,
        strength: jsonSafe(amountSlice.strength) as Prisma.InputJsonValue,
        reasoningBlob: jsonSafe(amountSlice.readout) as Prisma.InputJsonValue,
        producedBy: "slice",
        sliceEngineVersion: SLICE_ENGINE_VERSION,
      }
    : legacyRow(
        "amount.extracted",
        "documents",
        "extraction",
        e.amount,
        e.amountConfidence
      );

  return [
    // Documents layer — facts extracted from the page.
    amountRow,
    legacyRow("vendor.extracted", "documents", "extraction", e.vendorName, e.vendorConfidence),
    legacyRow("date.extracted", "documents", "extraction", e.date, e.dateConfidence),
    legacyRow("documentType.extracted", "documents", "extraction", e.documentType, e.documentTypeConfidence),
    // Business layer — interpretation (still produced by the legacy monolith today).
    legacyRow("direction.interpreted", "business", "interpretation", e.direction, null),
    legacyRow("category.classified", "business", "classification", e.category, e.categoryConfidence),
  ];
}

/**
 * Engine belief captured at extraction, before the value subset is persisted.
 * Writes the document snapshot, six per-field SliceDecisions, and (when geometry
 * is supplied) the shared deterministic evidence. Strictly additive, append-only,
 * Shadow — it never publishes a value and never feeds back into any decision.
 * `geometry` is optional: channels without it (e.g. email/whatsapp) record
 * legacy-only field decisions and no evidence.
 */
/** Truthful record of how the extraction step resolved (Gap 1). */
export type ExtractionOutcome = "ok" | "empty_ocr" | "extraction_failed";

export async function recordExtractionSnapshot(input: {
  documentId: number;
  businessId: number;
  sourceChannel: string;
  ocrText: string | null;
  /**
   * The engine belief. `null` when there was NO usable extraction (empty OCR or
   * an extraction failure) — such documents are still recorded so the learning
   * ledger sees failures too, removing survivorship bias (Gap 1).
   */
  extracted: UnifiedDocumentIntelligenceResult | null;
  geometry?: OcrGeometryResult | null;
  /** How extraction resolved. Defaults to "ok" when `extracted` is present. */
  extractionOutcome?: ExtractionOutcome;
}): Promise<void> {
  try {
    const e = input.extracted;
    const extractionOutcome: ExtractionOutcome =
      input.extractionOutcome ?? (e ? "ok" : "extraction_failed");
    const geometry = input.geometry ?? null;
    const geometryAvailable = geometry?.geometryAvailable ?? false;
    const ocrGeometryHash = hashGeometry(geometry);

    // Amount Slice — Shadow only, when geometry is available.
    const sliceRun =
      geometry && geometryAvailable ? runAmountSliceShadow(geometry) : null;
    const amountSlice = sliceRun?.trace ?? null;

    const snapshot = await prisma.extractionSnapshot.create({
      data: {
        documentId: input.documentId,
        businessId: input.businessId,
        sourceChannel: input.sourceChannel,

        liveEngineVersion: LIVE_ENGINE_VERSION,
        ocrEngine: OCR_ENGINE,
        ocrVersion: OCR_VERSION,
        ocrTextHash: hashOcrText(input.ocrText),

        // Gap 1 — truthful extraction outcome (records failures too).
        extractionOutcome,

        // Memory Scope (raw — verbatim; null when there was no extraction)
        vendorName: e?.vendorName ?? null,
        documentType: e?.documentType ? String(e.documentType) : null,
        direction: e?.direction ? String(e.direction) : null,

        // Engine belief
        amount: e?.amount ?? null,
        date: e?.date ?? null,
        category: e?.category ?? null,
        confidenceScore: e?.confidence ?? null,
        amountConfidence: e?.amountConfidence ? String(e.amountConfidence) : null,
        vendorConfidence: e?.vendorConfidence ? String(e.vendorConfidence) : null,
        dateConfidence: e?.dateConfidence ? String(e.dateConfidence) : null,
        categoryConfidence: e?.categoryConfidence ? String(e.categoryConfidence) : null,
        // Gap 3 — engine confidence in the routing (documentType) decision.
        documentTypeConfidence: e?.documentTypeConfidence
          ? String(e.documentTypeConfidence)
          : null,
        isFinancial: e?.isFinancial ?? null,
        amountEligible: e?.amountEligible ?? null,
        financialEvidenceLevel: e?.financialEvidenceLevel
          ? String(e.financialEvidenceLevel)
          : null,
        guardrailRoute: e?.guardrailRoute ? String(e.guardrailRoute) : null,

        // General Decision Ledger — structural (slice) provenance.
        sliceEngineVersion: SLICE_ENGINE_VERSION,
        ocrGeometryHash,
        geometryAvailable: geometry ? geometryAvailable : null,

        // rawResult is NON-nullable; for no-extraction rows record the outcome
        // itself so the column always holds valid JSON.
        rawResult: (e ? jsonSafe(e) : { extractionOutcome }) as object,
      },
    });

    // Six per-field decisions (general contract) — only when there was an
    // extraction. A no-extraction snapshot has no field beliefs to decompose.
    // Isolated so a failure here never blocks the snapshot/evidence.
    if (e) {
      try {
        await prisma.sliceDecision.createMany({
          data: buildSliceDecisionRows({
            snapshotId: snapshot.id,
            documentId: input.documentId,
            businessId: input.businessId,
            extracted: e,
            amountSlice,
          }),
        });
      } catch (err) {
        console.error("[correction-ledger] sliceDecision.createMany failed:", err);
      }
    }

    // Heavy shared evidence (Tier 2 geometry + Tier 3 frozen reasoning blob).
    if (geometry) {
      try {
        await prisma.extractionEvidence.create({
          data: {
            extractionSnapshotId: snapshot.id,
            ocrGeometry: jsonSafe(geometry) as Prisma.InputJsonValue,
            reasoningBlob: sliceRun
              ? (jsonSafe(sliceRun.reasoningBlob) as Prisma.InputJsonValue)
              : undefined,
            geometryHash: ocrGeometryHash,
            sliceEngineVersion: SLICE_ENGINE_VERSION,
          },
        });
      } catch (err) {
        console.error("[correction-ledger] extractionEvidence.create failed:", err);
      }
    }
  } catch (err) {
    // Never allow a ledger failure to affect the extraction/upload flow.
    console.error("[correction-ledger] recordExtractionSnapshot failed:", err);
  }
}

type BeliefShape = {
  amount: number | null;
  vendorName: string | null;
  date: Date | null;
  category: string | null;
  direction: string | null;
  // Gap 3 — verdict pipe for the routing decision. Belief is optional today;
  // a human documentType verdict awaits a small UI affordance (until then the
  // verdict resolves to "not-submitted"). The engine's documentType belief is
  // always available on ExtractionSnapshot.documentType (joinable by documentId).
  documentType?: string | null;
} | null;

type FinalShape = {
  amount?: number | null;
  vendorName?: string | null;
  date?: string | null;
  category?: string | null;
  direction?: string | null;
  documentType?: string | null;
};

type FieldVerdict =
  | "confirmed"
  | "corrected"
  | "rejected"
  | "not-submitted";

const VERDICT_FIELDS = [
  "amount",
  "vendorName",
  "date",
  "category",
  "direction",
  "documentType",
] as const;

function serialize(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function sameValue(field: string, belief: unknown, final: unknown): boolean {
  if (belief == null && final == null) return true;
  if (belief == null || final == null) return false;
  if (field === "amount") return Number(belief) === Number(final);
  if (field === "date") {
    const b = belief instanceof Date ? belief.getTime() : Date.parse(String(belief));
    const f = Date.parse(String(final));
    if (Number.isNaN(b) || Number.isNaN(f)) return String(belief) === String(final);
    return new Date(b).toISOString().slice(0, 10) === new Date(f).toISOString().slice(0, 10);
  }
  return String(belief).trim() === String(final).trim();
}

function buildVerdicts(
  belief: BeliefShape,
  final: FinalShape,
  approvedAs: "financial" | "document"
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of VERDICT_FIELDS) {
    const b = belief ? (belief[f] ?? null) : null;
    const submitted = Object.prototype.hasOwnProperty.call(final, f) && final[f] !== undefined;
    const fin = submitted ? (final[f] ?? null) : null;

    let verdict: FieldVerdict;
    let delta: { old: unknown; new: unknown } | undefined;

    if (approvedAs === "document" && (f === "amount" || f === "direction")) {
      // Financial interpretation rejected (document-only approval).
      verdict = "rejected";
    } else if (!submitted) {
      verdict = "not-submitted";
    } else if (sameValue(f, b, fin)) {
      verdict = "confirmed";
    } else {
      verdict = "corrected";
      delta = { old: serialize(b), new: serialize(fin) };
    }

    out[f] = {
      belief: serialize(b),
      final: serialize(fin),
      verdict,
      ...(delta ? { delta } : {}),
    };
  }
  return out;
}

/**
 * Human verdict captured at approve, before ExtractedData is overwritten.
 *
 * Non-fatal (never throws): a ledger failure must never affect the approve flow. It now RETURNS whether
 * the canonical ReviewEvent was actually persisted (`true`) or the write was caught/failed (`false`) —
 * a pure acknowledgement so a downstream best-effort consumer (Business Memory shadow) can run ONLY when
 * the owner-decision evidence was durably committed. The non-fatal behaviour is unchanged; callers that
 * ignore the return value behave exactly as before.
 */
export async function recordReviewEvent(input: {
  documentId: number;
  businessId: number;
  reviewerUserId: number;
  approvedAs: "financial" | "document";
  explicitFinancial: boolean;
  profileId: string | null;
  belief: BeliefShape;
  final: FinalShape;
}): Promise<boolean> {
  try {
    const verdicts = buildVerdicts(input.belief, input.final, input.approvedAs);
    await prisma.reviewEvent.create({
      data: {
        documentId: input.documentId,
        businessId: input.businessId,
        reviewerUserId: input.reviewerUserId,

        approvedAs: input.approvedAs,
        explicitFinancial: input.explicitFinancial,
        profileId: input.profileId,

        // Memory Scope (raw — belief vs human-confirmed)
        vendorBelief: input.belief?.vendorName ?? null,
        vendorFinal: input.final.vendorName ?? null,
        directionBelief: input.belief?.direction ?? null,
        directionFinal: input.final.direction ?? null,

        verdicts: jsonSafe(verdicts) as object,
        rawBelief: jsonSafe(input.belief) as object,
        rawFinal: jsonSafe(input.final) as object,
      },
    });
    return true;
  } catch (err) {
    // Never allow a ledger failure to affect the approve flow.
    console.error("[correction-ledger] recordReviewEvent failed:", err);
    return false;
  }
}
