import type { ExtractionConfidenceMeta, ReviewDraft, TrafficLevel } from "./types";
import { formatDateShort } from "./format";
import { hasNonEmptyText, isValidPositiveAmount } from "./validation";

function normalizeConfidenceLabel(raw: string | null | undefined): TrafficLevel {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "high") return "high";
  if (v === "medium") return "medium";
  if (v === "low") return "low";
  return "medium";
}

function scoreToTrafficLevel(score: number | null | undefined): TrafficLevel {
  if (score == null || !Number.isFinite(Number(score))) return "medium";
  const s = Number(score);
  if (s >= 0.85) return "high";
  if (s >= 0.65) return "medium";
  return "low";
}

export function trafficForAmount(
  meta: ExtractionConfidenceMeta | null,
  draft: Pick<ReviewDraft, "amount">
): TrafficLevel {
  if (!isValidPositiveAmount(draft.amount)) return "low";
  if (meta?.amountConfidence) return normalizeConfidenceLabel(meta.amountConfidence);
  return "medium";
}

export function trafficForVendor(
  meta: ExtractionConfidenceMeta | null,
  draft: Pick<ReviewDraft, "vendorName">
): TrafficLevel {
  if (!hasNonEmptyText(draft.vendorName)) return "low";
  if (meta?.vendorConfidence) return normalizeConfidenceLabel(meta.vendorConfidence);
  return "medium";
}

export function trafficForDate(
  meta: ExtractionConfidenceMeta | null,
  draft: Pick<ReviewDraft, "date">
): TrafficLevel {
  if (!draft.date || !formatDateShort(draft.date)) return "low";
  return scoreToTrafficLevel(meta?.confidenceScore);
}

export function trafficForCategory(
  meta: ExtractionConfidenceMeta | null,
  draft: Pick<ReviewDraft, "category">
): TrafficLevel {
  if (!hasNonEmptyText(draft.category)) return "low";
  if (meta?.categoryConfidence) return normalizeConfidenceLabel(meta.categoryConfidence);
  return "medium";
}

export function trafficForDirection(draft: Pick<ReviewDraft, "direction">): TrafficLevel {
  if (draft.direction === "expense" || draft.direction === "income") return "medium";
  return "low";
}

export const TRAFFIC_CONFIG: Record<
  TrafficLevel,
  { dot: string; caption: string; captionColor: string }
> = {
  high: { dot: "#22c55e", caption: "גבוהה", captionColor: "#15803d" },
  medium: { dot: "#eab308", caption: "לבדיקה", captionColor: "#a16207" },
  low: { dot: "#ef4444", caption: "נמוכה", captionColor: "#b91c1c" },
};
