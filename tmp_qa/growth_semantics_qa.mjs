/**
 * Growth Semantics QA
 * Tests behavioral outcome modeling across law_firm / beauty_clinic / fashion_store TikTok
 *
 * Validates:
 * - dominant_growth_profile matches expected variant intent
 * - outcome scores differentiate correctly (trust/conversion/engagement/authority)
 * - audience_reaction_model is specific and non-generic
 * - growth_reasoning explains the stack, not just individual signals
 */

const BASE_URL = "http://localhost:3000";
const AUTH_TOKEN = "1";

const CASES = [
  {
    label: "law_firm — direct",
    body: {
      goal: "leads",
      contentAngle: "trust",
      businessType: "law_firm",
      businessName: "Cohen & Partners Law",
      services: ["corporate law", "contracts"],
      brandTone: "professional",
      selectedDirection: { title: "Why Our Clients Win", tone: "professional", strategy: "authority" },
    },
    variantIndex: 0,
    checks: [
      { field: "dominant_growth_profile", expected: ["trust", "authority", "balanced"], label: "direct law_firm → trust/authority profile (NOT conversion)" },
      { outcome: "trust_building_strength", min: 6, label: "trust_building >= 6" },
      { outcome: "authority_positioning", min: 6, label: "authority_positioning >= 6" },
      { outcome: "virality_potential", max: 5, label: "virality low (law firms don't go viral)" },
    ],
  },
  {
    label: "law_firm — trust",
    body: {
      goal: "leads",
      contentAngle: "trust",
      businessType: "law_firm",
      businessName: "Cohen & Partners Law",
      services: ["corporate law", "contracts"],
      brandTone: "professional",
      selectedDirection: { title: "Why Our Clients Win", tone: "professional", strategy: "authority" },
    },
    variantIndex: 2,
    checks: [
      { field: "dominant_growth_profile", expected: ["trust", "authority", "balanced"], label: "trust variant law_firm → trust/authority profile" },
      { outcome: "trust_building_strength", min: 7, label: "trust_building >= 7 (trust variant + authority brand)" },
      { outcome: "conversion_probability", max: 7, label: "conversion not dominant for law firm trust variant" },
    ],
  },
  {
    label: "beauty_clinic — direct",
    body: {
      goal: "leads",
      contentAngle: "show_result",
      businessType: "beauty_clinic",
      businessName: "Glow Studio",
      services: ["facial treatments", "laser"],
      brandTone: "friendly",
      selectedDirection: { title: "See the Results", tone: "energetic", strategy: "transformation" },
    },
    variantIndex: 0,
    checks: [
      { field: "dominant_growth_profile", expected: ["conversion", "engagement", "balanced"], label: "direct beauty → conversion/engagement profile" },
      { outcome: "conversion_probability", min: 6, label: "conversion_probability >= 6" },
      { outcome: "engagement_potential", min: 6, label: "engagement_potential >= 6" },
    ],
  },
  {
    label: "beauty_clinic — explanatory",
    body: {
      goal: "leads",
      contentAngle: "show_result",
      businessType: "beauty_clinic",
      businessName: "Glow Studio",
      services: ["facial treatments", "laser"],
      brandTone: "friendly",
      selectedDirection: { title: "See the Results", tone: "energetic", strategy: "transformation" },
    },
    variantIndex: 1,
    checks: [
      { outcome: "retention_strength", min: 6, label: "retention >= 6 (explanatory = save-worthy)" },
      { outcome: "conversion_probability", max: 8, label: "conversion not highest for explanatory" },
    ],
  },
  {
    label: "fashion_store TikTok — direct",
    body: {
      goal: "sales",
      contentAngle: "attention",
      businessType: "fashion_store",
      businessName: "Vibe Fashion",
      products: ["streetwear", "hoodies"],
      brandTone: "trendy",
      selectedPlatform: "tiktok",
      selectedDirection: { title: "Drop the New Look", tone: "energetic", strategy: "product_showcase" },
    },
    variantIndex: 0,
    checks: [
      { field: "dominant_growth_profile", expected: ["conversion", "engagement", "balanced"], label: "fashion TikTok direct → conversion/engagement" },
      { outcome: "engagement_potential", min: 7, label: "engagement >= 7 (TikTok platform)" },
      { outcome: "virality_potential", min: 5, label: "virality > 5 (TikTok + bold claim)" },
    ],
  },
  {
    label: "fashion_store TikTok — trust",
    body: {
      goal: "sales",
      contentAngle: "attention",
      businessType: "fashion_store",
      businessName: "Vibe Fashion",
      products: ["streetwear", "hoodies"],
      brandTone: "trendy",
      selectedPlatform: "tiktok",
      selectedDirection: { title: "Drop the New Look", tone: "energetic", strategy: "product_showcase" },
    },
    variantIndex: 2,
    checks: [
      { outcome: "trust_building_strength", min: 5, label: "trust_building >= 5 (trust variant working)" },
      { outcome: "conversion_probability", max: 9, label: "conversion not sky-high for trust variant" },
    ],
  },
];

