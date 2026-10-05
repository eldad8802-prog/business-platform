/**
 * Setup rules (pure, no database):
 *   npx tsx lib/services/onboarding/setup-model.test.ts
 */
import {
  START_ACTIONS,
  buildSetupView,
  defaultGoalFor,
  isSetupGoal,
  suggestedModelFor,
  validateBusinessAnswer,
  type SetupFacts,
} from "./setup-model";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const base: SetupFacts = {
  onboardingCompletedAt: null,
  onboardingGoal: null,
  onboardingGoalSource: null,
  category: null,
  businessModel: null,
  billingIdentityComplete: false,
  whatsappConnected: false,
  counts: { leads: 0, billingDocuments: 0, documents: 0, contentRuns: 0 },
};
const done = new Date("2026-10-06T10:00:00Z");

// ---- goals and defaults
ok("the four goals are recognised", ["LEADS", "BILLING", "DOCUMENTS", "CONTENT"].every(isSetupGoal));
ok("anything else is not a goal", !isSetupGoal("leads") && !isSetupGoal(null) && !isSetupGoal(1));
ok("a product business defaults to DOCUMENTS", defaultGoalFor("product") === "DOCUMENTS");
ok("services, both, or unknown default to LEADS", ["service", "hybrid", null, undefined].every((m) => defaultGoalFor(m) === "LEADS"));
ok("model suggestion: retail → product, food → hybrid, else service",
  suggestedModelFor("Retail") === "product" && suggestedModelFor("Food") === "hybrid" && suggestedModelFor("Beauty") === "service");

// ---- the business answer is checked against the taxonomy, not trusted
ok("a real category/sub/model is accepted", validateBusinessAnswer({ category: "Beauty", subCategory: "Nails", businessModel: "service" }) !== null);
ok("a sub-category from another category is refused", validateBusinessAnswer({ category: "Beauty", subCategory: "Bakery", businessModel: "service" }) === null);
ok("an unknown category is refused", validateBusinessAnswer({ category: "Crypto", subCategory: "General", businessModel: "service" }) === null);
ok("an unknown model is refused", validateBusinessAnswer({ category: "Other", subCategory: "General", businessModel: "SERVICE" }) === null);
ok("non-strings are refused", validateBusinessAnswer({ category: ["Beauty"], subCategory: "Nails", businessModel: "service" }) === null);

// ---- redirect
ok("not completed → needsSetup", buildSetupView(base).needsSetup === true);
ok("completed → no redirect", buildSetupView({ ...base, onboardingCompletedAt: done }).needsSetup === false);

// ---- provenance: a default is never presented as the owner's choice
{
  const skipped = buildSetupView({ ...base, onboardingCompletedAt: done, onboardingGoal: "LEADS", onboardingGoalSource: "DEFAULTED" });
  ok("a skipped goal stays DEFAULTED", skipped.goalSource === "DEFAULTED");
  const chosen = buildSetupView({ ...base, onboardingCompletedAt: done, onboardingGoal: "CONTENT", onboardingGoalSource: "OWNER_SELECTED" });
  ok("a chosen goal is OWNER_SELECTED", chosen.goal === "CONTENT" && chosen.goalSource === "OWNER_SELECTED");
  const none = buildSetupView({ ...base, onboardingCompletedAt: done, businessModel: "product" });
  ok("no stored goal → derived default, DEFAULTED", none.goal === "DOCUMENTS" && none.goalSource === "DEFAULTED");
  const junk = buildSetupView({ ...base, onboardingCompletedAt: done, onboardingGoal: "NONSENSE", onboardingGoalSource: "OWNER_SELECTED" });
  ok("an unknown stored goal is never trusted as a choice", junk.goal === "LEADS" && junk.goalSource === "DEFAULTED");
}

// ---- first action follows the goal, and knows when it happened
for (const goal of ["LEADS", "BILLING", "DOCUMENTS", "CONTENT"] as const) {
  const v = buildSetupView({ ...base, onboardingCompletedAt: done, onboardingGoal: goal, onboardingGoalSource: "OWNER_SELECTED" });
  ok(`${goal}: the start action is the goal's`, v.startAction.href === START_ACTIONS[goal].href && v.startAction.done === false);
}
ok("LEADS is done once WhatsApp is connected", buildSetupView({ ...base, onboardingGoal: "LEADS", onboardingGoalSource: "OWNER_SELECTED", whatsappConnected: true }).startAction.done);
ok("LEADS is done once a lead exists", buildSetupView({ ...base, onboardingGoal: "LEADS", onboardingGoalSource: "OWNER_SELECTED", counts: { ...base.counts, leads: 1 } }).startAction.done);
ok("BILLING is done once a billing document exists", buildSetupView({ ...base, onboardingGoal: "BILLING", onboardingGoalSource: "OWNER_SELECTED", counts: { ...base.counts, billingDocuments: 1 } }).startAction.done);
ok("BILLING is NOT done by an uploaded document", !buildSetupView({ ...base, onboardingGoal: "BILLING", onboardingGoalSource: "OWNER_SELECTED", counts: { ...base.counts, documents: 1 } }).startAction.done);
ok("DOCUMENTS is done once a document exists", buildSetupView({ ...base, onboardingGoal: "DOCUMENTS", onboardingGoalSource: "OWNER_SELECTED", counts: { ...base.counts, documents: 1 } }).startAction.done);
ok("CONTENT is done once a content run exists", buildSetupView({ ...base, onboardingGoal: "CONTENT", onboardingGoalSource: "OWNER_SELECTED", counts: { ...base.counts, contentRuns: 1 } }).startAction.done);

// ---- checklist: progressive, never repeats the start action, at most three
{
  const v = buildSetupView({ ...base, onboardingCompletedAt: done, onboardingGoal: "CONTENT", onboardingGoalSource: "OWNER_SELECTED" });
  ok("an unanswered business step is offered again", v.checklist.some((i) => i.key === "business" && i.href === "/setup"));
  ok("WhatsApp and billing identity follow", v.checklist.map((i) => i.key).join(",") === "business,whatsapp,billing");
  const leads = buildSetupView({ ...base, onboardingGoal: "LEADS", onboardingGoalSource: "OWNER_SELECTED", category: "Beauty" });
  ok("LEADS does not repeat WhatsApp in the checklist", !leads.checklist.some((i) => i.key === "whatsapp"));
  const billing = buildSetupView({ ...base, onboardingGoal: "BILLING", onboardingGoalSource: "OWNER_SELECTED", category: "Beauty" });
  ok("BILLING does not ask for invoice identity up front", !billing.checklist.some((i) => i.key === "billing"));
  ok("never more than three items", v.checklist.length <= 3);
}

// ---- the card settles when there is nothing left to say
{
  const settled = buildSetupView({
    ...base,
    onboardingCompletedAt: done,
    onboardingGoal: "DOCUMENTS",
    onboardingGoalSource: "OWNER_SELECTED",
    category: "Retail",
    whatsappConnected: true,
    billingIdentityComplete: true,
    counts: { ...base.counts, documents: 1 },
  });
  ok("first action done + empty checklist → settled", settled.settled && settled.checklist.length === 0);
  const notYet = buildSetupView({ ...base, onboardingCompletedAt: done, onboardingGoal: "DOCUMENTS", onboardingGoalSource: "OWNER_SELECTED", category: "Retail", whatsappConnected: true, billingIdentityComplete: true });
  ok("first action pending → not settled", !notYet.settled);
}

if (failed > 0) {
  console.error(`\nsetup-model: ${failed} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`\nsetup-model: PASS (${checks} checks)`);
