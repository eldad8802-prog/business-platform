/**
 * Matching-engine candidate selection (Wave 4 · F-25 · 4B). Run:
 *   npx tsx lib/collaboration/matchingEngine.candidates.test.ts
 *
 * Guards the fail-safe: selection is a pure function of the (server-derived)
 * business identity, and it NEVER fabricates a generic fallback candidate.
 * Unsupported/missing identity → [] so the caller surfaces a "no matches" state.
 */
import { selectCandidates } from "./matchingEngine";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

// --- the two supported rules still work ---
const beauty = selectCandidates("Beauty", "Hair Salon");
ok("Beauty/Hair Salon → 2 candidates", beauty.length === 2, beauty);
ok(
  "Beauty candidates are the cosmetician + nail studio",
  beauty.map((c) => c.partnerType).sort().join(",") === "Cosmetician,Nail Studio",
  beauty.map((c) => c.partnerType)
);

const fitness = selectCandidates("Fitness");
ok("Fitness → 1 candidate (nutritionist)", fitness.length === 1 && fitness[0].partnerType === "Nutritionist", fitness);

// --- NO generic fallback is ever fabricated ---
const emptyCases: Array<[string, ReturnType<typeof selectCandidates>]> = [
  ["Beauty + real onboarding subcat 'Hair' (not 'Hair Salon')", selectCandidates("Beauty", "Hair")],
  ["Beauty + no subCategory", selectCandidates("Beauty")],
  ["Food/Restaurant", selectCandidates("Food", "Restaurant")],
  ["Home Services", selectCandidates("Home Services", "Cleaning")],
  ["Events/Photography", selectCandidates("Events", "Photography")],
  ["null category", selectCandidates(null)],
  ["undefined category", selectCandidates(undefined)],
  ["empty string category", selectCandidates("", "")],
  ["unknown category", selectCandidates("Spaceships")],
];
for (const [name, out] of emptyCases) {
  ok(`${name} → [] (no fabrication)`, out.length === 0, out);
}

// --- the removed generic fallback must never reappear ---
const allProbed = [
  beauty,
  fitness,
  ...emptyCases.map(([, out]) => out),
].flat();
ok(
  "no 'General Partner' / 'שיתוף פעולה כללי' generic candidate anywhere",
  !allProbed.some(
    (c) => c.partnerType === "General Partner" || c.title === "שיתוף פעולה כללי"
  ),
  allProbed.map((c) => c.partnerType)
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll matchingEngine candidate assertions passed");