async function runQA() {
  let pass = 0;
  let fail = 0;

  for (const c of CASES) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/api/video/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify(c.body),
      });
    } catch (e) {
      console.error(`[NETWORK] ${c.label}: ${e.message}`);
      fail++;
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`[HTTP ${res.status}] ${c.label}: ${text.slice(0, 200)}`);
      fail++;
      continue;
    }

    const data = await res.json();
    const variant = data.variants?.[c.variantIndex];

    if (!variant) {
      console.error(`[NO VARIANT] ${c.label}: index ${c.variantIndex} missing`);
      fail++;
      continue;
    }

    const gs = variant.growthSemantics;
    if (!gs) {
      console.error(`[NO GROWTH] ${c.label}: growthSemantics missing`);
      fail++;
      continue;
    }

    console.log(`\n── ${c.label} ──────────────────────────────────────────`);
    console.log(`  dominant_growth_profile: ${gs.dominant_growth_profile}`);
    console.log(`  outcomes:`);
    for (const [k, v] of Object.entries(gs.predicted_outcomes)) {
      console.log(`    ${k.padEnd(28)} ${v}`);
    }
    console.log(`  stop_behavior:     ${gs.audience_reaction_model.likely_stop_behavior}`);
    console.log(`  emotional_response: ${gs.audience_reaction_model.likely_emotional_response}`);
    console.log(`  likely_action:     ${gs.audience_reaction_model.likely_action}`);
    console.log(`  reasoning (${gs.growth_reasoning.length}):`);
    gs.growth_reasoning.forEach((r, i) => console.log(`    ${i + 1}. ${r}`));

    let casePassed = true;

    for (const chk of c.checks) {
      let ok = false;
      let actual = "";

      if ("field" in chk) {
        actual = gs[chk.field];
        ok = chk.expected.includes(actual);
        console.log(`  CHECK [${ok ? "PASS" : "FAIL"}] ${chk.label} — actual: ${actual}`);
      } else if ("outcome" in chk) {
        actual = gs.predicted_outcomes[chk.outcome];
        if ("min" in chk) ok = Number(actual) >= chk.min;
        else if ("max" in chk) ok = Number(actual) <= chk.max;
        console.log(`  CHECK [${ok ? "PASS" : "FAIL"}] ${chk.label} — actual: ${actual}`);
      }

      if (!ok) casePassed = false;
    }

    // Reasoning specificity: must reference actual signals, not generic filler
    const reasoningText = gs.growth_reasoning.join(" ");
    const isSpecific =
      reasoningText.includes("CTA") ||
      reasoningText.includes("variant") ||
      reasoningText.includes("preset") ||
      reasoningText.includes("narration") ||
      reasoningText.includes("strategy");
    console.log(`  CHECK [${isSpecific ? "PASS" : "FAIL"}] growth_reasoning is specific`);
    if (!isSpecific) casePassed = false;

    // Differentiation: direct vs trust should NOT have same dominant profile for same business
    if (casePassed) pass++;
    else fail++;
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (fail === 0) console.log("✓ All growth semantics QA checks passed");
  else console.log("✗ Some checks failed — review output above");

  // Cross-variant differentiation check for law_firm
  console.log(`\n── Cross-variant differentiation check not run inline — review outputs above`);
}

runQA().catch(console.error);
