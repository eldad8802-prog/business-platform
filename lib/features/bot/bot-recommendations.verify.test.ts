/**
 * Recommendations generator (Stage 6). Run with:
 *   npx tsx lib/features/bot/bot-recommendations.verify.test.ts
 */
import assert from "node:assert/strict";
import { generateGoalChangeRecommendations } from "./index";
import { emptyKnowledge } from "./bot-knowledge";

// ── 1. adding a scheduling goal with empty knowledge → rich recommendations ──
{
  const recs = generateGoalChangeRecommendations({
    addedGoalKeys: ["appointment_booking"],
    knowledge: emptyKnowledge(),
  });
  const types = recs.map((r) => r.type);
  assert.ok(types.includes("ADD_KNOWLEDGE_business_hours"));
  assert.ok(types.includes("ENABLE_ACTION_propose_appointment"));
  assert.ok(types.includes("ADD_QUESTION_appointment_date"));
  // every rec carries provenance + reason + payload
  for (const r of recs) {
    assert.ok(r.reason.length > 0);
    assert.equal(r.sourceGoalKey, "appointment_booking");
    assert.ok(typeof r.sourceGoalVersion === "number");
    assert.ok(r.payload && typeof r.payload === "object");
  }
}

// ── 2. knowledge already present → no "add knowledge" rec for it ─────────────
{
  const recs = generateGoalChangeRecommendations({
    addedGoalKeys: ["appointment_booking"],
    knowledge: { hours: "9-5", address: "x", notes: null, faq: [{ question: "q", answer: "a" }] },
  });
  const types = recs.map((r) => r.type);
  assert.ok(!types.includes("ADD_KNOWLEDGE_business_hours"), "hours present → no hours rec");
  // action rec still generated
  assert.ok(types.includes("ENABLE_ACTION_propose_appointment"));
}

// ── 3. dedupe within a batch (two scheduling goals → single hours rec) ───────
{
  const recs = generateGoalChangeRecommendations({
    addedGoalKeys: ["appointment_booking", "appointment_reschedule"],
    knowledge: emptyKnowledge(),
  });
  const hoursRecs = recs.filter((r) => r.type === "ADD_KNOWLEDGE_business_hours");
  assert.equal(hoursRecs.length, 1, "hours rec deduped across goals");
}

// ── 4. a generic/no-op goal change → few or no recs (no noise) ───────────────
{
  const recs = generateGoalChangeRecommendations({
    addedGoalKeys: ["inquiry_screening"],
    knowledge: { hours: "9-5", address: "x", notes: null, faq: [{ question: "q", answer: "a" }] },
  });
  // inquiry_screening adds no recommendable action/knowledge beyond generics
  assert.equal(recs.length, 0);
}

// ── 5. unknown goal keys ignored ─────────────────────────────────────────────
{
  const recs = generateGoalChangeRecommendations({
    addedGoalKeys: ["not_a_goal"],
    knowledge: emptyKnowledge(),
  });
  assert.equal(recs.length, 0);
}

console.log("bot-recommendations.verify: all assertions passed ✓");
