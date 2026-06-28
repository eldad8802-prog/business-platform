/**
 * Learning Suggestions constants (Stage 8). Run with:
 *   npx tsx lib/features/bot/bot-learning.verify.test.ts
 */
import assert from "node:assert/strict";
import {
  LEARNING_STATUSES,
  LEARNING_TYPES,
  LEARNING_TYPE_LABELS,
  isLearningType,
  isLearningStatus,
} from "./index";

assert.deepEqual([...LEARNING_STATUSES], ["PROPOSED", "ADOPTED", "DISMISSED"]);
assert.equal(LEARNING_TYPES.length, 5);
for (const t of LEARNING_TYPES) {
  assert.ok(LEARNING_TYPE_LABELS[t], `missing label for ${t}`);
  assert.ok(isLearningType(t));
}
assert.equal(isLearningType("nope"), false);
assert.ok(isLearningStatus("ADOPTED"));
assert.equal(isLearningStatus("WHATEVER"), false);

console.log("bot-learning.verify: all assertions passed ✓");
