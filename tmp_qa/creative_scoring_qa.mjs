/**
 * Creative Scoring QA
 * Tests law_firm / beauty_clinic / fashion_store TikTok
 * Validates: trust_safety, identity recognition, cinematic_distinction, reasoning specificity
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
      selectedDirection: {
        title: "Why Our Clients Win",
        tone: "professional",
        strategy: "authority",
      },
    },
    variantIndex: 0,
    checks: [
      { dim: "trust_safety", min: 7.0, label: "trust_safety >= 7 (no identity breach)" },
      { dim: "business_identity_preservation", min: 7.0, label: "identity preserved" },
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
      selectedDirection: {
        title: "Why Our Clients Win",
        tone: "professional",
        strategy: "authority",
      },
    },
    variantIndex: 2,
    checks: [
      { dim: "trust_safety", min: 8.0, label: "trust_safety >= 8 (trust variant + authority brand)" },
      { dim: "cta_alignment", min: 6.0, label: "cta_alignment acceptable" },
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
      selectedDirection: {
        title: "See the Results",
        tone: "energetic",
        strategy: "transformation",
      },
    },
    variantIndex: 0,
    checks: [
      { dim: "cinematic_distinction", min: 5.0, label: "cinematic_distinction >= 5 (urgency modifiers active)" },
      { dim: "hook_strength", min: 6.0, label: "hook_strength >= 6" },
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
      selectedDirection: {
        title: "See the Results",
        tone: "energetic",
        strategy: "transformation",
      },
    },
    variantIndex: 1,
    checks: [
      { dim: "cinematic_distinction", min: 4.0, label: "cinematic_distinction exists (educational modifiers)" },
      { dim: "pacing_fit", min: 5.0, label: "pacing_fit reasonable for explanatory" },
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
      selectedDirection: {
        title: "Drop the New Look",
        tone: "energetic",
        strategy: "product_showcase",
      },
    },
    variantIndex: 0,
    checks: [
      { dim: "platform_fit", min: 7.0, label: "platform_fit >= 7 (TikTok + high energy)" },
      { dim: "trust_safety", min: 6.0, label: "trust_safety not penalized (no authority breach)" },
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
      selectedDirection: {
        title: "Drop the New Look",
        tone: "energetic",
        strategy: "product_showcase",
      },
    },
    variantIndex: 2,
    checks: [
      { dim: "trust_safety", min: 5.0, label: "trust_safety acceptable (fashion trust variant)" },
      { dim: "business_identity_preservation", min: 6.0, label: "no luxury/authority breach for fashion brand" },
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
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
      console.error(`[NO VARIANT] ${c.label}: variantIndex ${c.variantIndex} missing`);
      fail++;
      continue;
    }

    const cs = variant.creativeScore;

    if (!cs) {
      console.error(`[NO SCORE] ${c.label}: creativeScore missing from variant`);
      fail++;
      continue;
    }

    console.log(`\n── ${c.label} ──────────────────────────────────────────`);
    console.log(`  total: ${cs.total}  recommendation: ${cs.recommendation}`);
    console.log(`  dimensions:`);
    for (const [k, v] of Object.entries(cs.dimensions)) {
      console.log(`    ${k.padEnd(35)} ${v}`);
    }
    console.log(`  reasoning: ${cs.reasoning}`);
    if (cs.risks.length > 0) {
      console.log(`  risks (${cs.risks.length}):`);
      cs.risks.forEach(r => console.log(`    ⚠ ${r}`));
    }
    if (cs.strengths.length > 0) {
      console.log(`  strengths (${cs.strengths.length}): ${cs.strengths.slice(0, 2).join(" | ")}`);
    }

    let casePassed = true;
    for (const chk of c.checks) {
      const actual = cs.dimensions[chk.dim];
      const ok = actual >= chk.min;
      console.log(`  CHECK [${ok ? "PASS" : "FAIL"}] ${chk.label} — actual: ${actual}`);
      if (!ok) casePassed = false;
    }

    // Reasoning specificity check
    const isSpecific =
      cs.reasoning.includes("preset") || cs.reasoning.includes("modifier") || cs.reasoning.includes("via");
    console.log(`  CHECK [${isSpecific ? "PASS" : "FAIL"}] reasoning is specific (not generic)`);
    if (!isSpecific) casePassed = false;

    if (casePassed) pass++;
    else fail++;
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`RESULT: ${pass} passed / ${fail} failed`);
  if (fail === 0) console.log("✓ All scoring QA checks passed");
  else console.log("✗ Some checks failed — review output above");
}

runQA().catch(console.error);
