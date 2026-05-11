/**
 * cinematic_causality_qa.mjs
 *
 * Captures full variantBlueprint + renderBlueprint diffs for each business × variant.
 * Outputs structured JSON + human-readable diff table for causality analysis.
 *
 * Run: node tmp_qa/cinematic_causality_qa.mjs
 * Requires: dev server on localhost:3000
 */

const BASE_URL = "http://localhost:3000";
const AUTH_TOKEN = "1";

const CASES = [
  { label: "law_firm",       businessType: "law_firm",       platform: "instagram" },
  { label: "beauty_clinic",  businessType: "beauty_clinic",  platform: "instagram" },
  { label: "fashion_store",  businessType: "fashion_store",  platform: "tiktok"    },
];

const BLUEPRINT_FIELDS = [
  "visual_strategy",
  "visual_energy",
  "narration_strategy",
  "narration_tone",
  "soundtrack_strategy",
  "storytelling_model",
  "attention_strategy",
  "interruption_style",
  "pacing_curve",
  "subtitle_behavior",
  "cta_psychology",
];

const RENDER_FIELDS = [
  "preset",
  "subtitle_rhythm",
  "motion_intensity",
  "transition_preset",
  "typography_preset",
  "overlay_density",
  "scene_spacing",
  "intro_behavior",
  "outro_behavior",
  "cinematic_mode",
  "visual_focus",
  "text_behavior",
  "cta_animation_style",
  "pacing_behavior",
  "soundtrack_mood",
  "energy_profile",
];

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

async function callApi(businessType, platform) {
  const res = await fetch(`${BASE_URL}/api/video/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_TOKEN}` },
    body: JSON.stringify(makeBody(businessType, platform)),
  });
  return res.json();
}

function extractFields(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj?.[f] ?? null;
  return out;
}

function diffObjects(base, variant) {
  const changes = {};
  for (const key of Object.keys(base)) {
    if (base[key] !== variant[key]) {
      changes[key] = { from: base[key], to: variant[key] };
    }
  }
  return changes;
}

async function main() {
  const results = [];

  for (const tc of CASES) {
    const data = await callApi(tc.businessType, tc.platform);
    if (!data.success) { console.error(`ERROR: ${tc.label}`, data); continue; }

    const variants = data.variants ?? [];
    const byStyle = {};
    for (const v of variants) {
      const s = ["direct","explanatory","trust"].find(s => v.id?.includes(s));
      if (s) byStyle[s] = v;
    }

    const baseBlueprint = extractFields(data.blueprint, BLUEPRINT_FIELDS);

    const variantData = {};
    for (const style of ["direct","explanatory","trust"]) {
      const vb = byStyle[style]?.variantBlueprint;
      const rb = byStyle[style]?.renderBlueprint;
      variantData[style] = {
        blueprint: extractFields(vb, BLUEPRINT_FIELDS),
        render: extractFields(rb, RENDER_FIELDS),
        blueprintDiff: diffObjects(baseBlueprint, extractFields(vb, BLUEPRINT_FIELDS)),
        renderDiff: diffObjects(
          extractFields(data.renderBlueprint, RENDER_FIELDS),
          extractFields(rb, RENDER_FIELDS)
        ),
      };
    }

    results.push({
      label: tc.label,
      platform: tc.platform,
      businessProfile: {
        marketCategory: data.businessProfile?.marketCategory,
        brandPersona: data.businessProfile?.brandPersona,
        trustLevel: data.businessProfile?.trustLevel,
        emotionalDriver: data.businessProfile?.emotionalDriver,
        contentStyle: data.businessProfile?.contentStyle,
        visualStrength: data.businessProfile?.visualStrength,
      },
      baseBlueprint,
      baseRenderPreset: data.renderBlueprint?.preset,
      variants: variantData,
    });
  }

  // ── Raw output for analysis ──────────────────────────────────────────────────
  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
