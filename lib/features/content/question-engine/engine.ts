import { getArchetypeFamilyOrder } from "./archetype-preferences";
import { getVariantsForFamily } from "./question-bank";
import {
  defaultSelectionSeed,
  pickNextQuestionFamily,
  stablePickIndex,
} from "./selection-rules";
import type {
  ContentQuestionEngineInput,
  ContentQuestionEngineResult,
  QuestionFamilyId,
} from "./types";

function buildWhyThisQuestion(
  family: QuestionFamilyId,
  archetypeId?: string
): string {
  const arch = archetypeId?.trim() || "לא ידוע";
  const familyWhy: Record<QuestionFamilyId, string> = {
    misconception:
      "מכוון לזווית “לשבור תפיסה” בלי לבקש מהמשתמש להגדיר מחדש את העסק.",
    confusion:
      "מחלץ בלבול אמיתי של קהל — חומר טוב להסבר קצר וברור בסרטון.",
    real_moment:
      "מביא רגע אנושי מהשטח — עוזר לטון אמין ולא פרסומי.",
    opinion:
      "מביא עמדה אישית — מתאים לווידאו עם דעה בלי שאלות שיווק כבדות.",
    result:
      "מתמקד בתוצאה נראית/מורגשת — מתאים להוכחה קלה ולא לנאום.",
    mistake:
      "ממקד בטעות נפוצה — נותן מתח עדין ופתרון טבעי.",
    comparison:
      "מזמין השוואה לפני/אחרי — מתאים לבהירות מהירה.",
    story:
      "מזמין סיפור קצר — חומר לזרימה נרטיבית בלי עומס.",
    hesitation:
      "ממקד בהיסוס לפני החלטה — מתאים לסרטון שמוביל לפעולה בלי לחץ גס.",
    hidden_truth:
      "מביא “מה שלא רואים” — עומק בלי להסביר את כל התהליך.",
  };
  return `נבחרה משפחת ${family} בהתאם לארכיטיפ ${arch}. ${familyWhy[family]}`;
}

/**
 * Pure: same input (+ same seed derivation) → same output.
 * Does not read storage, call network, or touch `contentGoalPrompt`.
 */
export function pickNextQuestion(
  input: ContentQuestionEngineInput
): ContentQuestionEngineResult {
  const preferredOrder = getArchetypeFamilyOrder(input.contentArchetypeId);
  const family = pickNextQuestionFamily({
    preferredOrder,
    lastQuestionFamily: input.lastQuestionFamily,
    excludeFamilies: input.excludeFamilies,
  });

  const variants = getVariantsForFamily(family, input.contentArchetypeId);
  const seed =
    input.selectionSeed ??
    defaultSelectionSeed({
      contentArchetypeId: input.contentArchetypeId,
      lastQuestionFamily: input.lastQuestionFamily,
      goal: input.goal,
      contentAngle: input.contentAngle,
    });
  const idx = stablePickIndex(seed, variants.length);
  const v = variants[idx];

  return {
    questionText: v.text,
    questionFamily: family,
    questionVariantId: v.id,
    expectedAnswerType: v.expectedAnswerType,
    suggestedChips: v.chips,
    whyThisQuestion: buildWhyThisQuestion(family, input.contentArchetypeId),
  };
}
