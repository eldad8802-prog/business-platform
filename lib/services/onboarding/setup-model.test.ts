/**
 * Setup rules (pure, no database):
 *   npx tsx lib/services/onboarding/setup-model.test.ts
 */
import { readFileSync } from "node:fs";

import {
  DESCRIPTION_MAX,
  audienceFromCodes,
  buildSetupView,
  codesForAudience,
  isSetupAudience,
  validateAbout,
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

const done = new Date("2026-10-06T08:00:00Z");

// needsSetup is the completion stamp, nothing else.
ok("not completed → needsSetup", buildSetupView({ onboardingCompletedAt: null, description: null, audienceCodes: [] }).needsSetup === true);
ok("completed → no redirect", buildSetupView({ onboardingCompletedAt: done, description: null, audienceCodes: [] }).needsSetup === false);
ok("a blank description reads as not answered", buildSetupView({ onboardingCompletedAt: null, description: "   ", audienceCodes: [] }).description === null);

// Audience ↔ the two identity codes the screen owns.
ok("INDIVIDUALS only", audienceFromCodes(["INDIVIDUALS"]) === "INDIVIDUALS");
ok("BUSINESSES only", audienceFromCodes(["BUSINESSES", "LOCAL_CUSTOMERS"]) === "BUSINESSES");
ok("both codes → BOTH", audienceFromCodes(["BUSINESSES", "INDIVIDUALS"]) === "BOTH");
ok("other audience codes alone → no answer", audienceFromCodes(["LOCAL_CUSTOMERS", "WALK_IN_CUSTOMERS"]) === null);
ok("BOTH writes two codes", JSON.stringify(codesForAudience("BOTH")) === JSON.stringify(["INDIVIDUALS", "BUSINESSES"]));
ok("an unknown audience is refused", !isSetupAudience("FAMILIES") && "error" in validateAbout({ audience: "FAMILIES" }));

// Saving: partial answers, normalisation, limits — and an empty text is never "erase".
{
  const v = validateAbout({ description: "  סטודיו   קטן\n לציפורניים  " });
  ok("description is collapsed and trimmed", !("error" in v) && v.description === "סטודיו קטן לציפורניים");
  const empty = validateAbout({ description: "   " });
  ok("an empty description writes nothing", !("error" in empty) && empty.description === undefined);
  const long = validateAbout({ description: "א".repeat(DESCRIPTION_MAX + 1) });
  ok("over 500 characters is refused", "error" in long && long.error === "description_too_long");
  const onlyAudience = validateAbout({ audience: "BOTH" });
  ok("audience alone is a valid save", !("error" in onlyAudience) && onlyAudience.audience === "BOTH" && onlyAudience.description === undefined);
  ok("a non-string description is refused", "error" in validateAbout({ description: 42 }));
}

// The screen never asks for a category, a goal or a first action again.
{
  const page = readFileSync("app/(shell)/setup/page.tsx", "utf8");
  const model = readFileSync("lib/services/onboarding/setup-model.ts", "utf8");
  const service = readFileSync("lib/services/onboarding/setup.service.ts", "utf8");
  ok("setup page has no category taxonomy", !/BUSINESS_CATEGORY_OPTIONS|business-categories/.test(page));
  ok("setup page has no goal / start step", !/SETUP_GOAL|START_ACTIONS|עם מה תרצה להתחיל/.test(page));
  ok("setup model has no goal or first action", !/onboardingGoal|START_ACTIONS|defaultGoalFor/.test(model));
  ok("setup service never writes a goal", !/onboardingGoal/.test(service.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("answers go through the identity writer as OWNER_INPUT", /createIdentityStatement/.test(service) && /source: "OWNER_INPUT"/.test(service));
}

// The Home no longer carries the setup card.
{
  const desktop = readFileSync("features/home/v3/desktop-home.tsx", "utf8");
  const mobile = readFileSync("features/home/v3/home-v3.tsx", "utf8");
  ok("no SetupCard on desktop", !/SetupCard/.test(desktop));
  ok("no SetupCard on tablet / phone", !/SetupCard/.test(mobile));
}

if (failed > 0) {
  console.error(`\nsetup-model: ${failed} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`\nsetup-model: PASS (${checks} checks)`);
