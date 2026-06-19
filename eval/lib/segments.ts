/**
 * Phase 0 (expanded) — pure segmentation helpers for the eval harness.
 *
 * eval-only. These functions reuse production PURE functions (text cleaning,
 * type detection, amount candidate extraction) for read-only MEASUREMENT.
 * They never persist anything and never change a decision.
 *
 * IMPORTANT honesty rule: we do NOT invent document types the engine cannot
 * distinguish. detectDocumentType only emits the 6 coarse classes below; finer
 * Israeli categories (חשבונית מס, חשבונית מס קבלה, זיכוי) are reported as
 * "indistinguishable_at_phase0" rather than guessed.
 */

import { cleanOCRText } from "@/lib/services/documents/text-cleaner.service";
import { detectDocumentType } from "@/lib/services/documents/document-type.service";
import { getAmountCandidates } from "@/lib/services/documents/field-candidates.service";

export const COARSE_DOC_TYPES = [
  "receipt",
  "invoice",
  "donation_receipt",
  "bank_transfer",
  "quote",
  "non_financial",
  "unknown",
] as const;

export type CoarseDocType = (typeof COARSE_DOC_TYPES)[number];

/**
 * Finer categories the user asked about that the engine cannot separate.
 * Reported explicitly as a known limitation, not bucketed.
 */
export const INDISTINGUISHABLE_TYPES = [
  "חשבונית מס (mapped into invoice)",
  "חשבונית מס קבלה (not modeled)",
  "זיכוי / credit note (not modeled)",
];

export type SourceLabel = "upload" | "email" | "whatsapp" | "unknown";

export function sourceLabel(channel: string | null | undefined): SourceLabel {
  const c = String(channel ?? "").toLowerCase().trim();
  if (c === "file") return "upload";
  if (c === "email") return "email";
  if (c === "whatsapp") return "whatsapp";
  return "unknown";
}

export function coarseDocType(ocrText: string): CoarseDocType {
  const cleaned = cleanOCRText(ocrText);
  const detected = detectDocumentType(cleaned).documentType;
  return (COARSE_DOC_TYPES as readonly string[]).includes(detected)
    ? (detected as CoarseDocType)
    : "unknown";
}

// OCR length thresholds (characters of stored ocrText). Frozen for comparability.
export const OCR_SHORT_MAX = 150;
export const OCR_MEDIUM_MAX = 600;

export type OcrQuality = "empty" | "short" | "medium" | "long";

export function ocrQuality(ocrText: string): OcrQuality {
  const len = String(ocrText ?? "").trim().length;
  if (len === 0) return "empty";
  if (len < OCR_SHORT_MAX) return "short";
  if (len < OCR_MEDIUM_MAX) return "medium";
  return "long";
}

/**
 * Count DISTINCT plausible money amounts the production amount path would see.
 * Reuses getAmountCandidates (the same function amount-entity.service uses),
 * then keeps only money-plausible values and dedupes by value.
 */
export function amountCandidateCount(ocrText: string): number {
  const cleaned = cleanOCRText(ocrText);
  const candidates = getAmountCandidates(cleaned);
  const values = new Set<number>();
  for (const c of candidates) {
    if (!Number.isFinite(c.value)) continue;
    if (c.value < 10) continue; // too small to be a document amount
    if (c.value > 1_000_000) continue;
    if (c.value >= 1900 && c.value <= 2099) continue; // year-like
    values.add(Number(c.value.toFixed(2)));
  }
  return values.size;
}

/**
 * Count DISTINCT dates via a transparent local regex (eval approximation).
 * Kept local to avoid coupling to non-exported internals; documented as an
 * approximation of "how many date candidates a human would see".
 */
const HEBREW_MONTHS =
  "ינואר|פברואר|מרץ|מארס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר";

export function dateCandidateCount(ocrText: string): number {
  const text = cleanOCRText(ocrText);
  const seen = new Set<string>();

  const numeric = text.match(
    /\b\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{2,4}\b|\b\d{4}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{1,2}\b/g
  );
  if (numeric) {
    for (const raw of numeric) seen.add(raw.replace(/\s+/g, ""));
  }

  const hebrew = text.match(
    new RegExp(`\\d{1,2}\\s+ב?(?:${HEBREW_MONTHS})\\s+\\d{2,4}`, "g")
  );
  if (hebrew) {
    for (const raw of hebrew) seen.add(raw.replace(/\s+/g, " ").trim());
  }

  return seen.size;
}

export type Complexity = "none" | "single" | "multiple";

export function complexityFromCount(count: number): Complexity {
  if (count <= 0) return "none";
  if (count === 1) return "single";
  return "multiple";
}

/** Keyword flags used only for stratified sampling (which docs to hand a human). */
export function keywordFlags(ocrText: string): string[] {
  const t = String(ocrText ?? "");
  const flags: string[] = [];
  if (t.includes("זיכוי")) flags.push("credit_note_wording");
  if (t.includes("חשבונית מס קבלה")) flags.push("tax_invoice_receipt_wording");
  if (t.includes("חשבונית מס")) flags.push("tax_invoice_wording");
  if (t.includes("הצעת מחיר")) flags.push("quote_wording");
  if (t.includes("העברת כספים")) flags.push("bank_transfer_wording");
  return flags;
}
