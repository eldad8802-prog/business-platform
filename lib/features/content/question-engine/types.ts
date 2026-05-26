/**
 * Content Question Engine — types only.
 * Answers are stored separately as `contentInsightAnswers` (not merged into `contentGoalPrompt`).
 */

export type QuestionFamilyId =
  | "misconception"
  | "confusion"
  | "real_moment"
  | "opinion"
  | "result"
  | "mistake"
  | "comparison"
  | "story"
  | "hesitation"
  | "hidden_truth";

export type ExpectedAnswerType = "free_text" | "short_phrase" | "chips_plus_text";

/** One phrasing the UI can show; `chips` are optional quick taps beside free text. */
export type QuestionVariantDefinition = {
  id: string;
  text: string;
  expectedAnswerType: ExpectedAnswerType;
  chips?: string[];
};

/**
 * Pure engine input — no storage, network, or React.
 * Callers pass whatever context they already have; all fields are optional except
 * that without `contentArchetypeId` the engine falls back to a generic video order.
 */
export type ContentQuestionEngineInput = {
  contentArchetypeId?: string;
  /** Goal / angle from flow (optional fine-tuning for future rules). */
  goal?: string;
  contentAngle?: string;
  /** If the last shown question used this family, the engine will not pick it again immediately. */
  lastQuestionFamily?: QuestionFamilyId | null;
  /** Extra families to skip this round (e.g. already covered in session). */
  excludeFamilies?: QuestionFamilyId[];
  /**
   * Deterministic variant index driver. If omitted, derived from `contentArchetypeId`
   * and `lastQuestionFamily` so the same call shape is stable in tests.
   */
  selectionSeed?: number;
};

export type ContentQuestionEngineResult = {
  questionText: string;
  questionFamily: QuestionFamilyId;
  questionVariantId: string;
  expectedAnswerType: ExpectedAnswerType;
  whyThisQuestion: string;
  suggestedChips?: string[];
};

/** Future persistence shape — not written by the engine; documented for wiring. */
export type ContentInsightAnswer = {
  questionFamily: QuestionFamilyId;
  questionVariantId: string;
  text: string;
  chipsUsed?: string[];
  recordedAtIso?: string;
};
