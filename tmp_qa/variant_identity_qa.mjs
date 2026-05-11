/**
 * variant_identity_qa.mjs — Variant Cinematic Identity QA
 *
 * Tests that direct / explanatory / trust variants produce meaningfully distinct
 * cinematic identities while remaining faithful to business type.
 *
 * Passes businessType in the request body (top priority in bridge chain).
 * No DB writes needed — runs against live dev server only.
 *
 * Run: node tmp_qa/variant_identity_qa.mjs
 * Requires: dev server on localhost:3000
 */

const BASE_URL = "http://localhost:3000";
const AUTH_TOKEN = "1";

function makeBody(businessType, platform) {
  return {
    mode: "ai",
    goal: "leads",
    contentAngle: "show_result",
    contentGoalPrompt: "אני רוצה יותר לקוחות",
    selectedDirection: {
      id: "trust",
      title: "בניית אמון",
      description: "תוכן שמציג מקצועיות",
      tone: "professional",
      recommendedFormat: "reel",
    },
    selectedFormat: "reel",
    selectedPlatform: platform,
    audienceTypes: ["new"],
    businessType,
  };
}

const TEST_CASES = [
  {
    label: "law_firm (instagram)",
    businessType: "law_firm",
    platform: "instagram",
    expect: {
      direct:      { narration_tone: "authoritative", cta_psychology: "trust", visual_energy: ["calm", "medium"] },
      explanatory: { narration_tone: "authoritative", visual_energy: ["calm", "medium"] },
      trust:       { narration_tone: "authoritative", visual_energy: ["calm"] },
    },
    forbidden: {
      narration_tone: ["urgent"],
      visual_energy: ["high"],
      cta_psychology: ["urgency"],
    },
  },
  {
    label: "beauty_clinic (instagram)",
    businessType: "beauty_clinic",
    platform: "instagram",
    // premium brand → base visual_energy=calm; direct upgrades to medium; narration=authoritative (premium rule)
    expect: {
      direct:      { visual_energy: ["medium", "high"], cta_psychology: ["urgency", "trust", "social_proof"] },
      explanatory: { visual_energy: ["medium", "calm"], cta_psychology: ["curiosity", "trust"] },
      trust:       { visual_energy: ["calm", "medium"], cta_psychology: ["trust", "social_proof"] },
    },
    forbidden: {},
    // Differentiation: direct visual_energy must be higher than trust
    checkEnergyDifferentiation: true,
  },
  {
    label: "fashion_store (tiktok)",
    businessType: "fashion_store",
    platform: "tiktok",
    expect: {
      direct:      { visual_energy: "high", cta_psychology: ["urgency", "social_proof"] },
      explanatory: { visual_energy: ["medium", "calm"] },
    },
    forbidden: {},
    tiktok_trust_no_slow_pacing: true,
  },
];

