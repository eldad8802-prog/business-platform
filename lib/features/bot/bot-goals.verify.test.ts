/**
 * Goal Library (Stage 2). Run with:
 *   npx tsx lib/features/bot/bot-goals.verify.test.ts
 *
 * Covers: catalog integrity, key lookups, multi-select validation, unknown
 * rejection, duplicate cleaning, and array shape errors.
 */
import assert from "node:assert/strict";
import {
  GOAL_CATALOG,
  GOAL_CATEGORY_KEYS,
  GOAL_CATALOG_VERSION,
  isGoalKey,
  listGoalKeys,
  getGoalDef,
  assertGoalCatalogIntegrity,
  validateGoalSelection,
} from "./index";

// ── 1. catalog shape + integrity ─────────────────────────────────────────────
assertGoalCatalogIntegrity();
assert.equal(GOAL_CATALOG.length, GOAL_CATEGORY_KEYS.length);
assert.equal(GOAL_CATALOG_VERSION, 1);
for (const cat of GOAL_CATALOG) {
  assert.ok(GOAL_CATEGORY_KEYS.includes(cat.key), `bad category ${cat.key}`);
  assert.ok(cat.goals.length > 0, `empty category ${cat.key}`);
}
// representative keys present
assert.ok(isGoalKey("appointment_booking"));
assert.ok(isGoalKey("lead_capture"));
assert.equal(isGoalKey("not_a_goal"), false);
assert.equal(getGoalDef("appointment_booking")?.label, "קביעת תורים");
assert.ok(listGoalKeys().length >= 20);

// ── 2. multi-select: several goals accepted, order preserved ─────────────────
{
  const r = validateGoalSelection({ goals: ["faq", "meeting_scheduling", "appointment_booking"] });
  assert.ok(r.ok);
  assert.deepEqual(r.value, ["faq", "meeting_scheduling", "appointment_booking"]);
}

// ── 3. unknown goals are REJECTED (hard error) ───────────────────────────────
{
  const r = validateGoalSelection({ goals: ["faq", "totally_made_up"] });
  assert.equal(r.ok, false);
}

// ── 4. duplicates are CLEANED (deduped, ok) ──────────────────────────────────
{
  const r = validateGoalSelection({ goals: ["faq", "faq", "reminders", "faq"] });
  assert.ok(r.ok);
  assert.deepEqual(r.value, ["faq", "reminders"]);
}

// ── 5. shape errors ──────────────────────────────────────────────────────────
{
  assert.equal(validateGoalSelection({ goals: "faq" }).ok, false); // not an array
  assert.equal(validateGoalSelection({ goals: [123] }).ok, false); // non-string
  // accepts a bare array too (not only {goals})
  const bare = validateGoalSelection(["faq"]);
  assert.ok(bare.ok);
  assert.deepEqual(bare.value, ["faq"]);
  // empty selection is valid (clears goals)
  const empty = validateGoalSelection({ goals: [] });
  assert.ok(empty.ok);
  assert.deepEqual(empty.value, []);
}

console.log("bot-goals.verify: all assertions passed ✓");
