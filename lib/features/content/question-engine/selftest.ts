/**
 * Run from repo root:
 * `npx ts-node --project lib/features/content/question-engine/tsconfig.selftest.json --transpile-only lib/features/content/question-engine/selftest.ts`
 */
import assert from "node:assert/strict";
import { pickNextQuestion } from "./engine";
import { getVariantsForFamily, QUESTION_BANK } from "./question-bank";

function run(): void {
  const a = pickNextQuestion({
    contentArchetypeId: "video.stop_scroll",
    lastQuestionFamily: null,
    selectionSeed: 0,
  });
  assert.equal(a.questionFamily, "misconception");
  assert.ok(a.questionText.length > 10);
  assert.ok(
    a.questionVariantId.includes("misconception"),
    "variant id should reference misconception"
  );

  const b = pickNextQuestion({
    contentArchetypeId: "video.stop_scroll",
    lastQuestionFamily: "misconception",
    selectionSeed: 0,
  });
  assert.notEqual(b.questionFamily, "misconception");

  const c1 = pickNextQuestion({
    contentArchetypeId: "video.explain",
    lastQuestionFamily: null,
    selectionSeed: 0,
  });
  const c2 = pickNextQuestion({
    contentArchetypeId: "video.explain",
    lastQuestionFamily: null,
    selectionSeed: 1,
  });
  assert.notEqual(c1.questionVariantId, c2.questionVariantId);

  for (const family of Object.keys(QUESTION_BANK) as (keyof typeof QUESTION_BANK)[]) {
    assert.ok(
      getVariantsForFamily(family, "video.stop_scroll").length >=
        QUESTION_BANK[family].length,
      `${family} flavored list should be at least as long as core`
    );
    assert.ok(QUESTION_BANK[family].length >= 8, `${family} core should have at least 8 variants`);
  }

  // Stable: same input + seed → same output
  const d1 = pickNextQuestion({
    contentArchetypeId: "video.leads",
    lastQuestionFamily: null,
    selectionSeed: 42,
  });
  const d2 = pickNextQuestion({
    contentArchetypeId: "video.leads",
    lastQuestionFamily: null,
    selectionSeed: 42,
  });
  assert.deepEqual(d1, d2);
}

run();
console.log("question-engine selftest: OK");
