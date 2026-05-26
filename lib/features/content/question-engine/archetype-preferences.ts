import type { QuestionFamilyId } from "./types";

/** When archetype is unknown — balanced mix for generic “video” intent. */
export const DEFAULT_VIDEO_FAMILY_ORDER: QuestionFamilyId[] = [
  "hesitation",
  "real_moment",
  "misconception",
  "result",
  "confusion",
  "story",
  "opinion",
  "mistake",
  "comparison",
  "hidden_truth",
];

/** Preference order per video archetype (first = strongest fit for that card). */
const ARCHETYPE_ORDERS: Record<string, QuestionFamilyId[]> = {
  "video.stop_scroll": ["misconception", "mistake", "confusion", "opinion"],
  "video.opinion": ["opinion", "misconception", "hidden_truth", "comparison"],
  "video.creator": ["real_moment", "story", "hesitation", "opinion"],
  "video.trust": ["real_moment", "result", "hesitation", "hidden_truth"],
  "video.explain": ["confusion", "mistake", "result", "comparison"],
  "video.leads": ["hesitation", "result", "mistake", "comparison"],
};

/**
 * Returns an ordered list of candidate families for the archetype.
 * Unknown ids fall back to `DEFAULT_VIDEO_FAMILY_ORDER`.
 */
export function getArchetypeFamilyOrder(
  contentArchetypeId?: string
): QuestionFamilyId[] {
  const id = contentArchetypeId?.trim();
  if (!id) return [...DEFAULT_VIDEO_FAMILY_ORDER];
  const row = ARCHETYPE_ORDERS[id];
  if (row && row.length > 0) return [...row];
  if (id.startsWith("video.")) return [...DEFAULT_VIDEO_FAMILY_ORDER];
  /** post.* / image.* — reuse a softer mix until dedicated tables exist */
  return [...DEFAULT_VIDEO_FAMILY_ORDER];
}
