import type {
  ContentQuestionEngineInput,
  ContentQuestionEngineResult,
} from "./types";
import { pickNextQuestion } from "./engine";

/**
 * Frozen examples for docs / snapshots — not executed at runtime.
 * Downstream: `contentInsightAnswers` + `contentGoalPrompt` stay separate.
 */
export const ENGINE_IO_EXAMPLES: ReadonlyArray<{
  label: string;
  input: ContentQuestionEngineInput;
  output: ContentQuestionEngineResult;
}> = [
  {
    label: "stop_scroll — first question",
    input: { contentArchetypeId: "video.stop_scroll", lastQuestionFamily: null },
    output: pickNextQuestion({
      contentArchetypeId: "video.stop_scroll",
      lastQuestionFamily: null,
      selectionSeed: 0,
    }),
  },
  {
    label: "stop_scroll — avoid immediate repeat of misconception",
    input: {
      contentArchetypeId: "video.stop_scroll",
      lastQuestionFamily: "misconception",
      selectionSeed: 0,
    },
    output: pickNextQuestion({
      contentArchetypeId: "video.stop_scroll",
      lastQuestionFamily: "misconception",
      selectionSeed: 0,
    }),
  },
  {
    label: "explain — deterministic variant shift via seed",
    input: {
      contentArchetypeId: "video.explain",
      lastQuestionFamily: null,
      selectionSeed: 2,
    },
    output: pickNextQuestion({
      contentArchetypeId: "video.explain",
      lastQuestionFamily: null,
      selectionSeed: 2,
    }),
  },
];
