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
import { prisma } from "@/lib/prisma";
import type { UnifiedDocumentIntelligenceResult } from "../unified-extraction-engine.service";

/** Provenance — bump on any change to the live extraction decision logic. */
export const LIVE_ENGINE_VERSION = "unified-extraction-engine@1.0.0";
export const OCR_ENGINE = "google-vision";
export const OCR_VERSION = "textDetection-v1";

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

/** Engine belief captured at extraction, before the value subset is persisted. */
export async function recordExtractionSnapshot(input: {
  documentId: number;
  businessId: number;
  sourceChannel: string;
  ocrText: string | null;
  extracted: UnifiedDocumentIntelligenceResult;
}): Promise<void> {
  try {
    const e = input.extracted;
    await prisma.extractionSnapshot.create({
      data: {
        documentId: input.documentId,
        businessId: input.businessId,
        sourceChannel: input.sourceChannel,

        liveEngineVersion: LIVE_ENGINE_VERSION,
        ocrEngine: OCR_ENGINE,
        ocrVersion: OCR_VERSION,
        ocrTextHash: hashOcrText(input.ocrText),

        // Memory Scope (raw — verbatim)
        vendorName: e.vendorName ?? null,
        documentType: e.documentType ? String(e.documentType) : null,
        direction: e.direction ? String(e.direction) : null,

        // Engine belief
        amount: e.amount ?? null,
        date: e.date ?? null,
        category: e.category ?? null,
        confidenceScore: e.confidence ?? null,
        amountConfidence: e.amountConfidence ? String(e.amountConfidence) : null,
        vendorConfidence: e.vendorConfidence ? String(e.vendorConfidence) : null,
        dateConfidence: e.dateConfidence ? String(e.dateConfidence) : null,
        categoryConfidence: e.categoryConfidence ? String(e.categoryConfidence) : null,
        isFinancial: e.isFinancial ?? null,
        amountEligible: e.amountEligible ?? null,
        financialEvidenceLevel: e.financialEvidenceLevel
          ? String(e.financialEvidenceLevel)
          : null,
        guardrailRoute: e.guardrailRoute ? String(e.guardrailRoute) : null,

        rawResult: jsonSafe(e) as object,
      },
    });
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
} | null;

type FinalShape = {
  amount?: number | null;
  vendorName?: string | null;
  date?: string | null;
  category?: string | null;
  direction?: string | null;
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

/** Human verdict captured at approve, before ExtractedData is overwritten. */
export async function recordReviewEvent(input: {
  documentId: number;
  businessId: number;
  reviewerUserId: number;
  approvedAs: "financial" | "document";
  explicitFinancial: boolean;
  profileId: string | null;
  belief: BeliefShape;
  final: FinalShape;
}): Promise<void> {
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
  } catch (err) {
    // Never allow a ledger failure to affect the approve flow.
    console.error("[correction-ledger] recordReviewEvent failed:", err);
  }
}
