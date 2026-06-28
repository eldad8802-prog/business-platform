/**
 * Learning Suggestions (Stage 8) — PROPOSALS ONLY, pure types/constants.
 *
 * The bot never changes itself. Each suggestion stays PROPOSED until the owner
 * adopts or dismisses it — and even ADOPTED changes nothing about the bot's
 * runtime in this stage (status flip only). NOT read by the planner/pipeline.
 */

export const LEARNING_STATUSES = ["PROPOSED", "ADOPTED", "DISMISSED"] as const;
export type LearningStatus = (typeof LEARNING_STATUSES)[number];

export const LEARNING_TYPES = [
  "wording_preference",
  "handoff_pattern",
  "fast_approval_pattern",
  "knowledge_gap",
  "goal_improvement",
] as const;
export type LearningType = (typeof LEARNING_TYPES)[number];

export function isLearningType(x: unknown): x is LearningType {
  return typeof x === "string" && (LEARNING_TYPES as readonly string[]).includes(x);
}

export function isLearningStatus(x: unknown): x is LearningStatus {
  return typeof x === "string" && (LEARNING_STATUSES as readonly string[]).includes(x);
}

/** UI labels per type (single source). */
export const LEARNING_TYPE_LABELS: Record<LearningType, string> = {
  wording_preference: "העדפת ניסוח",
  handoff_pattern: "דפוס העברה",
  fast_approval_pattern: "דפוס אישור מהיר",
  knowledge_gap: "פער ידע",
  goal_improvement: "שיפור מטרה",
};
