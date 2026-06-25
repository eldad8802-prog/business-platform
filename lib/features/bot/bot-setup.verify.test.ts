/**
 * Setup Wizard foundation (Stage 3). Run with:
 *   npx tsx lib/features/bot/bot-setup.verify.test.ts
 *
 * Covers: assemble produces a frozen snapshot (not a live reference) with
 * provenance, determinism, validators for selectedGoalKeys/currentStep/status,
 * and unknown-key rejection.
 */
import assert from "node:assert/strict";
import {
  assembleBase,
  materializeSettingsFromBase,
  validateAssembledBase,
  validateSetupPatch,
  coerceSelectedGoalKeys,
  SETUP_MAX_STEP,
  GOAL_CATALOG_VERSION,
} from "./index";

// ── 1. assemble → snapshot with provenance ───────────────────────────────────
{
  const at = "2026-06-24T00:00:00.000Z";
  const base = assembleBase(["appointment_booking", "faq"], at);

  assert.equal(base.assembledAt, at);
  assert.equal(base.catalogVersion, GOAL_CATALOG_VERSION);
  // sources carry goalKey + goalVersion (frozen, not a live ref)
  assert.deepEqual(base.sources, [
    { goalKey: "appointment_booking", goalVersion: GOAL_CATALOG_VERSION },
    { goalKey: "faq", goalVersion: GOAL_CATALOG_VERSION },
  ]);

  // questions resolved from Field Catalog, with per-item provenance
  const name = base.questions.find((q) => q.fieldKey === "party_name");
  assert.ok(name, "expected party_name question");
  assert.equal(name!.question, "מה השם שלך?");
  // party_name comes from GENERIC → contributed by BOTH goals
  assert.deepEqual(name!.fromGoals.sort(), ["appointment_booking", "faq"]);

  const apptDate = base.questions.find((q) => q.fieldKey === "appointment_date");
  assert.ok(apptDate, "expected appointment_date from appointment_booking");
  assert.deepEqual(apptDate!.fromGoals, ["appointment_booking"]);

  // recommended actions / knowledge / handoff present with labels
  assert.ok(base.actions.some((a) => a.key === "propose_appointment"));
  assert.ok(base.knowledgeToComplete.some((k) => k.key === "business_hours"));
  assert.ok(base.handoff.some((h) => h.key === "price_question"));
  // every item carries provenance
  for (const item of [...base.actions, ...base.knowledgeToComplete, ...base.handoff]) {
    assert.ok(item.fromGoals.length > 0, `${item.key} missing provenance`);
    assert.ok(item.label.length > 0, `${item.key} missing label`);
  }
}

// ── 2. snapshot is a COPY, not a reference (determinism + isolation) ──────────
{
  const a = assembleBase(["faq"], "2026-06-24T00:00:00.000Z");
  const b = assembleBase(["faq"], "2026-06-24T00:00:00.000Z");
  assert.deepEqual(a, b, "assemble must be deterministic");
  // mutating the snapshot does not affect a fresh assembly (no shared refs)
  a.questions.push({ fieldKey: "x", label: "x", question: "x", fromGoals: [] });
  const c = assembleBase(["faq"], "2026-06-24T00:00:00.000Z");
  assert.notEqual(a.questions.length, c.questions.length);
}

// ── 3. unknown goal keys ignored defensively in assemble ─────────────────────
{
  const base = assembleBase(["faq", "totally_made_up"]);
  assert.deepEqual(base.sources.map((s) => s.goalKey), ["faq"]);
}

// ── 4. validateSetupPatch ────────────────────────────────────────────────────
{
  const r = validateSetupPatch({ selectedGoalKeys: ["faq", "faq", "reminders"], currentStep: 2, status: "REVIEW_READY" });
  assert.ok(r.ok);
  assert.deepEqual(r.value.selectedGoalKeys, ["faq", "reminders"]); // deduped
  assert.equal(r.value.currentStep, 2);
  assert.equal(r.value.status, "REVIEW_READY");
}
{
  assert.equal(validateSetupPatch({ selectedGoalKeys: ["nope"] }).ok, false); // unknown rejected
  assert.equal(validateSetupPatch({ currentStep: -1 }).ok, false);
  assert.equal(validateSetupPatch({ currentStep: SETUP_MAX_STEP + 1 }).ok, false);
  assert.equal(validateSetupPatch({ status: "ACTIVATED" }).ok, false); // not allowed
  assert.equal(validateSetupPatch({}).ok, false); // nothing to update
  assert.equal(validateSetupPatch(null).ok, false);
}

// ── 5. coerceSelectedGoalKeys (read-side) ────────────────────────────────────
assert.deepEqual(coerceSelectedGoalKeys(["faq", "bad", "reminders"]), ["faq", "reminders"]);
assert.deepEqual(coerceSelectedGoalKeys(null), []);

// ── 6. snapshot carries welcome + finalAction; materialize is a COPY ─────────
{
  const base = assembleBase(["appointment_booking"], "2026-06-24T00:00:00.000Z");
  assert.ok(base.welcome.length > 0);
  assert.equal(base.finalAction, "COLLECT_DETAILS"); // collecting action present
  const faqOnly = assembleBase(["faq"]);
  // faq still collects details via GENERIC → COLLECT_DETAILS (deterministic)
  assert.ok(["COLLECT_DETAILS", "LEAVE_MESSAGE"].includes(faqOnly.finalAction));

  const mat = materializeSettingsFromBase(base);
  assert.equal(mat.welcomeMessage, base.welcome);
  assert.deepEqual(mat.questions.items, base.questions.map((q) => q.question));
  assert.equal(mat.finalAction, base.finalAction);
  // items is a fresh array (copy), not the questions array itself
  mat.questions.items.push("x");
  assert.notEqual(mat.questions.items.length, base.questions.length);
}

// ── 7. validateAssembledBase rejects junk, accepts a real snapshot ───────────
{
  const good = assembleBase(["faq"]);
  assert.ok(validateAssembledBase(good));
  assert.equal(validateAssembledBase(null), null);
  assert.equal(validateAssembledBase({ welcome: "", finalAction: "COLLECT_DETAILS", questions: [], sources: [] }), null);
  assert.equal(validateAssembledBase({ welcome: "hi", finalAction: "NOPE", questions: [], sources: [] }), null);
  assert.equal(validateAssembledBase({ welcome: "hi", finalAction: "LEAVE_MESSAGE", questions: "x", sources: [] }), null);
}

console.log("bot-setup.verify: all assertions passed ✓");