async function callApi(businessType, platform) {
  const res = await fetch(`${BASE_URL}/api/video/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(makeBody(businessType, platform)),
  });
  return res.json();
}

function fmt(v) { return v ?? "(undefined)"; }

function matchesExpected(actual, expected) {
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

function checkField(label, actual, expected) {
  const ok = matchesExpected(actual, expected);
  const expectedStr = Array.isArray(expected) ? `[${expected.join("|")}]` : expected;
  return { ok, line: `  ${ok ? "✓" : "✗"} ${label}: ${fmt(actual)} ${ok ? "" : `(expected ${expectedStr})`}` };
}

const ENERGY_ORDER = { calm: 0, medium: 1, high: 2 };

function printVariantSummary(style, vb) {
  console.log(`  ── ${style} ──`);
  console.log(`    visual_energy:      ${fmt(vb?.visual_energy)}`);
  console.log(`    visual_strategy:    ${fmt(vb?.visual_strategy)}`);
  console.log(`    narration_tone:     ${fmt(vb?.narration_tone)}`);
  console.log(`    pacing_curve:       ${fmt(vb?.pacing_curve)}`);
  console.log(`    cta_psychology:     ${fmt(vb?.cta_psychology)}`);
  console.log(`    storytelling_model: ${fmt(vb?.storytelling_model)}`);
  console.log(`    attention_strategy: ${fmt(vb?.attention_strategy)}`);
  console.log(`    subtitle_behavior:  ${fmt(vb?.subtitle_behavior)}`);
  if (vb?.renderPreset !== undefined) {
    console.log(`    renderPreset:       ${fmt(vb?.renderPreset)}`);
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("VARIANT CINEMATIC IDENTITY QA");
  console.log("Goal: direct / explanatory / trust → distinct identities, faithful to business type");
  console.log("══════════════════════════════════════════════════════════════\n");

  const caseResults = [];

  for (const tc of TEST_CASES) {
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`CASE: ${tc.label}`);

    let data;
    try {
      data = await callApi(tc.businessType, tc.platform);
    } catch (e) {
      console.log(`  ERROR calling API: ${e.message}`);
      caseResults.push({ label: tc.label, error: true });
      continue;
    }

    if (!data.success) {
      console.log(`  API error: ${JSON.stringify(data)}`);
      caseResults.push({ label: tc.label, error: true });
      continue;
    }

    const variants = data.variants ?? [];
    const styles = ["direct", "explanatory", "trust"];
    const byStyle = {};
    for (const v of variants) {
      const styleMatch = styles.find((s) => v.id?.includes(s));
      if (styleMatch) byStyle[styleMatch] = v;
    }

    const bp = data.businessProfile;
    console.log(`\n  BusinessProfile: marketCategory=${fmt(bp?.marketCategory)} brandPersona=${fmt(bp?.brandPersona)} trustLevel=${fmt(bp?.trustLevel)}`);

    if (data.blueprint) {
      const base = data.blueprint;
      console.log(`  BaseBlueprint:   visual_energy=${fmt(base?.visual_energy)} narration_tone=${fmt(base?.narration_tone)} cta_psychology=${fmt(base?.cta_psychology)} subtitle_behavior=${fmt(base?.subtitle_behavior)}`);
    }

    console.log(`\n  Variant Blueprints:`);
    for (const style of styles) {
      printVariantSummary(style, byStyle[style]?.variantBlueprint);
    }

    const checks = [];

    // At least one meaningful dimension differs between direct and trust
    const directVb = byStyle["direct"]?.variantBlueprint;
    const trustVb = byStyle["trust"]?.variantBlueprint;
    const explanatoryVb = byStyle["explanatory"]?.variantBlueprint;

    const identityDistinct =
      directVb?.visual_energy !== trustVb?.visual_energy ||
      directVb?.narration_tone !== trustVb?.narration_tone ||
      directVb?.pacing_curve !== trustVb?.pacing_curve ||
      directVb?.cta_psychology !== trustVb?.cta_psychology ||
      directVb?.storytelling_model !== trustVb?.storytelling_model ||
      directVb?.attention_strategy !== trustVb?.attention_strategy;

    checks.push({
      ok: identityDistinct,
      line: `  ${identityDistinct ? "✓" : "✗"} direct vs trust: at least one dimension differs`,
    });

    // Per-variant expectation checks
    for (const style of styles) {
      const vb = byStyle[style]?.variantBlueprint;
      if (!vb) {
        checks.push({ ok: false, line: `  ✗ ${style}: variantBlueprint missing` });
        continue;
      }
      const exp = tc.expect?.[style];
      if (exp) {
        for (const [field, expected] of Object.entries(exp)) {
          checks.push(checkField(`${style}.${field}`, vb[field], expected));
        }
      }
    }

    // Forbidden field checks
    if (tc.forbidden) {
      for (const [field, forbidden] of Object.entries(tc.forbidden)) {
        for (const style of styles) {
          const vb = byStyle[style]?.variantBlueprint;
          const val = vb?.[field];
          if (forbidden.includes(val)) {
            checks.push({
              ok: false,
              line: `  ✗ ${style}.${field}: "${val}" is forbidden for this business type`,
            });
          }
        }
      }
    }

    // Energy differentiation: direct should have higher or equal energy vs trust
    if (tc.checkEnergyDifferentiation) {
      const de = ENERGY_ORDER[directVb?.visual_energy] ?? 0;
      const te = ENERGY_ORDER[trustVb?.visual_energy] ?? 0;
      const ok = de >= te;
      checks.push({
        ok,
        line: `  ${ok ? "✓" : "✗"} energy: direct(${directVb?.visual_energy}) ≥ trust(${trustVb?.visual_energy})`,
      });
    }

    // TikTok trust pacing guard
    if (tc.tiktok_trust_no_slow_pacing) {
      const pacing = trustVb?.pacing_curve;
      const ok = pacing !== "slow_then_fast";
      checks.push({
        ok,
        line: `  ${ok ? "✓" : "✗"} trust(TikTok): pacing_curve=${fmt(pacing)} (must not be slow_then_fast)`,
      });
    }

    // Direct subtitle always_on
    checks.push({
      ok: directVb?.subtitle_behavior === "always_on",
      line: `  ${directVb?.subtitle_behavior === "always_on" ? "✓" : "✗"} direct.subtitle_behavior = always_on (got: ${fmt(directVb?.subtitle_behavior)})`,
    });

    const casePass = checks.every((c) => c.ok);
    console.log(`\n  Checks:`);
    for (const c of checks) console.log(c.line);

    caseResults.push({ label: tc.label, pass: casePass, checks });
    console.log();
  }

  console.log("══════════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════════");
  for (const r of caseResults) {
    if (r.error) {
      console.log(`  ✗ ${r.label} — ERROR`);
    } else {
      const failed = r.checks?.filter((c) => !c.ok).length ?? 0;
      console.log(`  ${r.pass ? "✓" : "✗"} ${r.label} — ${r.pass ? "PASS" : `FAIL (${failed} check(s) failed)`}`);
    }
  }

  const allPass = caseResults.filter((r) => !r.error).every((r) => r.pass);
  console.log(`\n  VARIANT IDENTITY QA: ${allPass ? "✓ PASS" : "✗ FAIL"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
