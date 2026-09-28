import type {
  ContentInsightAnswer,
  QuestionFamilyId,
} from "@/lib/features/content/question-engine/types";

const FAMILIES = new Set<QuestionFamilyId>([
  "misconception",
  "confusion",
  "real_moment",
  "opinion",
  "result",
  "mistake",
  "comparison",
  "story",
  "hesitation",
  "hidden_truth",
]);

/**
 * Keep the insight answers the owner already submitted, and drop anything
 * that is not part of that answer. Returns null when the request omitted them.
 */
export function sanitizeContentInsightAnswers(
  value: unknown
): ContentInsightAnswer[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;

  const answers: ContentInsightAnswer[] = [];
  for (const raw of value.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const family = row.questionFamily;
    if (typeof family !== "string" || !FAMILIES.has(family as QuestionFamilyId)) {
      continue;
    }
    const questionVariantId =
      typeof row.questionVariantId === "string"
        ? row.questionVariantId.trim().slice(0, 80)
        : "";
    const text = typeof row.text === "string" ? row.text.trim().slice(0, 1000) : "";
    if (!questionVariantId || !text) continue;

    const chipsUsed = Array.isArray(row.chipsUsed)
      ? row.chipsUsed
          .filter((chip): chip is string => typeof chip === "string")
          .map((chip) => chip.trim().slice(0, 40))
          .filter(Boolean)
          .slice(0, 8)
      : [];

    const recordedAtIso =
      typeof row.recordedAtIso === "string" &&
      !Number.isNaN(Date.parse(row.recordedAtIso))
        ? new Date(row.recordedAtIso).toISOString()
        : undefined;

    answers.push({
      questionFamily: family as QuestionFamilyId,
      questionVariantId,
      text,
      ...(chipsUsed.length > 0 ? { chipsUsed } : {}),
      ...(recordedAtIso ? { recordedAtIso } : {}),
    });
  }

  return answers;
}
